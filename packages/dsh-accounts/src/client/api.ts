// @env browser
import type { AccountSnapshot, LoginView } from '../shared/types.js'
import type { ClientRequest, LoginRequest, SnapshotRequest } from './types.js'
import { isLoginRequest, isObject, readLogin, readSnapshot } from './data.js'

export async function call(request: SnapshotRequest, signal?: AbortSignal): Promise<AccountSnapshot>
export async function call(request: LoginRequest, signal?: AbortSignal): Promise<LoginView>
export async function call(request: ClientRequest, signal?: AbortSignal): Promise<AccountSnapshot | LoginView>
export async function call(request: ClientRequest, signal?: AbortSignal): Promise<AccountSnapshot | LoginView> {
  const response = await fetch(new URL('api/zephyr-models', document.baseURI), {
    method: 'POST',
    credentials: 'same-origin',
    redirect: 'error',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  })
  const value: unknown = await response.json()
  signal?.throwIfAborted()
  const error = isObject(value) && typeof value.error === 'string'
    ? value.error
    : undefined
  if (!response.ok || (error && isObject(value) && !('status' in value)))
    throw new Error(error || `HTTP ${response.status}`)
  return isLoginRequest(request)
    ? readLogin(value)
    : readSnapshot(value)
}
