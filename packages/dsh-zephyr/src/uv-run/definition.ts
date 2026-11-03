import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { readArgs } from './args.js'
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, runUv } from './run.js'

const DESCRIPTION = [
  'Run a Python script with `uv run --no-project -`.',
  'The script arrives on stdin as `code`, so quotes, backslashes and newlines need no shell escaping.',
  'Third-party imports need a PEP 723 header.',
].join(' ')

function valueText(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return ''
  const text = (value as { text?: unknown }).text
  return typeof text === 'string'
    ? text
    : ''
}

export function createDefinition(ctx: Context): ToolDefinition {
  return {
    name: 'uv_run',
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'Complete Python script.',
        },
        timeoutMs: {
          type: 'number',
          description: `Timeout in milliseconds; defaults to ${DEFAULT_TIMEOUT_MS} and is capped at ${MAX_TIMEOUT_MS}.`,
        },
      },
      required: ['code'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      render(_args, value) {
        return [
          {
            type: 'text',
            text: valueText(value),
          },
        ]
      },
    },
    async execute(rawArgs, exec) {
      return runUv(ctx, readArgs(rawArgs), exec)
    },
  }
}
