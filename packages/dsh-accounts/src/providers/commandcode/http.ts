import type { StoredAccount } from '../../shared/types.js'
import { CommandCodeError, object, string } from './protocol.js'

export const origin = 'https://api.commandcode.ai'
const version = '1.88.2'

export function keyOf(account: StoredAccount): string {
  if (account.channel !== 'commandcode-go' || account.credential.kind !== 'api-key') {
    throw new CommandCodeError('CommandCode Go requires an API-key account', 'AUTH')
  }
  const key = account.credential.key
  if (!key.trim() || /[\r\n\0]/u.test(key))
    throw new CommandCodeError('Invalid stored CommandCode credential', 'AUTH')
  return key
}

export function headers(key: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
    'User-Agent': 'dsh-zephyr/0.2.0',
    'x-command-code-version': version,
    'x-cli-environment': 'production',
  }
}

function classify(message: string, status?: number): string {
  if (/MODEL_NOT_IN_PLAN|upgrade_required/i.test(message))
    return 'PERMISSION'
  if (/PREMIUM_CREDITS_EXHAUSTED|insufficient.*credit|out of credit|usage (?:window|limit)|window_limit|weekly limit/i.test(message))
    return 'QUOTA_EXCEEDED'
  if (/context.*(?:length|window)|prompt is too long/i.test(message))
    return 'CONTEXT_WINDOW_EXCEEDED'
  if (status === 429 || /RATE_LIMITED|too many requests/i.test(message))
    return 'RATE_LIMIT'
  if (status === 401 || status === 403 || /not authenticated|unauthor|invalid api key|session expired/i.test(message))
    return 'AUTH'
  if (status === 400)
    return 'INVALID_REQUEST'
  return status && status >= 500
    ? 'SERVER'
    : 'PROVIDER_ERROR'
}

export function upstreamError(value: unknown, key: string, status?: number, retryAfterMs?: number): CommandCodeError {
  const root = object(value)
  const nested = object(root?.error)
  const detail = string(nested?.message) ?? string(root?.message) ?? string(root?.error) ?? string(value) ?? 'CommandCode request failed'
  const code = string(nested?.code) ?? string(root?.code)
  const message = `${code
    ? `${code}: `
    : ''}${detail}`.replaceAll(key, '[redacted]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 2048)
  return new CommandCodeError(message, classify(message, status), status, retryAfterMs)
}

export function operation(signal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException('CommandCode request timed out', 'TimeoutError')), timeoutMs)
  timer.unref()
  return {
    signal: signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal,
    dispose: () => {
      clearTimeout(timer)
      controller.abort()
    },
  }
}

export async function responseError(response: Response, key: string, signal?: AbortSignal): Promise<CommandCodeError> {
  const raw = await readBody(response, 64 * 1024, signal)
  let value: unknown = raw
  try {
    value = JSON.parse(raw)
  }
  catch { /* A proxy can return plain text. */ }
  const retry = response.headers.get('retry-after')
  const retryAfterMs = retry
    ? (/^\d+(?:\.\d+)?$/.test(retry)
        ? Number(retry) * 1000
        : Date.parse(retry) - Date.now())
    : undefined
  return upstreamError(value, key, response.status, retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
    ? retryAfterMs
    : undefined)
}

export async function readBody(response: Response, limit: number, signal?: AbortSignal): Promise<string> {
  if (!response.body)
    return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const abort = (): void => {
    void reader.cancel(signal?.reason).catch(() => {})
  }
  signal?.addEventListener('abort', abort, { once: true })
  let result = ''
  let size = 0
  try {
    while (true) {
      signal?.throwIfAborted()
      const { done, value } = await reader.read()
      signal?.throwIfAborted()
      if (done)
        break
      size += value.byteLength
      if (size > limit)
        throw new CommandCodeError('CommandCode response exceeded its size limit', 'INVALID_RESPONSE')
      result += decoder.decode(value, { stream: true })
    }
    return result + decoder.decode()
  }
  finally {
    signal?.removeEventListener('abort', abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
