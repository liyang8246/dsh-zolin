import type { StatusPayload, StatusRequest } from '../shared/types.js'

/** Narrow an unknown response body to the settings payload. */
function isStatus(value: unknown): value is StatusPayload {
  if (typeof value !== 'object' || value === null)
    return false
  const candidate = value as Partial<StatusPayload>
  return typeof candidate.configured === 'boolean'
    && typeof candidate.autoUpload === 'boolean'
    && typeof candidate.pending === 'number'
    && typeof candidate.sessions === 'number'
}

/** Read or mutate the plugin's settings state through its host route. */
export async function call(request: StatusRequest, signal?: AbortSignal): Promise<StatusPayload> {
  const response = await fetch(new URL('api/codetime', document.baseURI), {
    method: 'POST',
    credentials: 'same-origin',
    redirect: 'error',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  })
  const text = await response.text()
  signal?.throwIfAborted()
  let value: unknown
  try {
    value = JSON.parse(text)
  }
  catch {
    throw new Error(response.ok
      ? 'CodeTime returned an invalid JSON response'
      : `CodeTime HTTP ${response.status}`)
  }
  if (!response.ok)
    throw new Error(errorText(value) ?? `HTTP ${response.status}`)
  if (!isStatus(value))
    throw new Error('unexpected response')
  return value
}

/** Extract the route's error message when present. */
function errorText(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null)
    return undefined
  const error = (value as { error?: unknown }).error
  return typeof error === 'string'
    ? error
    : undefined
}
