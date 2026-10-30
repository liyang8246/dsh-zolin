import type { AccountSnapshot, AccountView, Channel, ChannelId, LoginNotice, LoginView, QuotaView, QuotaWindow } from '../shared/types.js'
import type { ClientRequest, LoginRequest, MeasuredQuotaWindow } from './types.js'
import { channels } from '../shared/channels.js'
import { authorizationHosts, quotaPeriods } from './constants.js'

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function optionalNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value))
}

function isChannelId(value: unknown): value is ChannelId {
  return channels.some(channel => channel.id === value)
}

function isChannel(value: unknown): value is Channel {
  return isObject(value) && isChannelId(value.id) && typeof value.name === 'string'
    && (value.source === 'openai' || value.source === 'opencode-go' || value.source === 'commandcode')
    && Array.isArray(value.auth) && value.auth.every((item: unknown) => item === 'api-key' || item === 'oauth')
    && typeof value.consoleURL === 'string'
}

function isQuotaWindow(value: unknown): value is QuotaWindow {
  return isObject(value)
    && (value.period === '5h' || value.period === 'week' || value.period === 'month' || value.period === 'other')
    && optionalString(value.label) && optionalString(value.unit) && optionalString(value.resetsAt)
    && optionalNumber(value.usedPercent) && optionalNumber(value.used) && optionalNumber(value.limit)
    && (value.exhausted === undefined || typeof value.exhausted === 'boolean')
}

function isQuota(value: unknown): value is QuotaView {
  return isObject(value) && (value.status === 'ok' || value.status === 'unavailable' || value.status === 'error')
    && typeof value.fetchedAt === 'string' && Array.isArray(value.windows) && value.windows.every(isQuotaWindow)
    && optionalString(value.reason) && optionalString(value.plan)
}

function isAccount(value: unknown): value is AccountView {
  return isObject(value) && typeof value.id === 'string' && isChannelId(value.channel)
    && typeof value.label === 'string' && typeof value.createdAt === 'string'
    && (value.auth === 'api-key' || value.auth === 'oauth') && typeof value.active === 'boolean'
    && optionalString(value.email) && optionalString(value.orgName)
    && (value.quota === undefined || isQuota(value.quota))
}

function isNotice(value: unknown): value is LoginNotice {
  return isObject(value) && optionalString(value.url) && optionalString(value.code) && optionalString(value.message)
}

function isLogin(value: unknown): value is LoginView {
  return isObject(value) && typeof value.id === 'string' && isChannelId(value.channel)
    && (value.status === 'pending' || value.status === 'authorized' || value.status === 'cancelled' || value.status === 'error')
    && optionalString(value.prompt) && optionalString(value.error)
    && (value.notice === undefined || isNotice(value.notice))
}

function isSnapshot(value: unknown): value is AccountSnapshot {
  return isObject(value) && Array.isArray(value.channels) && value.channels.every(isChannel)
    && Array.isArray(value.accounts) && value.accounts.every(isAccount)
    && isObject(value.catalog) && typeof value.catalog.source === 'string'
    && typeof value.catalog.generatedAt === 'string' && typeof value.catalog.sha256 === 'string'
    && (value.login === undefined || isLogin(value.login))
}

export function readSnapshot(value: unknown): AccountSnapshot {
  if (!isSnapshot(value))
    throw new Error('Invalid account response')
  return value
}

export function readLogin(value: unknown): LoginView {
  if (!isLogin(value))
    throw new Error('Invalid login response')
  return value
}

export function isLoginRequest(request: ClientRequest): request is LoginRequest {
  return request.action === 'login_start' || request.action === 'login_status'
    || request.action === 'login_reply' || request.action === 'login_cancel'
}

export function channelOf(provider: unknown): ChannelId | undefined {
  return channels.find(channel => provider === `zephyr-${channel.id}`)?.id
}

export function measuredWindows(windows: readonly QuotaWindow[]): MeasuredQuotaWindow[] {
  return quotaPeriods.flatMap((period) => {
    const window = windows.find(item => item.period === period)
    return window && typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent)
      ? [
          { ...window, usedPercent: window.usedPercent },
        ]
      : []
  })
}

export function activeQuota(snapshot: AccountSnapshot | undefined, channel: ChannelId | undefined): MeasuredQuotaWindow[] {
  const quota = snapshot?.accounts.find(account => account.channel === channel && account.active)?.quota
  return quota?.status === 'ok'
    ? measuredWindows(quota.windows)
    : []
}

export function leftOf(window: MeasuredQuotaWindow): number {
  return window.exhausted
    ? 0
    : Math.min(100, Math.max(0, 100 - window.usedPercent))
}

export function levelOf(window: MeasuredQuotaWindow): 'full' | 'high' | 'ok' {
  const left = leftOf(window)
  return left <= 0
    ? 'full'
    : left <= 20
      ? 'high'
      : 'ok'
}

export function authorizationURL(login: LoginView): string | undefined {
  if (!login.notice?.url)
    return undefined
  try {
    const url = new URL(login.notice.url)
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && authorizationHosts[login.channel].includes(url.hostname)
      ? url.href
      : undefined
  }
  catch {
    return undefined
  }
}

export function resetTime(value: string | undefined, countdown = false, now = Date.now()): string {
  if (!value || !Number.isFinite(Date.parse(value)))
    return ''
  if (!countdown) {
    return new Date(value).toLocaleString(undefined, {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }
  const minutes = Math.round((Date.parse(value) - now) / 60_000)
  if (minutes <= 0)
    return ''
  const hours = Math.floor(minutes / 60)
  return hours
    ? `${hours}h${minutes % 60}min`
    : `${minutes}min`
}
