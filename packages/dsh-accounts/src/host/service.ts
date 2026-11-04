import type { Context } from '@deepseek-ai/cordis'
import type { AccountSnapshot, BenefitView, CatalogModel, ChannelId, CheckinView, ModelCatalog, QuotaView, StoredAccount } from '../shared/types.js'
import { setTimeout as delay } from 'node:timers/promises'
import { catalogMetadata, modelCatalog } from '../providers/catalog.generated.js'
import { fetchCodexModels } from '../providers/codex-models.js'
import { fetchCommandCodeQuota } from '../providers/commandcode/quota.js'
import { refreshOpenAI } from '../providers/openai.js'
import { refreshOpenCode } from '../providers/opencode.js'
import { consumeCodexResetCredit, fetchQuota } from '../providers/quota.js'
import { claimWorkBuddyBenefits, claimWorkBuddyCheckin, fetchWorkBuddyBenefits, fetchWorkBuddyCheckin, fetchWorkBuddyModels, fetchWorkBuddyQuota, refreshWorkBuddy } from '../providers/workbuddy.js'
import { channelFor, channels } from '../shared/channels.js'
import { safeError } from '../shared/errors.js'
import { filterText, record, text } from '../shared/validation.js'
import { Accounts } from './accounts.js'
import { Logins } from './logins.js'

function isWorkBuddy(channel: ChannelId): boolean {
  return channel === 'workbuddy-cn'
}

export class ModelAccountsService {
  readonly accounts: Accounts
  readonly catalog: ModelCatalog = { ...modelCatalog }
  onChange?: () => void
  private readonly logins: Logins
  private readonly controller = new AbortController()
  private readonly quotas = new Map<string, QuotaView>()
  private readonly fetching = new Map<string, Promise<void>>()
  /** Live model lists keyed by channel, so a repeat call within ten minutes costs no request. */
  private readonly live = new Map<ChannelId, { account: string, at: number, models: CatalogModel[] }>()
  private readonly checkins = new Map<string, CheckinView>()
  private readonly benefits = new Map<string, BenefitView[]>()
  /** Last automatic check-in sweep, so the 60s quota cycle does not hammer the endpoint. */
  private autoCheckinAt = 0
  private timer?: ReturnType<typeof setInterval>
  private cycling = false

  constructor(ctx: Context) {
    this.accounts = new Accounts(ctx.credentials, (channel, tokens, signal) => {
      if (channel === 'openai-codex')
        return refreshOpenAI(tokens, signal)
      if (channel === 'opencode-go')
        return refreshOpenCode(tokens, signal)
      if (isWorkBuddy(channel))
        return refreshWorkBuddy(tokens, signal)
      throw new Error('OAuth is not supported by this channel')
    })
    this.logins = new Logins(this.accounts, () => this.onChange?.())
  }

  async snapshot(): Promise<AccountSnapshot> {
    const views = await this.accounts.list()
    const saved = await this.accounts.quotas()
    const filter = await this.accounts.filter()
    return {
      channels,
      accounts: views.map((account) => {
        const quota = this.quotas.get(account.id) ?? saved[account.id]
        const checkin = this.checkins.get(account.id)
        const benefits = this.benefits.get(account.id)
        return {
          ...account,
          ...(quota
            ? { quota }
            : {}),
          ...(checkin
            ? { checkin }
            : {}),
          ...(benefits?.length
            ? { benefits }
            : {}),
        }
      }),
      catalog: catalogMetadata,
      filter,
    }
  }

  async activeChannels(): Promise<ChannelId[]> {
    const accounts = await this.accounts.list()
    return channels.filter(channel => accounts.some(account => account.channel === channel.id && account.active)).map(channel => channel.id)
  }

