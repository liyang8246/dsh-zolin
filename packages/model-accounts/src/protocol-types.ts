export interface CommandCodeTextPart {
  type: 'text' | 'reasoning'
  text: string
}

export type CommandCodeAssistantPart = CommandCodeTextPart | {
  type: 'tool-call'
  toolCallId: string
  toolName: string
  input: unknown
}

export type CommandCodeMessage = {
  role: 'user'
  content: { type: 'text', text: string }[]
} | {
  role: 'assistant'
  content: CommandCodeAssistantPart[]
} | {
  role: 'tool'
  content: {
    type: 'tool-result'
    toolCallId: string
    toolName: string
    output: { type: 'text' | 'error-text', value: string }
  }[]
}

export interface CommandCodeEvent extends Record<string, unknown> {
  type: string
}

export interface CommandCodeOpenBlock {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  id: string
  text: string
  name?: string
}
