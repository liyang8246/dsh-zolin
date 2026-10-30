import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock, FinishReason, GenerateOptions, StreamChunk, TokenUsage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { CommandCodeAssistantPart, CommandCodeEvent, CommandCodeMessage, CommandCodeOpenBlock } from './protocol-types.js'
import type { CatalogModel, QuotaView, QuotaWindow, StoredAccount } from './types.js'
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
import { Buffer } from 'node:buffer'
import { arch, platform } from 'node:os'

const origin = 'https://api.commandcode.ai'
const version = '1.88.2'
const maxLineBytes = 2 * 1024 * 1024

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0
    ? value
    : undefined
}
function number(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim()))
    return undefined
  const result = Number(value)
  return Number.isFinite(result) && result >= 0
    ? result
    : undefined
}

export class CommandCodeError extends Error {
  readonly code: string
  readonly status?: number
  readonly providerRetryAfterMs?: number
  constructor(message: string, code: string, status?: number, providerRetryAfterMs?: number) {
    super(message)
    this.name = 'CommandCodeError'
    this.code = code
    this.status = status
    this.providerRetryAfterMs = providerRetryAfterMs
  }
}

function keyOf(account: StoredAccount): string {
  if (account.channel !== 'commandcode-go' || account.credential.kind !== 'api-key') {
    throw new CommandCodeError('CommandCode Go requires an API-key account', 'AUTH')
  }
  const key = account.credential.key
  if (!key.trim() || /[\r\n\0]/u.test(key))
    throw new CommandCodeError('Invalid stored CommandCode credential', 'AUTH')
  return key
}

function headers(key: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
    'User-Agent': 'dsh-zephyr/0.2.0',
    'x-command-code-version': version,
    'x-cli-environment': 'production',
  }
}

function classify(message: string, status?: number): string {
  if (/MODEL_NOT_IN_PLAN|upgrade_required/i.test(message))
    return 'PERMISSION'
  if (/PREMIUM_CREDITS_EXHAUSTED|insufficient.*credit|out of credit|usage (?:window|limit)|window_limit|weekly limit/i.test(message))
    return 'QUOTA_EXCEEDED'
  if (/context.*(?:length|window)|prompt is too long/i.test(message))
    return 'CONTEXT_WINDOW_EXCEEDED'
  if (status === 429 || /RATE_LIMITED|too many requests/i.test(message))
    return 'RATE_LIMIT'
  if (status === 401 || status === 403 || /not authenticated|unauthor|invalid api key|session expired/i.test(message))
    return 'AUTH'
  if (status === 400)
    return 'INVALID_REQUEST'
  return status && status >= 500
    ? 'SERVER'
    : 'PROVIDER_ERROR'
}

function upstreamError(value: unknown, key: string, status?: number, retryAfterMs?: number): CommandCodeError {
  const root = object(value)
  const nested = object(root?.error)
  const detail = string(nested?.message) ?? string(root?.message) ?? string(root?.error) ?? string(value) ?? 'CommandCode request failed'
  const code = string(nested?.code) ?? string(root?.code)
  const message = `${code
    ? `${code}: `
    : ''}${detail}`.replaceAll(key, '[redacted]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 2048)
  return new CommandCodeError(message, classify(message, status), status, retryAfterMs)
}

function operation(signal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException('CommandCode request timed out', 'TimeoutError')), timeoutMs)
  timer.unref()
  return {
    signal: signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal,
    dispose: () => {
      clearTimeout(timer)
      controller.abort()
    },
  }
}

async function responseError(response: Response, key: string, signal?: AbortSignal): Promise<CommandCodeError> {
  const raw = await readBody(response, 64 * 1024, signal)
  let value: unknown = raw
  try {
    value = JSON.parse(raw)
  }
  catch { /* A proxy can return plain text. */ }
  const retry = response.headers.get('retry-after')
  const retryAfterMs = retry
    ? (/^\d+(?:\.\d+)?$/.test(retry)
        ? Number(retry) * 1000
        : Date.parse(retry) - Date.now())
    : undefined
  return upstreamError(value, key, response.status, retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
    ? retryAfterMs
    : undefined)
}

