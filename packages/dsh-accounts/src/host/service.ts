import type { Context } from '@deepseek-ai/cordis'
import type { AccountSnapshot, CatalogModel, ChannelId, ModelCatalog, QuotaView } from '../shared/types.js'
import { setTimeout as delay } from 'node:timers/promises'
import { catalogMetadata, modelCatalog } from '../providers/catalog.generated.js'
import { fetchCodexModels } from '../providers/codex-models.js'
import { fetchCommandCodeQuota } from '../providers/commandcode/quota.js'
import { refreshOpenAI } from '../providers/openai.js'
import { refreshOpenCode } from '../providers/opencode.js'
import { fetchQuota } from '../providers/quota.js'
import { channelFor, channels } from '../shared/channels.js'
import { safeError } from '../shared/errors.js'
import { record, text } from '../shared/validation.js'
import { Accounts } from './accounts.js'
import { Logins } from './logins.js'

export class ModelAccountsService {
  readonly accounts: Accounts
  readonly catalog: ModelCatalog = { ...modelCatalog }
  onChange?: () => void
  private readonly logins: Logins
  private readonly controller = new AbortController()
  private readonly quotas = new Map<string, QuotaView>()
  private readonly fetching = new Map<string, Promise<void>>()
  private codex?: { account: string, at: number, models: CatalogModel[] }
  private timer?: ReturnType<typeof setInterval>
  private cycling = false

  constructor(ctx: Context) {
    this.accounts = new Accounts(ctx.credentials, (channel, tokens, signal) => {
      if (channel === 'openai-codex')
        return refreshOpenAI(tokens, signal)
      if (channel === 'opencode-go')
        return refreshOpenCode(tokens, signal)
      throw new Error('OAuth is not supported by this channel')
    })
    this.logins = new Logins(this.accounts, () => this.onChange?.())
  }

  async snapshot(): Promise<AccountSnapshot> {
    const views = await this.accounts.list()
    const saved = await this.accounts.quotas()
    return {
      channels,
      accounts: views.map((account) => {
        const quota = this.quotas.get(account.id) ?? saved[account.id]
        return quota
          ? { ...account, quota }
          : account
      }),
      catalog: catalogMetadata,
    }
  }

  async activeChannels(): Promise<ChannelId[]> {
    const accounts = await this.accounts.list()
    return channels.filter(channel => accounts.some(account => account.channel === channel.id && account.active)).map(channel => channel.id)
  }

  async refreshCatalog(channel: ChannelId, signal?: AbortSignal): Promise<void> {
    if (channel !== 'openai-codex' || this.controller.signal.aborted)
      return
    const account = await this.accounts.resolve(channel, signal)
    if (this.codex?.account === account.id && Date.now() - this.codex.at < 10 * 60_000) {
      this.catalog.openai = this.codex.models
      return
    }
    const models = await fetchCodexModels(account, signal)
    if (this.controller.signal.aborted)
      return
    this.codex = {
      account: account.id,
      at: Date.now(),
      models,
    }
    this.catalog.openai = models
  }

  private async refreshQuota(id: string, signal?: AbortSignal): Promise<void> {
    const pending = this.fetching.get(id)
    if (pending)
      return pending
    const operation = (async () => {
      try {
        const view = (await this.accounts.list()).find(account => account.id === id)
        if (!view)
          throw new Error('Account not found')
        const account = await this.accounts.resolve(view.channel, signal, id)
        const quota = account.channel === 'commandcode-go'
          ? await fetchCommandCodeQuota(account, signal)
          : await fetchQuota(account, signal)
        if (!this.controller.signal.aborted && (await this.accounts.list()).some(account => account.id === id)) {
          this.quotas.set(id, quota)
          // Persist successful answers only; transient errors must not replace the restart cache.
          void this.accounts.saveQuota(id, quota).catch(() => {})
        }
      }
      catch (error) {
        if (!this.controller.signal.aborted && (await this.accounts.list()).some(account => account.id === id)) {
          this.quotas.set(id, {
            status: 'error',
            fetchedAt: new Date().toISOString(),
            windows: [],
            reason: safeError(error),
          })
        }
      }
    })()
    this.fetching.set(id, operation)
    try {
      await operation
    }
    finally {
      this.fetching.delete(id)
    }
  }

  async dispatch(raw: unknown, origin: 'ui' | 'agent', signal?: AbortSignal): Promise<unknown> {
    if (this.controller.signal.aborted)
      throw new Error('Plugin is unloading')
    const args = record(raw)
    const action = text(args.action, 'action')
    switch (action) {
      case 'list': {
        const snapshot = await this.snapshot()
        const login = this.logins.pending
        return origin === 'ui' && login
          ? { ...snapshot, login }
          : snapshot
      }
      case 'activate':
        await this.accounts.activate(channelFor(args.channel).id, text(args.id, 'account id'))
        this.onChange?.()
        break
      case 'deactivate':
        await this.accounts.deactivate(channelFor(args.channel).id)
        this.onChange?.()
        break
      case 'rename':
        await this.accounts.rename(text(args.id, 'account id'), text(args.label, 'account label'))
        break
      case 'remove': {
        const id = text(args.id, 'account id')
        await this.accounts.remove(id)
        this.quotas.delete(id)
        this.onChange?.()
        break
      }
      case 'refresh_quota': {
        const accounts = await this.accounts.list()
        const ids = args.id === undefined
          ? accounts.map(account => account.id)
          : [
              text(args.id, 'account id'),
            ]
        if (ids.some(id => !accounts.some(account => account.id === id)))
          throw new Error('Account not found')
        for (let offset = 0; offset < ids.length; offset += 3) {
          await Promise.all(ids.slice(offset, offset + 3).map(id => this.refreshQuota(id, signal)))
        }
        break
      }
      default:
        if (origin !== 'ui')
          throw new Error('Authentication is user-only; open Settings → Model Accounts')
        if (action !== 'add_key')
          return this.logins.dispatch(action, args)
        await this.accounts.add(channelFor(args.channel).id, text(args.label, 'account label'), {
          kind: 'api-key',
          key: text(args.key, 'API key', 32768),
        })
        this.onChange?.()
    }
    return this.snapshot()
  }

  start(): void {
    if (this.timer || this.controller.signal.aborted)
      return
    this.timer = setInterval(() => void this.refreshCycle(), 60_000)
    this.timer.unref()
  }

  private async refreshCycle(): Promise<void> {
    if (this.cycling || this.controller.signal.aborted)
      return
    this.cycling = true
    try {
      const ids = (await this.accounts.list()).map(account => account.id)
      for (const [index, id] of ids.entries()) {
        this.controller.signal.throwIfAborted()
        await this.refreshQuota(id, this.controller.signal)
        if (index < ids.length - 1)
          await delay(5_000, undefined, { signal: this.controller.signal })
      }
    }
    catch { /* Shutdown or unavailable credentials are retried only on the next scheduled cycle. */ }
    finally { this.cycling = false }
  }

  dispose(): void {
    this.controller.abort()
    clearInterval(this.timer)
    this.timer = undefined
    this.logins.dispose()
    this.quotas.clear()
  }
}
