export interface ToolArgs {
  code: string
  timeoutMs?: number
}

export function readArgs(raw: unknown): ToolArgs {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('invalid arguments: expected an object')
  }
  const args = raw as Record<string, unknown>
  if (typeof args.code !== 'string' || args.code.trim().length === 0) {
    throw new Error('invalid code: expected a non-empty string')
  }
  if (
    args.timeoutMs !== undefined
    && (typeof args.timeoutMs !== 'number' || !Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)
  ) {
    throw new Error(`invalid timeoutMs: expected a positive number, got ${JSON.stringify(args.timeoutMs)}`)
  }
  return {
    code: args.code,
    ...(args.timeoutMs !== undefined
      ? { timeoutMs: args.timeoutMs }
      : {}),
  }
}
