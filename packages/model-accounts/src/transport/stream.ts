import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Api, Model, SimpleStreamOptions, ThinkingLevel } from '@earendil-works/pi-ai'
import type { CatalogModel, ChannelId, StoredAccount } from '../shared/types.js'
import { streamSimple as streamCodex } from '@earendil-works/pi-ai/api/openai-codex-responses'
import { streamSimple as streamCompletions } from '@earendil-works/pi-ai/api/openai-completions'
import { streamCommandCode } from '../providers/commandcode/stream.js'
import { object, toNativeContext, zeroUsage } from './context.js'
import { convertStream, failure, redact } from './events.js'

const headers = { 'user-agent': 'dsh-zephyr/0.2.0' }

function nativeModel(channel: ChannelId, model: CatalogModel): Model<Api> {
  return {
    id: model.id,
    name: model.name,
    api: channel === 'openai-codex'
      ? 'openai-codex-responses'
      : 'openai-completions',
    provider: channel,
    baseUrl: channel === 'openai-codex'
      ? 'https://chatgpt.com/backend-api'
      : 'https://opencode.ai/inference/go/openai/v1',
    input: model.input,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoning: model.reasoning,
    cost: zeroUsage().cost,
    thinkingLevelMap: Object.fromEntries([
      'off',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ].map(level => [
      level,
      level === 'off' && model.reasoningEfforts.includes('none')
        ? 'none'
        : model.reasoningEfforts.includes(level)
          ? level
          : null,
    ])),
    ...(channel === 'opencode-go'
      ? {
          compat: { requiresReasoningContentOnAssistantMessages: model.reasoningField === 'reasoning_content' },
        }
      : {}),
  }
}

export async function* streamPrepared(ctx: Context, options: GenerateOptions, account: StoredAccount, entry: CatalogModel): AsyncIterable<StreamChunk> {
  const controller = new AbortController()
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal
  let timer: ReturnType<typeof setTimeout> | undefined
  const wireFacts: Record<string, unknown> = {}
  const touch = (): void => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      wireFacts.code = 'TIMEOUT'
      controller.abort(new Error('Provider stream idle timeout'))
    }, 300_000)
    timer.unref()
  }
  try {
    signal.throwIfAborted()
    if (account.channel === 'commandcode-go') {
      yield* streamCommandCode(ctx, { ...options, signal }, account, entry)
      return
    }
    const model = nativeModel(account.channel, entry)
    if (options.reasoningEffort && !entry.reasoningEfforts.includes(options.reasoningEffort))
      throw new Error('Unsupported reasoning effort for this model')
    if (options.stop?.length && account.channel === 'openai-codex')
      throw new Error('Codex Responses does not support stop sequences')
    const context = await toNativeContext(ctx, { ...options, signal }, model, account, entry.reasoningField)
    const apiKey = account.credential.kind === 'api-key'
      ? account.credential.key
      : account.credential.tokens.access
    if (!apiKey.trim() || /[\r\n\0]/.test(apiKey))
      throw new Error('Invalid stored provider credential')
    const streamOptions: SimpleStreamOptions = {
      apiKey,
      signal,
      maxRetries: 0,
      transport: 'sse',
      fetch: async (input, init) => {
        const response = await globalThis.fetch(input, init)
        if (!response.ok) {
          wireFacts.status = response.status
          const milliseconds = response.headers.get('retry-after-ms')
          const retry = response.headers.get('retry-after')
          const delay = milliseconds
            ? Number(milliseconds)
            : retry
              ? (/^\d+(?:\.\d+)?$/.test(retry)
                  ? Number(retry) * 1000
                  : Date.parse(retry) - Date.now())
              : undefined
          if (delay !== undefined && Number.isFinite(delay) && delay > 0)
            wireFacts.providerRetryAfterMs = delay
        }
        return response
      },
      headers: {
        ...headers,
        ...(account.channel === 'opencode-go' && options.sessionId
          ? {
              'x-opencode-session': String(options.sessionId),
            }
          : {}),
        ...(account.channel === 'opencode-go' && account.credential.kind === 'oauth' && account.credential.tokens.orgId
          ? { 'x-opencode-org-id': account.credential.tokens.orgId }
          : {}),
      },
      ...(options.sessionId
        ? { sessionId: `${options.sessionId}:${account.channel}:${account.id}` }
        : {}),
      ...(options.maxTokens === undefined
        ? {}
        : { maxTokens: options.maxTokens }),
      ...(options.temperature === undefined
        ? {}
        : { temperature: options.temperature }),
      ...(options.reasoningEffort && !['off', 'none'].includes(options.reasoningEffort)
        ? { reasoning: options.reasoningEffort as ThinkingLevel }
        : {}),
      ...(options.stop?.length
        ? {
            onPayload: (payload: unknown) => {
              const body = object(payload)
              if (body)
                body.stop = options.stop
            },
          }
        : {}),
    }
    const events = account.channel === 'openai-codex'
      ? streamCodex(model as Model<'openai-codex-responses'>, context, streamOptions)
      : streamCompletions(model as Model<'openai-completions'>, context, streamOptions)
    touch()
    for await (const chunk of convertStream(events, account.channel, account, wireFacts)) {
      signal.throwIfAborted()
      touch()
      yield chunk
    }
  }
  catch (error) {
    const message = redact(error instanceof Error
      ? error.message
      : 'Provider request failed', account)
    yield {
      type: 'finish',
      reason: failure(message, options.signal?.aborted ?? false, wireFacts.code === 'TIMEOUT'
        ? wireFacts
        : error),
    }
  }
  finally {
    clearTimeout(timer)
    controller.abort()
  }
}
