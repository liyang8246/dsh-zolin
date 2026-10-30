import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock, FinishReason, GenerateOptions, LlmAdapter, LlmResolvedModelInfo, ReplayEnvelope, StreamChunk, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Api, AssistantMessage, AssistantMessageEvent, ImageContent, JsonObject, Message, Model, SimpleStreamOptions, TextContent, ThinkingLevel, Tool, TranscriptContext, Usage } from '@earendil-works/pi-ai'
import type { CatalogModel, Channel, ChannelId, ModelCatalog, StoredAccount } from './types.js'
import { Buffer } from 'node:buffer'
import { streamSimple as streamCodex } from '@earendil-works/pi-ai/api/openai-codex-responses'
import { streamSimple as streamCompletions } from '@earendil-works/pi-ai/api/openai-completions'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import { channelFor } from './channels.js'
import { streamCommandCode } from './commandcode.js'

const headers = { 'user-agent': 'dsh-zephyr/0.2.0' }
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  }
}

function channelOf(provider: string): Channel {
  return channelFor(provider.startsWith('zephyr-')
    ? provider.slice('zephyr-'.length)
    : provider)
}

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

function describe(provider: string, channel: ChannelId, model: CatalogModel): LlmResolvedModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name,
    inputModalities: channel === 'commandcode-go'
      ? ['text']
      : model.input,
    context: { contextWindow: model.contextWindow },
    defaultMaxTokens: model.maxTokens,
    ...(model.reasoning && model.reasoningEfforts.length
      ? {
          reasoning: {
            efforts: model.reasoningEfforts.map(level => ({ id: level as NonNullable<GenerateOptions['reasoningEffort']>, name: level })),
          },
        }
      : {}),
  }
}

