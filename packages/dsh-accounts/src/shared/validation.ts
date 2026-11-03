import type { OAuthTokens } from './types.js'

export function text(value: unknown, label: string, max = 160): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max
    || [...value].some(character => character.charCodeAt(0) < 32 || character === '\u007F')) {
    throw new Error(`Invalid ${label}`)
  }
  return value.trim()
}

export function record(value: unknown, label = 'request'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Invalid ${label}`)
  return value as Record<string, unknown>
}

/** Model filter text; empty clears the filter, so `text()` cannot validate it. */
export function filterText(value: unknown): string {
  if (typeof value !== 'string' || value.length > 1024
    || [...value].some(character => character.charCodeAt(0) < 32 || character === '\u007F')) {
    throw new Error('Invalid model filter')
  }
  return value.trim()
}

export function validateTokens(value: unknown): OAuthTokens {
  const tokens = record(value, 'OAuth tokens')
  const access = text(tokens.access, 'access token', 32768)
  const refresh = text(tokens.refresh, 'refresh token', 32768)
  if (typeof tokens.expires !== 'number' || !Number.isFinite(tokens.expires) || tokens.expires <= 0)
    throw new Error('Invalid token expiry')
  const identity = Object.fromEntries([
    'accountId',
    'email',
    'orgId',
    'orgName',
  ].flatMap(key => tokens[key] === undefined
    ? []
    : [
        [
          key,
          text(tokens[key], key, 512),
        ],
      ]))
  return {
    access,
    refresh,
    expires: tokens.expires,
    ...identity,
  }
}
