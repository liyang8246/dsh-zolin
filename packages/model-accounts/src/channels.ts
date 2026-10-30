import type { Channel } from './types.js'

export const channels: readonly Channel[] = [
  {
    id: 'openai-codex',
    name: 'OpenAI Codex',
    source: 'openai',
    auth: ['oauth'],
    consoleURL: 'https://chatgpt.com/codex/settings/usage',
  },
  {
    id: 'opencode-go',
    name: 'OpenCode Go',
    source: 'opencode-go',
    auth: ['oauth'],
    consoleURL: 'https://opencode.ai/console',
  },
  {
    id: 'commandcode-go',
    name: 'CommandCode Go',
    source: 'commandcode',
    auth: ['api-key'],
    consoleURL: 'https://commandcode.ai/dashboard',
  },
]

export function channelFor(value: unknown): Channel {
  const channel = channels.find(channel => channel.id === value)
  if (!channel)
    throw new Error('Unknown model channel')
  return channel
}