  async refreshCatalog(channel: ChannelId, signal?: AbortSignal): Promise<void> {
    const fetchModels = channel === 'openai-codex'
      ? fetchCodexModels
      : isWorkBuddy(channel)
        ? (account: StoredAccount, manual?: AbortSignal) => fetchWorkBuddyModels(account, manual)
        : undefined
    if (!fetchModels || this.controller.signal.aborted)
      return
    const account = await this.accounts.resolve(channel, signal)
    const cached = this.live.get(channel)
    if (cached?.account === account.id && Date.now() - cached.at < 10 * 60_000) {
      this.catalog[channelFor(channel).source] = cached.models
      return
    }
    const models = await fetchModels(account, signal)
    if (this.controller.signal.aborted)
      return
    this.live.set(channel, {
      account: account.id,
      at: Date.now(),
      models,
    })
    this.catalog[channelFor(channel).source] = models
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
          : isWorkBuddy(account.channel)
            ? await fetchWorkBuddyQuota(account, signal)
            : await fetchQuota(account, signal)
        if (!this.controller.signal.aborted && (await this.accounts.list()).some(account => account.id === id)) {
          this.quotas.set(id, quota)
          // Persist successful answers only; transient errors must not replace the restart cache.
          void this.accounts.saveQuota(id, quota).catch(() => {})
        }
        if (isWorkBuddy(account.channel))
          await this.refreshRewards(account, signal)
      }
      catch (error) {
        if (!this.controller.signal.aborted && (await this.accounts.list()).some(account => account.id === id)) {
          // A transient provider failure must not erase the last measurement:
          // the composer bars keep the previous windows and Settings shows the
          // error next to them, instead of both blinking out until the next
          // successful cycle.
          const previous = await this.lastGoodQuota(id)
          this.quotas.set(id, {
            status: 'error',
            fetchedAt: previous?.fetchedAt ?? new Date().toISOString(),
            windows: previous?.windows ?? [],
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

  /**
   * Read the check-in state and claimable benefits of one WorkBuddy account.
   * @param account - the resolved account; only WorkBuddy has these rewards.
   * @param signal - caller cancellation.
   */
  private async refreshRewards(account: StoredAccount, signal?: AbortSignal): Promise<void> {
    try {
      this.checkins.set(account.id, await fetchWorkBuddyCheckin(account, signal))
    }
    catch {
      // A check-in read is advisory; the credit view must survive its failure.
    }
    try {
      const benefits = await fetchWorkBuddyBenefits(account, signal)
      if (benefits.length)
        this.benefits.set(account.id, benefits)
      else
        this.benefits.delete(account.id)
    }
    catch {
      this.benefits.delete(account.id)
    }
  }

  /** Check in once, then re-read the rewards so the card shows the new balance. */
  private async claimCheckin(id: string, signal?: AbortSignal): Promise<void> {
    const view = (await this.accounts.list()).find(account => account.id === id)
    if (!view)
      throw new Error('Account not found')
    if (!isWorkBuddy(view.channel))
      throw new Error('Only WorkBuddy accounts have a daily check-in')
    const account = await this.accounts.resolve(view.channel, signal, id)
    await claimWorkBuddyCheckin(account, signal)
    await this.refreshRewards(account, signal)
    await this.refreshQuota(id, signal)
  }

  private async claimBenefits(id: string, signal?: AbortSignal): Promise<void> {
    const view = (await this.accounts.list()).find(account => account.id === id)
    if (!view)
      throw new Error('Account not found')
    if (!isWorkBuddy(view.channel))
      throw new Error('Only WorkBuddy accounts have claimable benefits')
    const account = await this.accounts.resolve(view.channel, signal, id)
    await claimWorkBuddyBenefits(account, signal)
    await this.refreshRewards(account, signal)
    await this.refreshQuota(id, signal)
  }

  /**
   * Claim the daily check-in for every WorkBuddy account that has not signed in yet.
   * Runs at start and then once per sweep interval, so a long-running app still signs in daily.
   */
  private async autoCheckin(): Promise<void> {
    if (this.cycling || Date.now() - this.autoCheckinAt < 6 * 3_600_000)
      return
    this.autoCheckinAt = Date.now()
    const accounts = await this.accounts.list()
    for (const view of accounts) {
      if (!isWorkBuddy(view.channel) || this.controller.signal.aborted)
        continue
      try {
        const account = await this.accounts.resolve(view.channel, this.controller.signal, view.id)
        const checkin = await fetchWorkBuddyCheckin(account, this.controller.signal)
        this.checkins.set(view.id, checkin)
        if (checkin.active && !checkin.checkedIn) {
          await claimWorkBuddyCheckin(account, this.controller.signal)
          this.checkins.set(view.id, await fetchWorkBuddyCheckin(account, this.controller.signal))
          await this.refreshQuota(view.id, this.controller.signal)
        }
      }
      catch { /* A failed automatic check-in is retried on the next sweep. */ }
    }
  }

  /**
   * Read the last measurement a failed refresh should keep showing.
   * @param id - account whose quota is being reported.
   * @returns the cached view, else the persisted one, else the bare cached one.
   */
  private async lastGoodQuota(id: string): Promise<QuotaView | undefined> {
    const cached = this.quotas.get(id)
    if (cached?.windows.length)
      return cached
    try {
      return (await this.accounts.quotas())[id] ?? cached
    }
    catch {
      // An unreadable store costs only the retained windows of this error report.
      return cached
    }
  }

  private async resetCredit(id: string, signal?: AbortSignal): Promise<void> {
    const view = (await this.accounts.list()).find(account => account.id === id)
    if (!view)
      throw new Error('Account not found')
    if (view.channel !== 'openai-codex')
      throw new Error('Only OpenAI Codex accounts have reset credits')
    const account = await this.accounts.resolve(view.channel, signal, id)
    await consumeCodexResetCredit(account, signal)
    await this.refreshQuota(id, signal)
  }

  async dispatch(raw: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.controller.signal.aborted)
      throw new Error('Plugin is unloading')
    const args = record(raw)
    const action = text(args.action, 'action')
    switch (action) {
      case 'list': {
        const snapshot = await this.snapshot()
        const login = this.logins.pending
        return login
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
        this.checkins.delete(id)
        this.benefits.delete(id)
        this.onChange?.()
        break
      }
      case 'reset_credit': {
        await this.resetCredit(text(args.id, 'account id'), signal)
        break
      }
      case 'checkin': {
        await this.claimCheckin(text(args.id, 'account id'), signal)
        break
      }
      case 'claim_benefits': {
        await this.claimBenefits(text(args.id, 'account id'), signal)
        break
      }
      case 'set_filter': {
        await this.accounts.saveFilter(filterText(args.filter))
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
    void this.autoCheckin()
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
    await this.autoCheckin().catch(() => {})
  }

  dispose(): void {
    this.controller.abort()
    clearInterval(this.timer)
    this.timer = undefined
    this.logins.dispose()
    this.quotas.clear()
    this.checkins.clear()
    this.benefits.clear()
  }
}