async function readBody(response: Response, limit: number, signal?: AbortSignal): Promise<string> {
  if (!response.body)
    return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const abort = (): void => {
    void reader.cancel(signal?.reason).catch(() => {})
  }
  signal?.addEventListener('abort', abort, { once: true })
  let result = ''
  let size = 0
  try {
    while (true) {
      signal?.throwIfAborted()
      const { done, value } = await reader.read()
      signal?.throwIfAborted()
      if (done)
        break
      size += value.byteLength
      if (size > limit)
        throw new CommandCodeError('CommandCode response exceeded its size limit', 'INVALID_RESPONSE')
      result += decoder.decode(value, { stream: true })
    }
    return result + decoder.decode()
  }
  finally {
    signal?.removeEventListener('abort', abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function contentText(content: readonly ContentBlock[]): string {
  return content.map((block) => {
    if (block.type !== 'text' && block.type !== 'reasoning') {
      throw new CommandCodeError(`CommandCode text-only transport cannot serialize ${block.type} content`, 'INVALID_REQUEST')
    }
    return block.text
  }).join('\n')
}

/** Serialize the CLI dialect, not OpenAI Chat Completions or Responses. */
export function buildCommandCodeRequest(options: GenerateOptions, model: CatalogModel) {
  if (options.stop?.length)
    throw new CommandCodeError('CommandCode CLI gateway does not expose verified stop-sequence support', 'INVALID_REQUEST')
  if (options.reasoningEffort && !model.reasoningEfforts.includes(options.reasoningEffort))
    throw new CommandCodeError('Unsupported CommandCode reasoning effort', 'INVALID_REQUEST')
  const maxTokens = options.maxTokens ?? model.maxTokens
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0 || maxTokens > model.maxTokens)
    throw new CommandCodeError('Invalid CommandCode output token limit', 'INVALID_REQUEST')
  if (options.temperature !== undefined && (!Number.isFinite(options.temperature) || options.temperature < 0 || options.temperature > 2))
    throw new CommandCodeError('Invalid CommandCode temperature', 'INVALID_REQUEST')
  const system: string[] = options.system
    ? [options.system]
    : []
  const calls = new Map<string, string>()
  const messages: CommandCodeMessage[] = []
  for (const message of options.messages) {
    // This route sends complete tool declarations, not incremental developer bookkeeping.
    const content = message.role === 'developer'
      ? message.content.filter(block => block.type !== 'tool-addition' && block.type !== 'tool-removal')
      : message.content
    if (message.role === 'system') {
      const text = contentText(content)
      if (text)
        system.push(text)
    }
    else if (message.role === 'assistant') {
      const parts = content.map<CommandCodeAssistantPart>((block) => {
        if (block.type === 'tool-call') {
          let input: unknown
          try {
            input = JSON.parse(block.arguments)
          }
          catch { throw new CommandCodeError('Invalid historical tool-call JSON', 'INVALID_REQUEST') }
          calls.set(block.id, block.name)
          return {
            type: 'tool-call',
            toolCallId: block.id,
            toolName: block.name,
            input,
          }
        }
        if (block.type === 'text' || block.type === 'reasoning')
          return { type: block.type, text: block.text }
        throw new CommandCodeError(`CommandCode text-only transport cannot serialize ${block.type} content`, 'INVALID_REQUEST')
      })
      if (parts.length)
        messages.push({ role: 'assistant', content: parts })
    }
    else if (message.role === 'tool') {
      const name = calls.get(message.toolCallId)
      if (!name)
        throw new CommandCodeError('Tool result has no matching historical tool call', 'INVALID_REQUEST')
      messages.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: message.toolCallId,
            toolName: name,
            output: {
              type: message.isError ? 'error-text' : 'text',
              value: contentText(content),
            },
          },
        ],
      })
    }
    else {
      const text = contentText(content)
      if (text) {
        messages.push({
          role: 'user',
          content: [
            { type: 'text', text },
          ],
        })
      }
    }
  }
  return {
    // Do not collect real repository paths, git state, or machine identifiers for gateway metadata.
    config: {
      workingDir: '.',
      date: new Date().toISOString().slice(0, 10),
      environment: `${platform()}-${arch()}`,
      structure: [],
      isGitRepo: false,
      currentBranch: '',
      mainBranch: '',
      gitStatus: '',
      recentCommits: [],
    },
    memory: null,
    taste: null,
    skills: null,
    permissionMode: 'standard',
    params: {
      model: model.id,
      messages,
      tools: (options.tools ?? []).map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })),
      system: system.join('\n\n') || ' ',
      max_tokens: maxTokens,
      stream: true,
      ...(options.temperature === undefined
        ? {}
        : { temperature: options.temperature }),
      ...(options.reasoningEffort
        ? { reasoning_effort: options.reasoningEffort }
        : {}),
    },
  }
}

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

