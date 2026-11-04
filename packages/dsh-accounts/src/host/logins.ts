import type { ChannelId, LoginAttempt, LoginInteraction, LoginNotice, LoginView, OAuthTokens } from '../shared/types.js'
// @env node
import type { Accounts } from './accounts.js'
import { randomUUID } from 'node:crypto'
import { loginOpenAI } from '../providers/openai.js'
import { loginOpenCode } from '../providers/opencode.js'
import { loginWorkBuddy } from '../providers/workbuddy.js'
import { channelFor } from '../shared/channels.js'
import { text } from '../shared/validation.js'

/** Hosts a channel's sign-in page may live on; anything else is refused before the UI sees it. */
const authorizationHosts: Record<ChannelId, readonly string[]> = {
  'openai-codex': [
    'auth.openai.com',
    'chatgpt.com',
  ],
  'opencode-go': [
    'opencode.ai',
  ],
  'commandcode-go': [],
  'workbuddy-cn': [
    'www.codebuddy.cn',
  ],
}

function loginFor(channel: ChannelId): (interaction: LoginInteraction) => Promise<OAuthTokens> {
  if (channel === 'openai-codex')
    return loginOpenAI
  if (channel === 'opencode-go')
    return loginOpenCode
  return loginWorkBuddy
}

function view(attempt: LoginAttempt): LoginView {
  return {
    id: attempt.id,
    channel: attempt.channel,
    status: attempt.status,
    ...(attempt.notice
      ? {
          notice: { ...attempt.notice },
        }
      : {}),
    ...(attempt.error
      ? { error: attempt.error }
      : {}),
  }
}

export class Logins {
  private readonly attempts = new Map<string, LoginAttempt>()
  private disposed = false

  constructor(private readonly accounts: Accounts, private readonly onChange: () => void) {}

  get pending(): LoginView | undefined {
    const attempt = [
      ...this.attempts.values(),
    ].find(attempt => attempt.status === 'pending')
    return attempt
      ? view(attempt)
      : undefined
  }

  dispatch(action: string, args: Record<string, unknown>): LoginView {
    if (this.disposed)
      throw new Error('Plugin is unloading')
    if (action === 'login_start')
      return this.begin(channelFor(args.channel).id, text(args.label, 'account label'))
    if (!['login_cancel', 'login_status'].includes(action))
      throw new Error('Unknown login action')
    const attempt = this.attempts.get(text(args.attemptId, 'login attempt id'))
    if (!attempt)
      throw new Error('Login attempt expired; start again')
    if (action === 'login_cancel' && attempt.status === 'pending')
      attempt.controller.abort(new Error('Login cancelled'))
    return view(attempt)
  }

  private begin(channel: ChannelId, label: string): LoginView {
    if (!channelFor(channel).auth.includes('oauth'))
      throw new Error('This channel does not support OAuth')
    if ([
      ...this.attempts.values(),
    ].some(attempt => attempt.channel === channel && attempt.status === 'pending')) {
      throw new Error('A login for this channel is already running')
    }
    for (const [id, attempt] of this.attempts) {
      if (attempt.status !== 'pending')
        this.attempts.delete(id)
    }
    const attempt: LoginAttempt = {
      id: randomUUID(),
      channel,
      status: 'pending',
      controller: new AbortController(),
    }
    this.attempts.set(attempt.id, attempt)
    const signal = attempt.controller.signal
    const clear = (): void => {
      delete attempt.notice
    }
    const timer = setTimeout(() => attempt.controller.abort(new Error('Login timed out')), 15 * 60_000)
    timer.unref()
    const cancel = (): void => {
      clearTimeout(timer)
      attempt.status = 'cancelled'
      clear()
    }
    signal.addEventListener('abort', cancel, { once: true })
    const interaction: LoginInteraction = {
      signal,
      notify: notice => this.notify(attempt, notice),
      prompt: message => this.prompt(attempt, message),
    }
    void this.run(attempt, label, interaction).finally(() => {
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
      clear()
    })
    return view(attempt)
  }

  private async run(attempt: LoginAttempt, label: string, interaction: LoginInteraction): Promise<void> {
    try {
      const login = loginFor(attempt.channel)
      const tokens = await login(interaction)
      interaction.signal.throwIfAborted()
      await this.accounts.add(attempt.channel, label, { kind: 'oauth', tokens })
      attempt.status = 'authorized'
    }
    catch {
      attempt.status = interaction.signal.aborted ? 'cancelled' : 'error'
      if (attempt.status === 'error')
        attempt.error = 'Sign-in failed; try again'
      return
    }
    // A committed credential must not look failed because a route observer throws.
    try {
      this.onChange()
    }
    catch {}
  }

  private notify(attempt: LoginAttempt, notice: LoginNotice): void {
    attempt.controller.signal.throwIfAborted()
    const next: LoginNotice = {}
    if (notice.url) {
      const url = new URL(text(notice.url, 'authorization URL', 8192))
      const allowed = authorizationHosts[attempt.channel]
      if (url.protocol !== 'https:' || !allowed.includes(url.hostname) || url.port || url.username || url.password)
        throw new Error('Unexpected OAuth authorization URL')
      next.url = url.href
    }
    if (notice.code)
      next.code = text(notice.code, 'authorization code')
    if (notice.message)
      next.message = text(notice.message, 'login notice', 2048)
    attempt.notice = next
  }

  /**
   * The panel offers no free-text input any more, so a flow that needs one fails fast
   * instead of holding the attempt open until its fifteen-minute deadline.
   */
  private async prompt(attempt: LoginAttempt, message: string): Promise<string> {
    attempt.controller.signal.throwIfAborted()
    throw new Error(`This sign-in needs manual input (${message}); sign in inside the provider's own app instead`)
  }

  dispose(): void {
    this.disposed = true
    for (const attempt of this.attempts.values()) {
      if (attempt.status === 'pending')
        attempt.controller.abort(new Error('Plugin unloaded'))
    }
    this.attempts.clear()
  }
}