function parseArguments(raw: string): JsonObject {
  try {
    const value: unknown = JSON.parse(raw)
    if (value && typeof value === 'object' && !Array.isArray(value))
      return value as JsonObject
  }
  catch { /* Invalid model arguments remain executable as an empty object, as in the shipped adapter. */ }
  return {}
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function nativeMetadata(value: unknown): Record<string, string | boolean> {
  const block = object(value)
  const result: Record<string, string | boolean> = {}
  for (const key of [
    'textSignature',
    'thinkingSignature',
    'thoughtSignature',
    'namespace',
  ]) {
    if (typeof block?.[key] === 'string')
      result[key] = block[key]
  }
  if (typeof block?.redacted === 'boolean')
    result.redacted = block.redacted
  return result
}

function replayFor(message: AssistantMessage, channel: ChannelId, account: StoredAccount): ReplayEnvelope {
  return {
    response: {
      kind: 'zephyr-pi',
      version: 1,
      channel,
      account: account.id,
      model: message.model,
      stopReason: message.stopReason,
      ...(message.responseId
        ? { responseId: message.responseId }
        : {}),
      ...(message.responseModel
        ? { responseModel: message.responseModel }
        : {}),
      ...(message.providerThinkingLevel
        ? { providerThinkingLevel: message.providerThinkingLevel }
        : {}),
    },
    blocks: message.content.map(nativeMetadata),
  }
}

async function toNativeContext(ctx: Context, options: GenerateOptions, model: Model<Api>, account: StoredAccount, reasoningField?: string): Promise<TranscriptContext> {
  const messages: Message[] = []
  const toolNames = new Map<string, string>()
  const toolIds = new Map<string, string>()
  let imageBytes = 0
  const imageSizes: number[] = []
  for (const message of options.messages) {
    for (const block of message.content) {
      if (block.type === 'tool-call')
        toolNames.set(block.id, block.name)
    }
  }
  const userContent = async (blocks: readonly ContentBlock[]): Promise<(TextContent | ImageContent)[]> => {
    const content: (TextContent | ImageContent)[] = []
    for (const block of blocks) {
      if (block.type === 'text' || block.type === 'reasoning') {
        content.push({ type: 'text', text: block.text })
      }
      else if (block.type === 'image') {
        if (block.offloaded) {
          content.push({ type: 'text', text: `[Image offloaded: ${block.attachment.name ?? block.attachment.attachmentId}]` })
          continue
        }
        if (!model.input.includes('image'))
          throw new Error('This model does not accept images; select an image-capable model')
        const attachments = ctx.get('attachments')
        if (!attachments)
          throw new Error('Image attachment service is unavailable')
        const stored = await attachments.readImage(block.attachment, options.signal)
        const encodedBytes = 4 * Math.ceil(stored.data.length / 3)
        imageSizes.push(encodedBytes)
        imageBytes += encodedBytes
        if (imageBytes > MAX_IMAGE_BYTES) {
          let remaining = imageBytes
          let offloadImages = 0
          while (remaining > MAX_IMAGE_BYTES) remaining -= imageSizes[offloadImages++]!
          throw Object.assign(new Error('Request images exceed the 20 MiB base64 budget; offload older images'), { code: 'IMAGE_OFFLOAD_REQUIRED', offloadImages })
        }
        content.push({
          type: 'image',
          data: Buffer.from(stored.data).toString('base64'),
          mimeType: stored.ref.mediaType,
        })
      }
      else if (block.type === 'file') {
        content.push({
          type: 'text',
          text: ctx.llm.fileRequestText(block.attachment),
        })
      }
      else {
        throw new Error(`Unsupported ${block.type} block in model request`)
      }
    }
    return content
  }
  for (const message of options.messages) {
    options.signal?.throwIfAborted()
    if (message.role === 'user') {
      messages.push({ role: 'user', content: await userContent(message.content), timestamp: 0 })
    }
    else if (message.role === 'tool') {
      messages.push({
        role: 'toolResult',
        toolCallId: toolIds.get(message.toolCallId) ?? message.toolCallId,
        toolName: toolNames.get(message.toolCallId) ?? 'unknown',
        content: await userContent(message.content),
        isError: message.isError ?? false,
        timestamp: 0,
      })
    }
    else if (message.role === 'system' || message.role === 'developer') {
      const text = message.content.flatMap((block) => {
        if (block.type === 'text' || block.type === 'reasoning')
          return [block.text]
        // No tool-update capability is advertised; options.tools is the complete current declaration set.
        if (message.role === 'developer' && (block.type === 'tool-addition' || block.type === 'tool-removal'))
          return []
        throw new Error(`Unsupported ${block.type} block in instruction message`)
      }).join('\n')
      if (text)
        messages.push({ role: 'system', content: text, timestamp: 0 })
    }
    else {
      const envelope = object(message.source.replayState)
      const replayBlocks = Array.isArray(envelope?.blocks)
        ? envelope.blocks
        : undefined
      const response = object(envelope?.response)
      const matching = response?.kind === 'zephyr-pi' && response.version === 1 && response.channel === account.channel && response.account === account.id && response.model === options.model && message.source.model === options.model && message.source.provider === options.provider && replayBlocks?.length === message.content.length
      const content: AssistantMessage['content'] = message.content.map((block, index) => {
        const metadata = matching
          ? nativeMetadata(replayBlocks?.[index])
          : {}
        if (block.type === 'text')
          return { ...metadata, type: 'text', text: block.text }
        if (block.type === 'reasoning') {
          return {
          // A reasoning field name is public model metadata, not an account-bound encrypted signature.
            ...(model.api === 'openai-completions' && reasoningField && ['reasoning_content', 'reasoning', 'reasoning_text'].includes(reasoningField)
              ? { thinkingSignature: reasoningField }
              : {}),
            ...metadata,
            type: 'thinking',
            thinking: block.text,
          }
        }
        if (block.type === 'tool-call') {
          // Responses item IDs are bound to the producing account/model, unlike call IDs.
          const id = !matching && model.api === 'openai-codex-responses'
            ? block.id.split('|')[0]!
            : block.id
          toolIds.set(block.id, id)
          return {
            ...metadata,
            type: 'toolCall',
            id,
            name: block.name,
            arguments: parseArguments(block.arguments),
          }
        }
        throw new Error(`Unsupported ${block.type} block in assistant history`)
      })
      const native: AssistantMessage = {
        role: 'assistant',
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: zeroUsage(),
        stopReason: content.some(block => block.type === 'toolCall')
          ? 'toolUse'
          : 'stop',
        timestamp: 0,
      }
      if (matching && response) {
        if (typeof response.responseId === 'string')
          native.responseId = response.responseId
        if (typeof response.responseModel === 'string')
          native.responseModel = response.responseModel
        if (typeof response.providerThinkingLevel === 'string')
          native.providerThinkingLevel = response.providerThinkingLevel
      }
      messages.push(native)
    }
  }
  const tools = options.tools?.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters as Tool['parameters'] }))
  return normalizeContext({ messages, tools, systemPrompt: options.system })
}

