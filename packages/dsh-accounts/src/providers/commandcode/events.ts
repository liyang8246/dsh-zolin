import type { FinishReason, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { CommandCodeEvent } from './protocol.js'
import { Buffer } from 'node:buffer'
import { CommandCodeError, maxLineBytes, number, object, string } from './protocol.js'

/** The native gateway is NDJSON. SSE data: lines are accepted for transparent proxies. */
export async function* parseCommandCodeEvents(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<CommandCodeEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let pending = ''
  const abort = (): void => {
    void reader.cancel(signal?.reason).catch(() => {})
  }
  signal?.addEventListener('abort', abort, { once: true })
  function parse(line: string): CommandCodeEvent | undefined {
    if (Buffer.byteLength(line, 'utf8') > maxLineBytes)
      throw new CommandCodeError('CommandCode stream line exceeded its size limit', 'INVALID_RESPONSE')
    line = line.trim()
    if (!line || line.startsWith(':') || line.startsWith('event:') || line === '[DONE]')
      return undefined
    if (line.startsWith('data:'))
      line = line.slice(5).trim()
    if (!line || line === '[DONE]')
      return undefined
    let event: unknown
    try {
      event = JSON.parse(line)
    }
    catch { throw new CommandCodeError('Malformed CommandCode stream JSON', 'INVALID_RESPONSE') }
    const result = object(event)
    const type = string(result?.type)
    if (!result || !type)
      throw new CommandCodeError('Invalid CommandCode stream event', 'INVALID_RESPONSE')
    return { ...result, type }
  }
  try {
    while (true) {
      signal?.throwIfAborted()
      const { done, value } = await reader.read()
      signal?.throwIfAborted()
      pending += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true })
      for (let newline = pending.indexOf('\n'); newline !== -1; newline = pending.indexOf('\n')) {
        signal?.throwIfAborted()
        const event = parse(pending.slice(0, newline))
        pending = pending.slice(newline + 1)
        if (event)
          yield event
      }
      if (Buffer.byteLength(pending, 'utf8') > maxLineBytes)
        throw new CommandCodeError('CommandCode stream line exceeded its size limit', 'INVALID_RESPONSE')
      if (done) {
        const event = parse(pending)
        if (event)
          yield event
        return
      }
    }
  }
  finally {
    signal?.removeEventListener('abort', abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export function tokenUsage(value: unknown): TokenUsage | undefined {
  const usage = object(value)
  if (!usage)
    return undefined
  const input = number(usage.inputTokens ?? usage.prompt_tokens)
  const output = number(usage.outputTokens ?? usage.completion_tokens)
  if (input === undefined || output === undefined)
    return undefined
  const inputDetails = object(usage.inputTokenDetails ?? usage.input_token_details)
  const outputDetails = object(usage.outputTokenDetails ?? usage.output_token_details)
  const cacheRead = number(inputDetails?.cacheReadTokens)
  const cacheWrite = number(inputDetails?.cacheWriteTokens)
  const cached = (cacheRead ?? 0) + (cacheWrite ?? 0)
  const noCache = number(inputDetails?.noCacheTokens)
  const reasoning = number(outputDetails?.reasoningTokens)
  if (noCache === undefined && cached > input)
    throw new CommandCodeError('Inconsistent CommandCode token usage', 'INVALID_RESPONSE')
  const total = number(usage.totalTokens ?? usage.total_tokens)
  const consistent = (noCache === undefined || noCache + cached === input) && (total === undefined || total === input + output)
  return {
    inputTokens: noCache ?? input - cached,
    outputTokens: output,
    ...(consistent
      ? { totalTokens: total ?? input + output }
      : {}),
    ...(cacheRead === undefined
      ? {}
      : { cacheReadTokens: cacheRead }),
    ...(cacheWrite === undefined
      ? {}
      : { cacheWriteTokens: cacheWrite }),
    ...(reasoning === undefined
      ? {}
      : { reasoningTokens: reasoning }),
  }
}

export function finishReason(value: unknown, hasTools: boolean): FinishReason {
  const reason = string(value) ?? string(object(value)?.unified)
  if (reason && /^(?:length|max[_-]tokens|max_output_tokens|model_context_window_exceeded)$/.test(reason))
    return { kind: 'max-tokens' }
  if (reason && /^(?:error|unknown|content[_-]filter|refusal|pause_turn)$/.test(reason))
    throw new CommandCodeError(`CommandCode ended with unsupported completion reason ${reason}`, 'PROVIDER_ERROR')
  if (hasTools || (reason && /^(?:tool[_-]calls|tool_use)$/.test(reason)))
    return { kind: 'tool-calls' }
  return { kind: 'stop' }
}
