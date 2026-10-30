import type { QuotaView, QuotaWindow, StoredAccount } from '../../shared/types.js'
import { headers, keyOf, operation, origin, readBody, responseError, upstreamError } from './http.js'
import { CommandCodeError, maxLineBytes, number, object, string } from './protocol.js'

function date(value: unknown): string | undefined {
  const numeric = number(value)
  const milliseconds = numeric === undefined
    ? (typeof value === 'string'
        ? Date.parse(value)
        : NaN)
    : numeric > 10_000_000_000
      ? numeric
      : numeric * 1000
  if (!Number.isFinite(milliseconds) || milliseconds <= 0 || milliseconds > 8.64e15)
    return undefined
  return new Date(milliseconds).toISOString()
}

/** Parse only server-reported limits. A missing grant never becomes a fabricated monthly budget. */
export function parseCommandCodeQuota(whoami: unknown, creditsResponse?: unknown, subscriptionResponse?: unknown): QuotaView {
  const identity = object(whoami)
  const root = object(creditsResponse)
  const credits = root?.success === false
    ? undefined
    : object(root?.credits)
  const subscriptionRoot = object(subscriptionResponse)
  const subscription = subscriptionRoot?.success === false
    ? undefined
    : object(subscriptionRoot?.data)
  const windowLimits = (root?.success === false
    ? undefined
    : object(root?.windowLimits)) ?? object(credits?.windowLimits) ?? (identity?.success === false
    ? undefined
    : object(identity?.windowLimits))
  const windows: QuotaWindow[] = []
  for (const [key, period] of [
    ['fiveHour', '5h'],
    ['weekly', 'week'],
  ] as const) {
    const window = object(windowLimits?.[key])
    const cap = number(window?.cap)
    const used = number(window?.used)
    if (cap === undefined || cap <= 0 || used === undefined)
      continue
    const resetsAt = date(window?.resetAt)
    windows.push({
      period,
      used,
      limit: cap,
      unit: 'USD',
      usedPercent: used / cap * 100,
      exhausted: used >= cap,
      ...(resetsAt
        ? { resetsAt }
        : {}),
    })
  }
  const remaining = number(credits?.monthlyCredits)
  const grant = number(credits?.monthlyCreditsGranted)
  if (remaining !== undefined && grant !== undefined && grant > 0) {
    const used = Math.max(0, grant - remaining)
    const resetsAt = date(subscription?.currentPeriodEnd)
    windows.push({
      period: 'month',
      used,
      limit: grant,
      unit: 'USD',
      usedPercent: used / grant * 100,
      exhausted: remaining <= 0,
      ...(resetsAt
        ? { resetsAt }
        : {}),
    })
  }
  const plan = string(credits?.planId) ?? string(subscription?.planId)
  return {
    status: windows.length ? 'ok' : 'unavailable',
    fetchedAt: new Date().toISOString(),
    windows,
    ...(plan
      ? { plan }
      : {}),
    ...(windows.length === 3
      ? {}
      : { reason: 'The server did not report all 5h/week/month limits; missing values are unavailable.' }),
  }
}

async function getQuotaJSON(path: string, key: string, signal?: AbortSignal): Promise<unknown> {
  const request = operation(signal, 15_000)
  try {
    request.signal.throwIfAborted()
    const response = await fetch(`${origin}${path}`, {
      headers: {
        ...headers(key),
        Accept: 'application/json',
      },
      signal: request.signal,
      redirect: 'error',
    })
    if (!response.ok)
      throw await responseError(response, key, request.signal)
    const body = await readBody(response, maxLineBytes, request.signal)
    let value: unknown
    try {
      value = JSON.parse(body)
    }
    catch { throw new CommandCodeError('Invalid CommandCode quota JSON', 'INVALID_RESPONSE') }
    const root = object(value)
    if (root?.success === false || root?.error !== undefined)
      throw upstreamError(value, key, response.status)
    return value
  }
  catch (error) {
    if (signal?.aborted)
      throw signal.reason
    if (request.signal.aborted)
      throw new CommandCodeError('CommandCode quota request timed out', 'TIMEOUT')
    if (error instanceof CommandCodeError)
      throw error
    throw new CommandCodeError('CommandCode quota connection failed', 'NETWORK')
  }
  finally {
    request.dispose()
  }
}

/** One explicit refresh, scoped to the supplied account; never polls or switches identities. */
export async function fetchCommandCodeQuota(account: StoredAccount, signal?: AbortSignal): Promise<QuotaView> {
  const key = keyOf(account)
  const whoami = await getQuotaJSON('/alpha/whoami?limits=1', key, signal)
  if (!object(whoami))
    throw new CommandCodeError('Invalid CommandCode account response', 'INVALID_RESPONSE')
  const orgId = string(object(object(whoami)?.org)?.id)
  const query = orgId
    ? `?orgId=${encodeURIComponent(orgId)}`
    : ''
  const [credits, subscription] = await Promise.allSettled([
    getQuotaJSON(`/alpha/billing/credits${query}`, key, signal),
    getQuotaJSON(`/alpha/billing/subscriptions${query}`, key, signal),
  ])
  signal?.throwIfAborted()
  for (const result of [credits, subscription]) {
    if (result.status === 'rejected' && result.reason instanceof CommandCodeError && result.reason.code === 'AUTH')
      throw result.reason
  }
  if (credits.status === 'rejected')
    throw credits.reason
  const view = parseCommandCodeQuota(whoami, credits.value, subscription.status === 'fulfilled'
    ? subscription.value
    : undefined)
  if (subscription.status === 'rejected')
    view.reason = 'Subscription details are unavailable; monthly reset timing may be missing.'
  return view
}
