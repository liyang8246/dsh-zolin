// @env node
import type { Context } from '@deepseek-ai/cordis'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { AccountState, AccountView, ChannelId, OAuthTokens, QuotaView, QuotaWindow, StoredAccount } from '../shared/types.js'
import { randomUUID } from 'node:crypto'
import { channelFor } from '../shared/channels.js'
import { record, text, validateTokens } from '../shared/validation.js'

// Existing installations own this record independently of the package name.
export const stateKey = 'zephyr/accounts'
if (!/^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/.test(stateKey))
  throw new Error('Invalid credential record key')
const credentialKey = stateKey as CredentialKey

function readCredential(channel: ChannelId, value: unknown): StoredAccount['credential'] {
  const definition = channelFor(channel)
  const credential = record(value, 'account credential')
  if (credential.kind !== 'api-key' && credential.kind !== 'oauth')
    throw new Error('Invalid account credential')
  if (!definition.auth.includes(credential.kind))
    throw new Error('Authentication method not supported by this channel')
  if (credential.kind === 'api-key') {
    return {
      kind: 'api-key',
      key: text(credential.key, 'API key', 32768),
    }
  }
  return {
    kind: 'oauth',
    tokens: validateTokens(credential.tokens),
  }
}

function readWindow(value: unknown): QuotaWindow[] {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return []
  const raw = record(value, 'stored quota window')
  const period = raw.period
  if (period !== '5h' && period !== 'week' && period !== 'month' && period !== 'other')
    return []
  const window: QuotaWindow = { period }
  for (const key of ['label', 'unit', 'resetsAt'] as const) {
    const value = raw[key]
    if (value !== undefined) {
      if (typeof value !== 'string')
        return []
      window[key] = value
    }
  }
  for (const key of ['usedPercent', 'used', 'limit'] as const) {
    const value = raw[key]
    if (value !== undefined) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
        return []
      window[key] = value
    }
  }
  if (raw.exhausted !== undefined) {
    if (typeof raw.exhausted !== 'boolean')
      return []
    window.exhausted = raw.exhausted
  }
  return [window]
}

function readQuotas(value: unknown): Record<string, QuotaView> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return {}
  return Object.fromEntries(Object.entries(value).flatMap(([id, raw]) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      return []
    const view = record(raw, 'stored quota view')
    if (view.status !== 'ok' && view.status !== 'unavailable' && view.status !== 'error')
      return []
    if (typeof view.fetchedAt !== 'string' || !Array.isArray(view.windows))
      return []
    const quota: QuotaView = {
      status: view.status,
      fetchedAt: view.fetchedAt,
      windows: view.windows.flatMap(readWindow),
    }
    for (const key of ['reason', 'plan'] as const) {
      if (typeof view[key] === 'string')
        quota[key] = view[key]
    }
    return [
      [id, quota],
    ]
  }))
}

export function readState(payload: unknown): AccountState {
  const state = record(payload, 'account store')
  if (state.version !== 1 || !Array.isArray(state.accounts))
    throw new Error('Unsupported account store version; credentials were not changed')
  const accounts = state.accounts.map((raw): StoredAccount => {
    const account = record(raw, 'account')
    const channel = channelFor(account.channel).id
    return {
      id: text(account.id, 'account id'),
      channel,
      label: text(account.label, 'account label'),
      createdAt: text(account.createdAt, 'account creation time'),
      credential: readCredential(channel, account.credential),
    }
  })
  if (new Set(accounts.map(account => account.id)).size !== accounts.length)
    throw new Error('Duplicate account ids in credential store')
  const active = record(state.active, 'active account selection')
  for (const [channel, id] of Object.entries(active)) {
    channelFor(channel)
    if (!accounts.some(account => account.id === id && account.channel === channel))
      throw new Error('Invalid active account selection')
  }
  return {
    version: 1,
    accounts,
    active: { ...active } as AccountState['active'],
    quotas: readQuotas(state.quotas),
  }
}

function stateFrom(stored: CredentialRecord | undefined): AccountState {
  if (!stored) {
    return {
      version: 1,
      accounts: [],
      active: {},
      quotas: {},
    }
  }
  if (stored.kind !== 'grant')
    throw new Error('Invalid Zephyr credential record')
  return readState(stored.payload)
}

export class Accounts {
  constructor(
    private readonly credentials: Pick<Context['credentials'], 'readRecord' | 'modifyRecord'>,
    private readonly refresh: (channel: ChannelId, tokens: OAuthTokens, signal?: AbortSignal) => Promise<OAuthTokens>,
  ) {}

  async read(): Promise<AccountState> {
    return stateFrom(await this.credentials.readRecord(credentialKey))
  }

