export async function jsonResponse(response: Response, limit = 2 * 1024 * 1024): Promise<unknown> {
  if (!response.body)
    throw new Error('Provider returned an empty response')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let body = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done)
        break
      size += value.byteLength
      if (size > limit)
        throw new Error('Provider response exceeds size limit')
      body += decoder.decode(value, { stream: true })
    }
    try {
      return JSON.parse(body + decoder.decode()) as unknown
    }
    catch {
      // Native JSON errors quote response bodies, which may contain credentials.
      throw new Error('Provider returned invalid JSON')
    }
  }
  finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export class ProviderHTTPError extends Error {
  constructor(readonly status: number) {
    super(`Provider returned HTTP ${status}${status === 401
      ? '; reconnect this account'
      : ''}`)
    this.name = 'ProviderHTTPError'
  }
}

export function fetchResponse(url: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
  return fetch(url, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.any([
      AbortSignal.timeout(25_000),
      ...(signal
        ? [signal]
        : []),
    ]),
  })
}

export async function fetchJSON(url: string, init: RequestInit = {}, signal?: AbortSignal): Promise<unknown> {
  const response = await fetchResponse(url, init, signal)
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new ProviderHTTPError(response.status)
  }
  return jsonResponse(response)
}