function redact(message: string, account: StoredAccount): string {
  const secrets = account.credential.kind === 'api-key'
    ? [account.credential.key]
    : [account.credential.tokens.access, account.credential.tokens.refresh]
  for (const secret of secrets) {
    if (secret)
      message = message.replaceAll(secret, '[redacted]')
  }
  return message
}

function failure(message: string, aborted: boolean, details?: unknown): FinishReason {
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

async function* convertStream(events: AsyncIterable<AssistantMessageEvent>, channel: ChannelId, account: StoredAccount, wireFacts: Record<string, unknown>): AsyncIterable<StreamChunk> {
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

async function* streamPrepared(ctx: Context, options: GenerateOptions, account: StoredAccount, entry: CatalogModel): AsyncIterable<StreamChunk> {
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

export function createTransport(ctx: Context, resolveAccount: (channel: ChannelId, signal?: AbortSignal) => Promise<StoredAccount>, modelCatalog: ModelCatalog, refreshCatalog?: (channel: ChannelId, signal?: AbortSignal) => Promise<void>): LlmAdapter {
  // The live list is advisory: a failing refresh must never block a call with a known model.
  const refresh = async (channel: ChannelId, signal?: AbortSignal) => {
    if (!refreshCatalog)
      return
    try {
      await refreshCatalog(channel, signal)
    }
    catch { /* keep the current catalog */ }
  }
  const find = (provider: string, model: string) => {
    const channel = channelOf(provider)
    const entry = modelCatalog[channel.source].find(entry => entry.id === model)
    if (!entry)
      throw new Error('Model is not in this channel\'s model list; sign in or refresh the catalog')
    return { channel: channel.id, entry }
  }
  const adapter: LlmAdapter = {
    providerInfo(provider) { return { id: provider, name: channelOf(provider).name } },
    providerRetryPolicy() { return undefined },
    imageRequestPricing() { return undefined },
    imageRequestTarget(_provider, _model, image) { return { width: image.width, height: image.height, maxBytes: image.bytes } },
    async listModels(provider) {
      const channel = channelOf(provider)
      await refresh(channel.id)
      return modelCatalog[channel.source].map(entry => describe(provider, channel.id, entry))
    },
    async resolveModel(provider, model, signal) {
      signal?.throwIfAborted()
      await refresh(channelOf(provider).id, signal)
      signal?.throwIfAborted()
      const found = find(provider, model)
      return describe(provider, found.channel, found.entry)
    },
    async prepareCall(provider, model, signal) {
      signal?.throwIfAborted()
      await refresh(channelOf(provider).id, signal)
      signal?.throwIfAborted()
      const { channel, entry } = find(provider, model)
      const account = structuredClone(await resolveAccount(channel, signal))
      if (account.channel !== channel)
        throw new Error('Stored account does not match the provider route')
      const captured = structuredClone(entry)
      return {
        model: describe(provider, channel, captured),
        stream(options) {
          if (options.provider !== provider || options.model !== model)
            throw new Error('Prepared provider/model does not match this request')
          return streamPrepared(ctx, options, account, captured)
        },
      }
    },
    async* stream(options) {
      const prepared = await adapter.prepareCall(options.provider, options.model, options.signal)
      yield* prepared.stream(options)
    },
  }
  return adapter
}
