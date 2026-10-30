import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, LlmAdapter, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import type { CatalogModel, Channel, ChannelId, ModelCatalog, StoredAccount } from '../shared/types.js'
import { channelFor } from '../shared/channels.js'
import { streamPrepared } from './stream.js'

function channelOf(provider: string): Channel {
  return channelFor(provider.startsWith('zephyr-')
    ? provider.slice('zephyr-'.length)
    : provider)
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
