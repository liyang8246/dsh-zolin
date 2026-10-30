import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk, TokenUsage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { CatalogModel, StoredAccount } from '../../shared/types.js'
import type { CommandCodeOpenBlock } from './protocol.js'
import { finishReason, parseCommandCodeEvents, tokenUsage } from './events.js'
import { headers, keyOf, operation, origin, responseError, upstreamError } from './http.js'
import { CommandCodeError, number, object, string } from './protocol.js'
import { buildCommandCodeRequest } from './request.js'

/*!
 * Command Code CLI gateway adapter. Protocol verified against command-code@1.88.2:
 * https://unpkg.com/command-code@1.88.2/dist/cli.mjs
 * Independent implementation; wire-shape reference also provided by
 * https://github.com/jiesou/dsh-commandcode-go-provider (MIT).
 *
 * MIT License — Copyright (c) 2026 jiesou
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

export async function* streamCommandCode(ctx: Context, options: GenerateOptions, account: StoredAccount, model: CatalogModel): AsyncIterable<StreamChunk> {
  const key = keyOf(account)
  const messages = options.messages.some(message => message.content.some(block => block.type === 'file'))
    ? options.messages.map(message => ({
        ...message,
        content: message.content.map(block => block.type === 'file'
          ? {
              type: 'text' as const,
              text: ctx.llm.fileRequestText(block.attachment),
            }
          : block),
      }))
    : options.messages
  const body = buildCommandCodeRequest({ ...options, messages }, model)
  const request = operation(options.signal, 300_000)
  const open = new Map<string, CommandCodeOpenBlock>()
  const completedTools = new Set<string>()
  let index = 0
  let usage: TokenUsage | undefined
  let completeStepUsage = true
  let lastReason: unknown
  let hasTools = false
  const locate = (kind: CommandCodeOpenBlock['kind'], id: unknown) => {
    const exact = string(id)
    return exact
      ? open.get(`${kind}:${exact}`)
      : [
          ...open.values(),
        ].reverse().find(block => block.kind === kind)
  }
  const close = (block: CommandCodeOpenBlock): StreamChunk => {
    open.delete(`${block.kind}:${block.id}`)
    if (block.kind === 'tool-call') {
      if (!block.name)
        throw new CommandCodeError('CommandCode tool call is missing its name', 'INVALID_RESPONSE')
      try {
        JSON.parse(block.text)
      }
      catch { throw new CommandCodeError('CommandCode tool arguments are incomplete JSON', 'INVALID_RESPONSE') }
      completedTools.add(block.id)
      hasTools = true
      return {
        type: 'block-end',
        index: block.index,
        block: {
          type: 'tool-call',
          id: block.id as ToolCallId,
          name: block.name,
          arguments: block.text,
        },
      }
    }
    return {
      type: 'block-end',
      index: block.index,
      block: { type: block.kind, text: block.text },
    }
  }
  try {
    request.signal.throwIfAborted()
    const response = await fetch(`${origin}/alpha/generate`, {
      method: 'POST',
      headers: headers(key),
      body: JSON.stringify(body),
      signal: request.signal,
      redirect: 'error',
    })
    if (!response.ok)
      throw await responseError(response, key, request.signal)
    if (!response.body)
      throw new CommandCodeError('CommandCode returned no response stream', 'INVALID_RESPONSE')
    for await (const event of parseCommandCodeEvents(response.body, request.signal)) {
      request.signal.throwIfAborted()
      const type = event.type
      if (type === 'abort')
        throw new CommandCodeError('CommandCode aborted the response', 'ABORTED')
      if (type === 'tool-result')
        throw new CommandCodeError('Unexpected provider-executed CommandCode tool result', 'INVALID_RESPONSE')
      if (type === 'error')
        throw upstreamError(event, key, number(object(event.error)?.statusCode ?? event.statusCode))
      if (type === 'finish-step') {
        const next = tokenUsage(event.usage)
        if (!next)
          completeStepUsage = false
        if (next) {
          if (!usage) {
            usage = next
          }
          else {
            const previous = usage
            usage = { inputTokens: previous.inputTokens + next.inputTokens, outputTokens: previous.outputTokens + next.outputTokens }
            for (const field of [
              'totalTokens',
              'cacheReadTokens',
              'cacheWriteTokens',
              'reasoningTokens',
            ] as const) {
              if (previous[field] !== undefined && next[field] !== undefined)
                usage[field] = previous[field] + next[field]
            }
          }
        }
        lastReason = event.rawFinishReason ?? event.finishReason
        continue
      }
      if (type === 'finish') {
        usage = tokenUsage(event.totalUsage ?? event.usage) ?? (completeStepUsage ? usage : undefined)
        for (const block of [
          ...open.values(),
        ]) {
          request.signal.throwIfAborted()
          yield close(block)
        }
        const reason = finishReason(event.rawFinishReason ?? event.finishReason ?? lastReason, hasTools)
        request.signal.throwIfAborted()
        if (usage)
          yield { type: 'usage', usage }
        request.signal.throwIfAborted()
        yield { type: 'finish', reason }
        return
      }
      const textual = /^(text|reasoning)-(start|delta|end)$/.exec(type)
      if (textual) {
        const kind = textual[1] as 'text' | 'reasoning'
        const action = textual[2]
        let block = locate(kind, event.id)
        if (action === 'start' || (action === 'delta' && !block)) {
          if (block)
            throw new CommandCodeError('Duplicate CommandCode block start', 'INVALID_RESPONSE')
          const id = string(event.id) ?? `block-${index}`
          block = { index: index++, id, kind, text: '' }
          open.set(`${kind}:${id}`, block)
          yield { type: 'block-start', index: block.index, blockType: kind }
        }
        if (!block)
          throw new CommandCodeError('CommandCode closed an unknown block', 'INVALID_RESPONSE')
        if (action === 'end')
          yield close(block)
        if (action === 'delta') {
          const text = event.text ?? event.delta
          if (typeof text !== 'string')
            throw new CommandCodeError('Invalid CommandCode text delta', 'INVALID_RESPONSE')
          block.text += text
          yield {
            type: kind === 'text'
              ? 'text-delta'
              : 'reasoning-delta',
            index: block.index,
            text,
          }
        }
        continue
      }
      if (type === 'tool-input-start' || type === 'tool-input-delta' || type === 'tool-input-end' || type === 'tool-call') {
        if (event.providerExecuted === true)
          throw new CommandCodeError('Unexpected provider-executed CommandCode tool', 'INVALID_RESPONSE')
        const id = string(event.toolCallId ?? event.id)
        if (!id)
          throw new CommandCodeError('CommandCode tool event is missing its id', 'INVALID_RESPONSE')
        if (completedTools.has(id))
          continue
        let block = locate('tool-call', id)
        if (!block) {
          block = {
            index: index++,
            id,
            kind: 'tool-call',
            text: '',
            name: string(event.toolName),
          }
          open.set(`tool-call:${id}`, block)
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        }
        block.name = string(event.toolName) ?? block.name
        if (type === 'tool-input-delta') {
          if (typeof event.delta !== 'string')
            throw new CommandCodeError('Invalid CommandCode tool input delta', 'INVALID_RESPONSE')
          block.text += event.delta
          yield {
            type: 'tool-call-delta',
            index: block.index,
            id: id as ToolCallId,
            name: block.name,
            argumentsDelta: event.delta,
          }
        }
        if (type === 'tool-call') {
          const input = event.input ?? event.args ?? event.arguments
          if (input === undefined)
            throw new CommandCodeError('CommandCode tool call is missing its input', 'INVALID_RESPONSE')
          const args = typeof input === 'string'
            ? input
            : JSON.stringify(input)
          if (!block.text) {
            yield {
              type: 'tool-call-delta',
              index: block.index,
              id: id as ToolCallId,
              name: block.name,
              argumentsDelta: args,
            }
          }
          block.text = args
          yield close(block)
        }
      }
    }
    throw new CommandCodeError('CommandCode stream ended before its finish event', 'STREAM_CLOSED')
  }
  catch (error) {
    if (options.signal?.aborted)
      throw options.signal.reason
    if (request.signal.aborted)
      throw new CommandCodeError('CommandCode request timed out', 'TIMEOUT')
    if (error instanceof CommandCodeError)
      throw error
    throw new CommandCodeError('CommandCode connection failed or the response stream was interrupted', 'NETWORK')
  }
  finally {
    request.dispose()
  }
}
