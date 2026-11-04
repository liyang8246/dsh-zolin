// @env node
import type { CatalogModel, LoginInteraction, OAuthTokens, QuotaView, QuotaWindow, StoredAccount } from '../shared/types.js'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { fetchJSON } from '../shared/http.js'
import { record } from '../shared/validation.js'

/* The upstream binds every token to the domain that issued it, so sign-in, chat, catalog and
 * billing all use this one product host. */
const LOGIN_BASE = 'https://www.codebuddy.cn'
const CHAT_BASE = 'https://copilot.tencent.com'
const DOMAIN = 'www.codebuddy.cn'
const API_PREFIX = '/v2/plugin'
/* The catalog channel is chosen by User-Agent: the WorkBuddy one lists every model, the CLI
 * one a strict subset. Chat keeps the CLI identity, where the gateway binds the conversation. */
const PRODUCT_UA = 'WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0'
const CHAT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'
const POLL_MS = 2_000
/* The token the sign-in hands back is bound to that browser session: it answered the credit
 * endpoint once, then 401'd while a refreshed token kept working. So every WorkBuddy token is
 * treated as short-lived and rotated well before the upstream's stated 30 days. */
const TOKEN_TTL_MS = 30 * 60_000
/** Routing entries, not models: the gateway picks a real model (and price) per request. */
const routers = new Set([
  'auto',
  'balanced-model',
  'deep-model',
  'fast-model',
])

export const workBuddyChatBase = CHAT_BASE

/** The upstream's `data` object; a refusal or a pending answer simply carries none. */
function dataOf(value: unknown, label: string): Record<string, unknown> {
  const data = record(value, label).data
  return data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {}
}

function firstText(source: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim())
      return value.trim()
    if (typeof value === 'number' && Number.isFinite(value))
      return String(value)
  }
  return ''
}

/** Absolute epoch, seconds or milliseconds, or a relative TTL in seconds. */
function expiry(value: Record<string, unknown>, absolute: readonly string[], ttl: readonly string[]): number | undefined {
  for (const key of absolute) {
    const raw = value[key]
    const parsed = typeof raw === 'number'
      ? raw
      : typeof raw === 'string'
        ? Number(raw)
        : Number.NaN
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed > 1e12
        ? parsed
        : parsed * 1000
    }
  }
  for (const key of ttl) {
    const raw = value[key]
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0)
      return Date.now() + raw * 1000
  }
  return undefined
}

/** The expiry to store, capped so a stale session token is rotated instead of reused. */
function storedExpiry(value: Record<string, unknown>): number {
  const stated = expiry(value, ['expiresAt', 'expires_at'], ['expiresIn', 'expires_in'])
  const ceiling = Date.now() + TOKEN_TTL_MS
  return stated === undefined
    ? ceiling
    : Math.min(stated, ceiling)
}

function userHeaders(tokens: OAuthTokens): Record<string, string> {
  return tokens.accountId
    ? { 'X-User-Id': tokens.accountId }
    : { 'X-No-User-Id': '1' }
}

/** Request headers for the chat endpoint; the conversation triple is fresh per request. */
export function workBuddyChatHeaders(account: StoredAccount): Record<string, string> {
  if (account.credential.kind !== 'oauth')
    throw new Error('WorkBuddy requires an OAuth account')
  return {
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN',
    'Content-Type': 'application/json',
    'Origin': LOGIN_BASE,
    'Referer': `${LOGIN_BASE}/`,
    'User-Agent': CHAT_UA,
    'X-Agent-Purpose': 'conversation',
    'X-CodeBuddy-Request': '1',
    'X-Conversation-ID': randomUUID(),
    'X-Conversation-Message-ID': randomUUID(),
    'X-Conversation-Request-ID': randomUUID(),
    'X-Domain': DOMAIN,
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Version': '5.8.3',
    'X-Product': 'WorkBuddy',
    'X-Requested-With': 'XMLHttpRequest',
    ...userHeaders(account.credential.tokens),
  }
}

function billingHeaders(tokens: OAuthTokens): Record<string, string> {
  return {
    'Accept': 'application/json',
    'Accept-Language': 'zh-CN',
    'Authorization': `Bearer ${tokens.access}`,
    'Content-Type': 'application/json',
    'Origin': LOGIN_BASE,
    'Referer': `${LOGIN_BASE}/`,
    'User-Agent': 'WorkBuddy/5.8.3',
    'X-CodeBuddy-Request': '1',
    'X-Domain': DOMAIN,
    'X-Requested-With': 'XMLHttpRequest',
    ...userHeaders(tokens),
  }
}

