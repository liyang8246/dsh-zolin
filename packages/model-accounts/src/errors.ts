export function safeError(error: unknown): string {
  // Upstream response bodies and credentials must never reach logs, UI or tool results.
  const message = error instanceof Error
    ? error.message
    : 'Account operation failed'
  return message.replace(/(?:Bearer\s+|(?:access_token|refresh_token|api_key)["'=:\s]+)[^\s,;]+/gi, '[redacted]').slice(0, 300)
}
