import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock, GenerateOptions, ReplayEnvelope } from '@deepseek-ai/dsh-llm'
import type { Api, AssistantMessage, ImageContent, JsonObject, Message, Model, TextContent, Tool, TranscriptContext, Usage } from '@earendil-works/pi-ai'
import type { ChannelId, StoredAccount } from '../shared/types.js'
import { Buffer } from 'node:buffer'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'

const MAX_IMAGE_BYTES = 20 * 1024 * 1024

export function zeroUsage(): Usage {
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

function parseArguments(raw: string): JsonObject {
  try {
    const value: unknown = JSON.parse(raw)
    if (value && typeof value === 'object' && !Array.isArray(value))
      return value as JsonObject
  }
  catch { /* Invalid model arguments remain executable as an empty object, as in the shipped adapter. */ }
  return {}
}

export function object(value: unknown): Record<string, unknown> | undefined {
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

export function replayFor(message: AssistantMessage, channel: ChannelId, account: StoredAccount): ReplayEnvelope {
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

export async function toNativeContext(ctx: Context, options: GenerateOptions, model: Model<Api>, account: StoredAccount, reasoningField?: string): Promise<TranscriptContext> {
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
