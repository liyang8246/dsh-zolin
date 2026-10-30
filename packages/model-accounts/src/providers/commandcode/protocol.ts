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

export const maxLineBytes = 2 * 1024 * 1024

export function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
export function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0
    ? value
    : undefined
}
export function number(value: unknown): number | undefined {
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