  private async change<T>(mutate: (state: AccountState) => T | Promise<T>): Promise<T> {
    let result!: T
    await this.credentials.modifyRecord(credentialKey, async (current) => {
      const state = stateFrom(current)
      result = await mutate(state)
      return { kind: 'grant', payload: state }
    })
    return result
  }

  async list(): Promise<AccountView[]> {
    const state = await this.read()
    return state.accounts.map((account) => {
      const tokens = account.credential.kind === 'oauth'
        ? account.credential.tokens
        : undefined
      return {
        id: account.id,
        channel: account.channel,
        label: account.label,
        createdAt: account.createdAt,
        auth: account.credential.kind,
        active: state.active[account.channel] === account.id,
        ...(tokens?.email
          ? { email: tokens.email }
          : {}),
        ...(tokens?.orgName
          ? { orgName: tokens.orgName }
          : {}),
      }
    })
  }

  async add(channel: ChannelId, label: string, credential: StoredAccount['credential']): Promise<string> {
    const name = text(label, 'account label')
    const validated = readCredential(channel, credential)
    return this.change((state) => {
      const duplicate = state.accounts.find((account) => {
        if (account.channel !== channel)
          return false
        const previous = account.credential
        if (previous.kind === 'api-key' && validated.kind === 'api-key')
          return previous.key === validated.key
        return previous.kind === 'oauth' && validated.kind === 'oauth'
          && Boolean(previous.tokens.accountId)
          && previous.tokens.accountId === validated.tokens.accountId
          && previous.tokens.orgId === validated.tokens.orgId
      })
      if (duplicate) {
        duplicate.credential = validated
        duplicate.label = name
        return duplicate.id
      }
      const id = randomUUID()
      state.accounts.push({
        id,
        channel,
        label: name,
        createdAt: new Date().toISOString(),
        credential: validated,
      })
      state.active[channel] ??= id
      return id
    })
  }

  async activate(channel: ChannelId, id: string): Promise<void> {
    channelFor(channel)
    await this.change((state) => {
      if (!state.accounts.some(account => account.id === id && account.channel === channel))
        throw new Error('Account does not belong to this channel')
      state.active[channel] = id
    })
  }

  async deactivate(channel: ChannelId): Promise<void> {
    channelFor(channel)
    await this.change((state) => {
      delete state.active[channel]
    })
  }

  async rename(id: string, label: string): Promise<void> {
    const name = text(label, 'account label')
    await this.change((state) => {
      const account = state.accounts.find(account => account.id === id)
      if (!account)
        throw new Error('Account not found')
      account.label = name
    })
  }

  async remove(id: string): Promise<void> {
    await this.change((state) => {
      const account = state.accounts.find(account => account.id === id)
      if (!account)
        throw new Error('Account not found')
      state.accounts = state.accounts.filter(account => account.id !== id)
      if (state.active[account.channel] === id)
        delete state.active[account.channel]
      if (state.quotas)
        delete state.quotas[id]
    })
  }

  async quotas(): Promise<Record<string, QuotaView>> {
    return (await this.read()).quotas ?? {}
  }

  async saveQuota(id: string, quota: QuotaView | undefined): Promise<void> {
    await this.change((state) => {
      // A refresh finishing after removal must not resurrect the deleted cache.
      if (!state.accounts.some(account => account.id === id))
        return
      const quotas = state.quotas ??= {}
      if (quota)
        quotas[id] = JSON.parse(JSON.stringify(quota)) as QuotaView
      else
        delete quotas[id]
    })
  }

  async resolve(channel: ChannelId, signal?: AbortSignal, accountId?: string): Promise<StoredAccount> {
    channelFor(channel)
    signal?.throwIfAborted()
    const state = await this.read()
    signal?.throwIfAborted()
    const id = accountId ?? state.active[channel]
    const selected = state.accounts.find(account => account.id === id && account.channel === channel)
    if (!selected)
      throw new Error(`No active account for ${channel}`)
    if (selected.credential.kind === 'api-key' || selected.credential.tokens.expires > Date.now() + 60_000)
      return selected
    const resolved = await this.change(async (current) => {
      signal?.throwIfAborted()
      const account = current.accounts.find(account => account.id === id && account.channel === channel)
      if (!account)
        throw new Error('Account was removed')
      if (account.credential.kind === 'oauth' && account.credential.tokens.expires <= Date.now() + 60_000) {
        // The shared store lock serializes rotation; caller cancellation cannot discard its result.
        const tokens = await this.refresh(channel, account.credential.tokens, AbortSignal.timeout(25_000))
        account.credential = {
          kind: 'oauth',
          tokens: validateTokens(tokens),
        }
      }
      return structuredClone(account)
    })
    signal?.throwIfAborted()
    return resolved
  }
}
