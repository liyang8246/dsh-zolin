// @env node
import type { LoginInteraction, OAuthTokens } from '../shared/types.js'
import { setTimeout as delay } from 'node:timers/promises'
import { fetchJSON, fetchResponse, jsonResponse, ProviderHTTPError } from '../shared/http.js'
import { record, text, validateTokens } from '../shared/validation.js'

const server = 'https://opencode.ai/console'
const clientId = 'opencode-cli'
const userAgent = 'dsh-zephyr/0.2.0'

async function post(path: string, body: object, signal?: AbortSignal, grant?: 'poll' | 'refresh'): Promise<unknown> {
  const response = await fetchResponse(`${server}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': userAgent },
    body: JSON.stringify(body),
  }, signal)
  if (response.ok)
    return jsonResponse(response)
  if (grant) {
    const failure: unknown = await jsonResponse(response).catch(() => undefined)
    const error = failure && typeof failure === 'object' && 'error' in failure
      ? failure.error
      : undefined
    if (grant === 'poll' && typeof error === 'string')
      return failure
    // A transient server error must not turn into a lost authorization grant.
    if (grant === 'refresh' && response.status === 400 && error === 'invalid_grant')
      throw new Error('OpenCode: invalid_grant; reconnect this account')
  }
  await response.body?.cancel().catch(() => {})
  throw new ProviderHTTPError(response.status)
}

function tokensFrom(input: unknown, previous?: OAuthTokens): OAuthTokens {
  const value = record(input, 'OpenCode token response')
  if (value.error) {
    const reason = typeof value.error === 'string' && ['invalid_grant', 'expired_token', 'access_denied'].includes(value.error)
      ? value.error
      : 'authorization_failed'
    throw new Error(`OpenCode: ${reason}; reconnect this account`)
  }
  if (typeof value.expires_in !== 'number' || !Number.isFinite(value.expires_in) || value.expires_in <= 0)
    throw new Error('Invalid OpenCode token expiry')
  const orgId = value.org_id == null
    ? previous?.orgId
    : text(value.org_id, 'OpenCode organization id', 512)
  return validateTokens({
    ...previous,
    access: value.access_token,
    refresh: value.refresh_token,
    expires: Date.now() + value.expires_in * 1000,
    ...(orgId
      ? {
          orgId,
          orgName: previous?.orgId === orgId
            ? previous.orgName
            : orgId,
        }
      : {}),
  })
}

export async function refreshOpenCode(tokens: OAuthTokens, signal?: AbortSignal): Promise<OAuthTokens> {
  return tokensFrom(await post('/auth/device/token', {
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh,
    client_id: clientId,
  }, signal, 'refresh'), tokens)
}

async function pollTokens(deviceCode: string, interval: number, signal: AbortSignal): Promise<OAuthTokens> {
  interval = Math.max(1000, interval * 1000)
  for (;;) {
    await delay(interval, undefined, { signal })
    const response = record(await post('/auth/device/token', {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode,
      client_id: clientId,
    }, signal, 'poll'))
    if (response.error === 'authorization_pending')
      continue
    if (response.error === 'slow_down') {
      interval += 5000
      continue
    }
    return tokensFrom(response)
  }
}

export async function loginOpenCode(interaction: LoginInteraction): Promise<OAuthTokens> {
  const device = record(await post('/auth/device/code', { client_id: clientId, supports_org_scope: true }, interaction.signal))
  const deviceCode = text(device.device_code, 'device code', 8192)
  const verification = new URL(text(device.verification_uri_complete, 'verification URL', 8192), `${server}/`)
  if (verification.protocol !== 'https:' || verification.hostname !== 'opencode.ai' || verification.port || verification.username || verification.password)
    throw new Error('Unexpected OpenCode verification URL')
  if (typeof device.expires_in !== 'number' || !Number.isFinite(device.expires_in) || device.expires_in <= 0)
    throw new Error('Invalid OpenCode device expiry')
  if (typeof device.interval !== 'number' || !Number.isFinite(device.interval) || device.interval <= 0 || device.interval > 3600)
    throw new Error('Invalid OpenCode polling interval')
  const signal = AbortSignal.any([
    interaction.signal,
    AbortSignal.timeout(Math.min(device.expires_in * 1000, 15 * 60_000)),
  ])
  interaction.notify({
    url: verification.href,
    code: text(device.user_code, 'user code'),
    message: 'OpenCode Console',
  })
  const tokens = await pollTokens(deviceCode, device.interval, signal)
  const headers = { 'Authorization': `Bearer ${tokens.access}`, 'User-Agent': userAgent }
  const [userValue, orgsValue] = await Promise.all([
    fetchJSON(`${server}/api/user`, { headers }, signal),
    fetchJSON(`${server}/api/orgs`, { headers }, signal),
  ])
  const user = record(userValue, 'OpenCode user')
  if (!Array.isArray(orgsValue))
    throw new TypeError('Invalid OpenCode organizations')
  const orgs = orgsValue.map((value) => {
    const org = record(value, 'OpenCode organization')
    return {
      id: text(org.id, 'organization id', 512),
      name: text(org.name, 'organization name', 512),
    }
  }).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  const org = tokens.orgId
    ? orgs.find(org => org.id === tokens.orgId)
    : orgs[0]
  if (tokens.orgId && !org)
    throw new Error('Authorized OpenCode organization not found')
  return validateTokens({
    ...tokens,
    accountId: text(user.id, 'OpenCode account id', 512),
    email: text(user.email, 'OpenCode email', 512),
    ...(org
      ? { orgId: org.id, orgName: org.name }
      : {}),
  })
}
