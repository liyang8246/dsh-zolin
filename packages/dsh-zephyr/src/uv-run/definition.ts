import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { readArgs } from './args.js'
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, runUv } from './run.js'

const DESCRIPTION = [
  'Run a Python script with `uv run --no-project -`.',
  'Pass the complete script as `code`; it is delivered on stdin, so quotes, backslashes, newlines, and Unicode need no shell escaping.',
  'Without a PEP 723 header, uv uses the first Python on PATH, so imports outside the standard library may fail.',
  'To install dependencies, include a PEP 723 header: start with `# /// script`, list dependencies in `# dependencies = [...]`, then close with `# ///`; uv creates an isolated environment for that script.',
  'Non-zero exits are reported as `[exit code: N]`; sandbox denials are reported as `[sandbox: ...]`.',
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
          description: 'Complete Python script. Include PEP 723 inline metadata when it imports third-party packages.',
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
