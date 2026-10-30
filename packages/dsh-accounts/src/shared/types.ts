export type ChannelId = 'openai-codex' | 'opencode-go' | 'commandcode-go'
export type CatalogSource = 'openai' | 'opencode-go' | 'commandcode'

export interface CatalogModel {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  input: ('text' | 'image')[]
  reasoning: boolean
  reasoningEfforts: string[]
  reasoningField?: string
}
export type ModelCatalog = Record<CatalogSource, CatalogModel[]>

export interface OAuthTokens {
  access: string
  refresh: string
  expires: number
  accountId?: string
  email?: string
  orgId?: string
  orgName?: string
}

export interface StoredAccount {
  id: string
  channel: ChannelId
  label: string
  createdAt: string
  credential: { kind: 'api-key', key: string } | { kind: 'oauth', tokens: OAuthTokens }
}

// One atomic credential record owns selection and secrets; views never expose credential.
export interface AccountState {
  version: 1
  accounts: StoredAccount[]
  active: Partial<Record<ChannelId, string>>
  /** Last known quota per account id, so a restart shows numbers immediately. */
  quotas?: Record<string, QuotaView>
}

export interface QuotaWindow {
  period: '5h' | 'week' | 'month' | 'other'
  label?: string
  usedPercent?: number
  used?: number
  limit?: number
  unit?: string
  resetsAt?: string
  exhausted?: boolean
}
export interface QuotaView {
  status: 'ok' | 'unavailable' | 'error'
  fetchedAt: string
  windows: QuotaWindow[]
  reason?: string
  plan?: string
}

export interface AccountView {
  id: string
  channel: ChannelId
  label: string
  createdAt: string
  auth: 'api-key' | 'oauth'
  active: boolean
  email?: string
  orgName?: string
  quota?: QuotaView
}

export interface LoginNotice {
  url?: string
  code?: string
  message?: string
}
export interface LoginInteraction {
  signal: AbortSignal
  notify: (notice: LoginNotice) => void
  prompt: (message: string, signal?: AbortSignal) => Promise<string>
}

export interface Channel {
  id: ChannelId
  name: string
  source: CatalogSource
  auth: readonly ('api-key' | 'oauth')[]
  consoleURL: string
}

export interface LoginView {
  id: string
  channel: ChannelId
  status: 'pending' | 'authorized' | 'cancelled' | 'error'
  notice?: LoginNotice
  prompt?: string
  error?: string
}

export interface LoginAttempt extends LoginView {
  controller: AbortController
  reply?: (answer: string) => void
}

export interface AccountSnapshot {
  channels: readonly Channel[]
  accounts: AccountView[]
  catalog: { source: string, generatedAt: string, sha256: string }
  login?: LoginView
}
