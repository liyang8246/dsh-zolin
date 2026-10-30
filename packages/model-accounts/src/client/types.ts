import type { AccountSnapshot, ChannelId, QuotaView, QuotaWindow } from '../shared/types.js'

export type SnapshotRequest
  = | { action: 'list' | 'refresh_quota', id?: string }
    | { action: 'activate', channel: ChannelId, id: string }
    | { action: 'deactivate', channel: ChannelId }
    | { action: 'remove', id: string }
    | { action: 'add_key', channel: ChannelId, label: string, key: string }

export type LoginRequest
  = | { action: 'login_start', channel: ChannelId, label: string }
    | { action: 'login_status' | 'login_cancel', attemptId: string }
    | { action: 'login_reply', attemptId: string, answer: string }

export type ClientRequest = SnapshotRequest | LoginRequest
export type MeasuredQuotaWindow = QuotaWindow & { usedPercent: number }

export interface QuotaProps {
  quota: QuotaView | undefined
}

export interface QuotaBarsProps {
  windows: readonly MeasuredQuotaWindow[]
}

export interface AccountStore {
  getSnapshot: () => AccountSnapshot | undefined
  subscribe: (listener: () => void) => () => void
  publish: (snapshot: AccountSnapshot) => void
  update: (operation: () => Promise<AccountSnapshot>) => Promise<AccountSnapshot>
  reload: () => Promise<AccountSnapshot>
  dispose: () => void
}