async function profile(access: string, domain: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  try {
    const value = await fetchJSON(`${LOGIN_BASE}${API_PREFIX}/login/account`, {
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${access}`,
        'X-Domain': domain,
      },
    }, signal)
    return dataOf(value, 'WorkBuddy account profile')
  }
  catch {
    // Identity is display metadata; a login whose tokens are in hand must not fail on it.
    return {}
  }
}

/**
 * Browser sign-in: the upstream issues a state, the user confirms it on the web page, and the
 * same state is polled until it yields tokens. No callback listener and no PKCE — the state
 * itself is the binding between this attempt and the answer.
 */
export async function loginWorkBuddy(interaction: LoginInteraction): Promise<OAuthTokens> {
  const started = dataOf(await fetchJSON(`${LOGIN_BASE}${API_PREFIX}/auth/state?platform=workbuddy`, {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: '{}',
  }, interaction.signal), 'WorkBuddy sign-in')
  const state = firstText(started, ['state', 'State'])
  if (!state)
    throw new Error('WorkBuddy did not issue a sign-in state')
  const url = firstText(started, ['authUrl', 'auth_url', 'url', 'Url']) || `${LOGIN_BASE}/login?state=${encodeURIComponent(state)}`
  interaction.notify({ url, message: 'Sign in to WorkBuddy in the browser window, then leave it open until this panel finishes.' })
  for (;;) {
    await delay(POLL_MS, undefined, { signal: interaction.signal })
    let answer: Record<string, unknown>
    try {
      answer = dataOf(await fetchJSON(`${LOGIN_BASE}${API_PREFIX}/auth/token?state=${encodeURIComponent(state)}`, {
        headers: { Accept: 'application/json' },
      }, interaction.signal), 'WorkBuddy sign-in')
    }
    catch {
      // A transport blip is not a failed sign-in: the attempt deadline ends a stuck one.
      continue
    }
    interaction.signal.throwIfAborted()
    const access = firstText(answer, ['accessToken', 'access_token'])
    if (!access)
      continue
    const uid = firstText(await profile(access, firstText(answer, ['domain', 'Domain']) || DOMAIN, interaction.signal), ['uid', 'Uid', 'userId', 'UserID'])
    const refresh = firstText(answer, ['refreshToken', 'refresh_token'])
    return {
      access,
      // The store rejects an empty refresh token; without one the access token is the only
      // thing the refresh endpoint can be handed, and a failure there just asks for a new login.
      refresh: refresh || access,
      expires: storedExpiry(answer),
      ...(uid
        ? { accountId: uid }
        : {}),
    }
  }
}

export async function refreshWorkBuddy(tokens: OAuthTokens, signal?: AbortSignal): Promise<OAuthTokens> {
  const answer = dataOf(await fetchJSON(`${CHAT_BASE}${API_PREFIX}/auth/token/refresh`, {
    method: 'POST',
    headers: {
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN',
      'Origin': LOGIN_BASE,
      'Referer': `${LOGIN_BASE}/`,
      'User-Agent': CHAT_UA,
      'X-Auth-Refresh-Source': 'workbuddy',
      'X-Refresh-Token': tokens.refresh,
      'X-Requested-With': 'XMLHttpRequest',
    },
  }, signal), 'WorkBuddy token refresh')
  const access = firstText(answer, ['accessToken', 'access_token'])
  if (!access)
    throw new Error('WorkBuddy returned no access token; sign in again')
  return {
    ...tokens,
    access,
    refresh: firstText(answer, ['refreshToken', 'refresh_token']) || tokens.refresh,
    expires: storedExpiry(answer),
  }
}

function efforts(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return []
  const reasoning = record(value, 'WorkBuddy reasoning')
  const raw = Array.isArray(reasoning.supportedEfforts)
    ? reasoning.supportedEfforts
    : [
        reasoning.effort,
      ]
  return [
    ...new Set(raw.flatMap((item) => {
      const level = typeof item === 'string'
        ? item
        : record(item, 'WorkBuddy reasoning effort').effort
      return typeof level === 'string' && /^[a-z]+$/.test(level) && level !== 'off'
        ? [
            level,
          ]
        : []
    })),
  ]
}

export function parseWorkBuddyModels(input: unknown): CatalogModel[] {
  const models = dataOf(input, 'WorkBuddy catalog').models
  if (!Array.isArray(models))
    throw new TypeError('Invalid WorkBuddy model list')
  const result: CatalogModel[] = []
  for (const value of models) {
    const model = record(value, 'WorkBuddy model')
    const id = typeof model.id === 'string'
      ? model.id
      : ''
    // Completion, rewrite, image and video entries answer on other endpoints, not chat.
    if (!id || model.disabled === true || model.supportsToolCall !== true || routers.has(id))
      continue
    const context = record(model.contextWindow ?? {}, 'WorkBuddy context window').defaultLength
    const contextWindow = typeof context === 'number' && Number.isSafeInteger(context) && context > 0
      ? context
      : model.maxInputTokens
    const maxTokens = model.maxOutputTokens
    if (typeof contextWindow !== 'number' || !Number.isSafeInteger(contextWindow) || contextWindow <= 0)
      continue
    if (typeof maxTokens !== 'number' || !Number.isSafeInteger(maxTokens) || maxTokens <= 0)
      continue
    const levels = efforts(model.reasoning)
    result.push({
      id,
      name: typeof model.name === 'string' && model.name
        ? model.name
        : id,
      contextWindow,
      maxTokens,
      input: [
        'text',
        ...(model.supportsImages === true && model.disabledMultimodal !== true
          ? [
              'image' as const,
            ]
          : []),
      ],
      reasoning: levels.length > 0,
      reasoningEfforts: levels,
      reasoningField: 'reasoning_content',
    })
  }
  if (!result.length)
    throw new Error('WorkBuddy returned no usable models')
  return result.sort((a, b) => a.id.localeCompare(b.id, 'en'))
}

export async function fetchWorkBuddyModels(account: StoredAccount, signal?: AbortSignal): Promise<CatalogModel[]> {
  if (account.credential.kind !== 'oauth')
    throw new Error('WorkBuddy requires an OAuth account')
  return parseWorkBuddyModels(await fetchJSON(`${CHAT_BASE}/v3/config`, {
    headers: {
      'Accept': 'application/json',
      'Accept-Language': 'zh-CN',
      'Authorization': `Bearer ${account.credential.tokens.access}`,
      'Connection': 'close',
      // short: the CN catalog only answers with this literal placeholder; a real uid (or no
      // header at all) yields `models: null`. Revisit when upstream fixes its config lookup.
      'X-User-Id': 'undefined',
      'User-Agent': PRODUCT_UA,
      'X-CodeBuddy-Request': '1',
      'X-Domain': DOMAIN,
      'X-Product': 'WorkBuddy',
      'X-Requested-With': 'XMLHttpRequest',
    },
  }, signal))
}

/** Credits are a pool, not a rate window: report the sum of the packages as one number. */
export function parseWorkBuddyQuota(input: unknown): QuotaView {
  const objectOf = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const packages = objectOf(objectOf(objectOf(objectOf(input).data).Response).Data).Accounts
  const rows = Array.isArray(packages)
    ? packages
    : []
  // Every capacity also arrives as a `*Precise` string holding the fraction the integer drops.
  const precise = (row: Record<string, unknown>, key: string): number => {
    for (const raw of [
      row[`${key}Precise`],
      row[key],
    ]) {
      const value = typeof raw === 'string'
        ? Number.parseFloat(raw)
        : raw
      if (typeof value === 'number' && Number.isFinite(value))
        return value
    }
    return 0
  }
  let remain = 0
  let size = 0
  for (const value of rows) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      continue
    const row = objectOf(value)
    remain += Math.max(0, precise(row, row.CycleCapacityRemain === undefined
      ? 'CapacityRemain'
      : 'CycleCapacityRemain'))
    size += precise(row, 'CycleCapacitySize') || precise(row, 'CapacitySize')
  }
  if (!rows.length) {
    return {
      status: 'unavailable',
      fetchedAt: new Date().toISOString(),
      windows: [],
      reason: 'WorkBuddy returned no credit packages',
    }
  }
  // An empty pool still has to render, so the limit falls back to the balance itself.
  const limit = size > 0
    ? size
    : remain > 0
      ? remain
      : 1
  const window: QuotaWindow = {
    period: 'other',
    label: '积分',
    used: Math.round((limit - remain) * 100) / 100,
    limit: Math.round(limit * 100) / 100,
    usedPercent: Math.min(100, Math.max(0, ((limit - remain) / limit) * 100)),
    ...(remain <= 0
      ? { exhausted: true }
      : {}),
  }
  return {
    status: 'ok',
    fetchedAt: new Date().toISOString(),
    windows: [
      window,
    ],
  }
}

export async function fetchWorkBuddyQuota(account: StoredAccount, signal?: AbortSignal): Promise<QuotaView> {
  if (account.credential.kind !== 'oauth')
    throw new Error('WorkBuddy requires an OAuth account')
  const format = (date: Date): string => `${date.getFullYear().toString().padStart(4, '0')}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')} ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}`
  const now = new Date()
  return parseWorkBuddyQuota(await fetchJSON(`${LOGIN_BASE}/v2/billing/meter/get-user-resource`, {
    method: 'POST',
    headers: billingHeaders(account.credential.tokens),
    body: JSON.stringify({
      PageNumber: 1,
      PageSize: 100,
      ProductCode: 'p_tcaca',
      Status: [
        0,
        3,
      ],
      PackageEndTimeRangeBegin: format(now),
      PackageEndTimeRangeEnd: format(new Date(now.getTime() + 365 * 101 * 24 * 3600 * 1000)),
    }),
  }, signal))
}