function tokenUsage(value: unknown): TokenUsage | undefined {
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

function finishReason(value: unknown, hasTools: boolean): FinishReason {
  const reason = string(value) ?? string(object(value)?.unified)
  if (reason && /^(?:length|max[_-]tokens|max_output_tokens|model_context_window_exceeded)$/.test(reason))
    return { kind: 'max-tokens' }
  if (reason && /^(?:error|unknown|content[_-]filter|refusal|pause_turn)$/.test(reason))
    throw new CommandCodeError(`CommandCode ended with unsupported completion reason ${reason}`, 'PROVIDER_ERROR')
  if (hasTools || (reason && /^(?:tool[_-]calls|tool_use)$/.test(reason)))
    return { kind: 'tool-calls' }
  return { kind: 'stop' }
}

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

function date(value: unknown): string | undefined {
  const numeric = number(value)
  const milliseconds = numeric === undefined
    ? (typeof value === 'string'
        ? Date.parse(value)
        : NaN)
    : numeric > 10_000_000_000
      ? numeric
      : numeric * 1000
  if (!Number.isFinite(milliseconds) || milliseconds <= 0 || milliseconds > 8.64e15)
    return undefined
  return new Date(milliseconds).toISOString()
}

/** Parse only server-reported limits. A missing grant never becomes a fabricated monthly budget. */
export function parseCommandCodeQuota(whoami: unknown, creditsResponse?: unknown, subscriptionResponse?: unknown): QuotaView {
  const identity = object(whoami)
  const root = object(creditsResponse)
  const credits = root?.success === false
    ? undefined
    : object(root?.credits)
  const subscriptionRoot = object(subscriptionResponse)
  const subscription = subscriptionRoot?.success === false
    ? undefined
    : object(subscriptionRoot?.data)
  const windowLimits = (root?.success === false
    ? undefined
    : object(root?.windowLimits)) ?? object(credits?.windowLimits) ?? (identity?.success === false
    ? undefined
    : object(identity?.windowLimits))
  const windows: QuotaWindow[] = []
  for (const [key, period] of [
    ['fiveHour', '5h'],
    ['weekly', 'week'],
  ] as const) {
    const window = object(windowLimits?.[key])
    const cap = number(window?.cap)
    const used = number(window?.used)
    if (cap === undefined || cap <= 0 || used === undefined)
      continue
    const resetsAt = date(window?.resetAt)
    windows.push({
      period,
      used,
      limit: cap,
      unit: 'USD',
      usedPercent: used / cap * 100,
      exhausted: used >= cap,
      ...(resetsAt
        ? { resetsAt }
        : {}),
    })
  }
  const remaining = number(credits?.monthlyCredits)
  const grant = number(credits?.monthlyCreditsGranted)
  if (remaining !== undefined && grant !== undefined && grant > 0) {
    const used = Math.max(0, grant - remaining)
    const resetsAt = date(subscription?.currentPeriodEnd)
    windows.push({
      period: 'month',
      used,
      limit: grant,
      unit: 'USD',
      usedPercent: used / grant * 100,
      exhausted: remaining <= 0,
      ...(resetsAt
        ? { resetsAt }
        : {}),
    })
  }
  const plan = string(credits?.planId) ?? string(subscription?.planId)
  return {
    status: windows.length ? 'ok' : 'unavailable',
    fetchedAt: new Date().toISOString(),
    windows,
    ...(plan
      ? { plan }
      : {}),
    ...(windows.length === 3
      ? {}
      : { reason: 'The server did not report all 5h/week/month limits; missing values are unavailable.' }),
  }
}

async function getQuotaJSON(path: string, key: string, signal?: AbortSignal): Promise<unknown> {
  const request = operation(signal, 15_000)
  try {
    request.signal.throwIfAborted()
    const response = await fetch(`${origin}${path}`, {
      headers: {
        ...headers(key),
        Accept: 'application/json',
      },
      signal: request.signal,
      redirect: 'error',
    })
    if (!response.ok)
      throw await responseError(response, key, request.signal)
    const body = await readBody(response, maxLineBytes, request.signal)
    let value: unknown
    try {
      value = JSON.parse(body)
    }
    catch { throw new CommandCodeError('Invalid CommandCode quota JSON', 'INVALID_RESPONSE') }
    const root = object(value)
    if (root?.success === false || root?.error !== undefined)
      throw upstreamError(value, key, response.status)
    return value
  }
  catch (error) {
    if (signal?.aborted)
      throw signal.reason
    if (request.signal.aborted)
      throw new CommandCodeError('CommandCode quota request timed out', 'TIMEOUT')
    if (error instanceof CommandCodeError)
      throw error
    throw new CommandCodeError('CommandCode quota connection failed', 'NETWORK')
  }
  finally {
    request.dispose()
  }
}

/** One explicit refresh, scoped to the supplied account; never polls or switches identities. */
export async function fetchCommandCodeQuota(account: StoredAccount, signal?: AbortSignal): Promise<QuotaView> {
  const key = keyOf(account)
  const whoami = await getQuotaJSON('/alpha/whoami?limits=1', key, signal)
  if (!object(whoami))
    throw new CommandCodeError('Invalid CommandCode account response', 'INVALID_RESPONSE')
  const orgId = string(object(object(whoami)?.org)?.id)
  const query = orgId
    ? `?orgId=${encodeURIComponent(orgId)}`
    : ''
  const [credits, subscription] = await Promise.allSettled([
    getQuotaJSON(`/alpha/billing/credits${query}`, key, signal),
    getQuotaJSON(`/alpha/billing/subscriptions${query}`, key, signal),
  ])
  signal?.throwIfAborted()
  for (const result of [credits, subscription]) {
    if (result.status === 'rejected' && result.reason instanceof CommandCodeError && result.reason.code === 'AUTH')
      throw result.reason
  }
  if (credits.status === 'rejected')
    throw credits.reason
  const view = parseCommandCodeQuota(whoami, credits.value, subscription.status === 'fulfilled'
    ? subscription.value
    : undefined)
  if (subscription.status === 'rejected')
    view.reason = 'Subscription details are unavailable; monthly reset timing may be missing.'
  return view
}
