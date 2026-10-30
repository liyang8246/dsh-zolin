import type { ContentBlock, FinishReason, StreamChunk, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai'
import type { ChannelId, StoredAccount } from '../shared/types.js'
import { object, replayFor } from './context.js'

export function redact(message: string, account: StoredAccount): string {
  const secrets = account.credential.kind === 'api-key'
    ? [account.credential.key]
    : [account.credential.tokens.access, account.credential.tokens.refresh]
  for (const secret of secrets) {
    if (secret)
      message = message.replaceAll(secret, '[redacted]')
  }
  return message
}

export function failure(message: string, aborted: boolean, details?: unknown): FinishReason {
  const detail = object(details)
  const facts = object(detail?.failure) ?? detail
  const status = typeof facts?.status === 'number' && Number.isInteger(facts.status) && facts.status >= 100 && facts.status <= 599
    ? facts.status
    : undefined
  let code = 'PROVIDER_ERROR'
  if (aborted)
    code = 'ABORTED'
  else if (typeof facts?.code === 'string' && facts.code)
    code = facts.code
  else if (/context.{0,40}(?:exceed|overflow|too long)/i.test(message))
    code = 'CONTEXT_WINDOW_EXCEEDED'
  else if (/quota|usage limit|balance|credit|budget/i.test(message))
    code = 'QUOTA'
  else if (status === 429 || /429|rate.?limit/i.test(message))
    code = 'RATE_LIMIT'
  else if (status === 401 || status === 403 || /401|403|unauthori[sz]ed|invalid.{0,15}(?:key|token)/i.test(message))
    code = 'AUTH'
  else if (status && status >= 500)
    code = 'SERVER'
  const retry = facts?.providerRetryAfterMs
  const offload = facts?.offloadImages
  return {
    kind: aborted ? 'aborted' : 'error',
    failure: {
      code,
      message,
      ...(status === undefined
        ? {}
        : { status }),
      ...(typeof retry === 'number' && Number.isFinite(retry) && retry > 0
        ? { providerRetryAfterMs: retry }
        : {}),
      ...(typeof offload === 'number' && Number.isSafeInteger(offload) && offload > 0
        ? { offloadImages: offload }
        : {}),
    },
  }
}

export async function* convertStream(events: AsyncIterable<AssistantMessageEvent>, channel: ChannelId, account: StoredAccount, wireFacts: Record<string, unknown>): AsyncIterable<StreamChunk> {
  const started = new Set<number>()
  const ended = new Set<number>()
  const ensureStart = function* (index: number, type: 'text' | 'reasoning' | 'tool-call'): Generator<StreamChunk> {
    if (!started.has(index)) {
      started.add(index)
      yield { type: 'block-start', index, blockType: type }
    }
  }
  const endBlock = function* (index: number, block: AssistantMessage['content'][number]): Generator<StreamChunk> {
    if (ended.has(index))
      return
    const type = block.type === 'toolCall'
      ? 'tool-call'
      : block.type === 'thinking'
        ? 'reasoning'
        : 'text'
    yield* ensureStart(index, type)
    ended.add(index)
    const content: ContentBlock = block.type === 'text'
      ? { type: 'text', text: block.text }
      : block.type === 'thinking'
        ? { type: 'reasoning', text: block.thinking }
        : {
            type: 'tool-call',
            id: block.id as ToolCallId,
            name: block.name,
            arguments: JSON.stringify(block.arguments),
          }
    yield { type: 'block-end', index, block: content }
  }
  for await (const event of events) {
    if (event.type === 'start')
      continue
    if (event.type === 'done' || event.type === 'error') {
      const message = event.type === 'done'
        ? event.message
        : event.error
      for (const [index, block] of message.content.entries()) yield* endBlock(index, block)
      yield {
        type: 'usage',
        usage: {
          inputTokens: message.usage.input,
          outputTokens: message.usage.output,
          cacheReadTokens: message.usage.cacheRead,
          cacheWriteTokens: message.usage.cacheWrite,
          totalTokens: message.usage.totalTokens,
          ...(message.usage.reasoning === undefined
            ? {}
            : { reasoningTokens: message.usage.reasoning }),
        },
      }
      if (event.type === 'error') {
        const error = redact(event.error.errorMessage ?? 'Provider request failed', account)
        yield {
          type: 'finish',
          reason: failure(error, event.reason === 'aborted' && wireFacts.code !== 'TIMEOUT', wireFacts),
        }
      }
      else if (event.reason === 'deferred') {
        yield {
          type: 'finish',
          reason: failure('Deferred provider responses are not supported', false),
        }
      }
      else if (!message.content.length) {
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: { code: 'EMPTY_RESPONSE', message: 'Provider returned an empty response' },
          },
        }
      }
      else {
        yield {
          type: 'finish',
          reason: {
            kind: event.reason === 'toolUse'
              ? 'tool-calls'
              : event.reason === 'length'
                ? 'max-tokens'
                : 'stop',
          },
          replayState: replayFor(message, channel, account),
        }
      }
      return
    }
    const index = event.contentIndex
    const block = event.partial.content[index]
    if (event.type.startsWith('text_')) {
      yield* ensureStart(index, 'text')
      if (event.type === 'text_delta')
        yield { type: 'text-delta', index, text: event.delta }
      if (event.type === 'text_end' && block)
        yield* endBlock(index, block)
    }
    else if (event.type.startsWith('thinking_')) {
      yield* ensureStart(index, 'reasoning')
      if (event.type === 'thinking_delta')
        yield { type: 'reasoning-delta', index, text: event.delta }
      if (event.type === 'thinking_end' && block)
        yield* endBlock(index, block)
    }
    else {
      yield* ensureStart(index, 'tool-call')
      if (block?.type === 'toolCall' && (event.type === 'toolcall_start' || event.type === 'toolcall_delta')) {
        yield {
          type: 'tool-call-delta',
          index,
          id: block.id as ToolCallId,
          name: block.name,
          argumentsDelta: event.type === 'toolcall_delta'
            ? event.delta
            : '',
        }
      }
      if (event.type === 'toolcall_end')
        yield* endBlock(index, event.toolCall)
    }
  }
  yield {
    type: 'finish',
    reason: failure('Provider stream ended without a terminal event', false),
  }
}
