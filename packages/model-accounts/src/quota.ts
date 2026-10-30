import type { QuotaView, QuotaWindow, StoredAccount } from './types.js'
import { fetchJSON, ProviderHTTPError } from './http.js'
import { record } from './validation.js'

function percent(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined
}
function reset(value: unknown): string | undefined {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
    return undefined
  return new Date(value).toISOString()
}

export function parseOpenAIQuota(input: unknown): QuotaView {
  const body = record(input, 'OpenAI usage')
  const rate = record(body.rate_limit, 'OpenAI rate limit')
  const windows: QuotaWindow[] = []
  for (const key of ['primary_window', 'secondary_window']) {
    if (rate[key] == null)
      continue
    const window = record(rate[key], 'OpenAI usage window')
    const seconds = window.limit_window_seconds
    const period = seconds === 18000
      ? '5h'
      : seconds === 604800
        ? 'week'
        : seconds === 2592000
          ? 'month'
          : 'other'
    const usedPercent = percent(window.used_percent)
    if (usedPercent === undefined)
      continue
    const epoch = window.reset_at
    const resetsAt = typeof epoch === 'number' && Number.isFinite(epoch) && epoch > 0 && epoch < 8640000000000
      ? new Date(epoch * 1000).toISOString()
      : undefined
    // Own undefined values would not survive the JSON round trip the tool result requires.
    windows.push({
      period,
      ...(period === 'other'
        ? {
            label: typeof seconds === 'number'
              ? `${seconds / 3600}h`
              : key,
          }
        : {}),
      usedPercent,
      ...(resetsAt
        ? { resetsAt }
        : {}),
      exhausted: usedPercent >= 100,
    })
  }
  return {
    status: windows.length ? 'ok' : 'unavailable',
    fetchedAt: new Date().toISOString(),
    windows,
    ...(typeof body.plan_type === 'string'
      ? {
          plan: body.plan_type.slice(0, 80),
        }
      : {}),
    ...(!windows.length
      ? { reason: 'OpenAI did not return supported quota windows' }
      : {}),
  }
}

export function parseOpenCodeQuota(input: unknown): QuotaView {
  const body = record(input, 'OpenCode usage')
  const usage = record(body.usage, 'OpenCode usage windows')
  const windows: QuotaWindow[] = []
  for (const [key, period] of [
    ['rolling', '5h'],
    ['weekly', 'week'],
    ['monthly', 'month'],
  ] as const) {
    if (usage[key] == null)
      continue
    const window = record(usage[key], 'OpenCode usage window')
    const usedPercent = percent(window.percent)
    if (usedPercent === undefined)
      continue
    const resetsAt = reset(window.resetsAt)
    windows.push({
      period,
      usedPercent,
      ...(resetsAt
        ? { resetsAt }
        : {}),
      exhausted: window.status === 'rate-limited' || usedPercent >= 100,
    })
  }
  return {
    status: windows.length ? 'ok' : 'unavailable',
    fetchedAt: new Date().toISOString(),
    windows,
    ...(!windows.length
      ? { reason: 'OpenCode did not return supported quota windows' }
      : {}),
  }
}

export async function fetchQuota(account: StoredAccount, signal?: AbortSignal): Promise<QuotaView> {
  if (account.channel === 'commandcode-go')
    throw new Error('Use the CommandCode quota adapter')
  const token = account.credential.kind === 'api-key'
    ? account.credential.key
    : account.credential.tokens.access
  const headers: Record<string, string> = { 'Authorization': `Bearer ${token}`, 'User-Agent': 'dsh-zephyr/0.2.0' }
  if (account.channel === 'openai-codex') {
    if (account.credential.kind !== 'oauth')
      throw new Error('Codex requires OAuth')
    if (account.credential.tokens.accountId)
      headers['ChatGPT-Account-Id'] = account.credential.tokens.accountId
    return parseOpenAIQuota(await fetchJSON('https://chatgpt.com/backend-api/wham/usage', { headers }, signal))
  }
  if (account.credential.kind === 'oauth' && account.credential.tokens.orgId)
    headers['x-opencode-org-id'] = account.credential.tokens.orgId
  try {
    return parseOpenCodeQuota(await fetchJSON('https://opencode.ai/zen/go/v1/usage', { headers }, signal))
  }
  catch (error) {
    // Go returns 403 when the selected organization has no subscription allowance.
    if (!(error instanceof ProviderHTTPError) || error.status !== 403)
      throw error
    return {
      status: 'unavailable',
      fetchedAt: new Date().toISOString(),
      windows: [],
      reason: 'No OpenCode Go allowance is available for this account and organization',
    }
  }
}
