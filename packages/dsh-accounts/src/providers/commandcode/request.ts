import type { ContentBlock, GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { CatalogModel } from '../../shared/types.js'
import type { CommandCodeAssistantPart, CommandCodeMessage } from './protocol.js'
import { arch, platform } from 'node:os'
import { CommandCodeError } from './protocol.js'

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
