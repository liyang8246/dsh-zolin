import type { ChannelId, LoginAttempt, LoginInteraction, LoginNotice, LoginView } from '../shared/types.js'
// @env node
import type { Accounts } from './accounts.js'
import { randomUUID } from 'node:crypto'
import { loginOpenAI } from '../providers/openai.js'
import { loginOpenCode } from '../providers/opencode.js'
import { channelFor } from '../shared/channels.js'
import { text } from '../shared/validation.js'

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
    ...(attempt.prompt
      ? { prompt: attempt.prompt }
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
    if (!['login_reply', 'login_cancel', 'login_status'].includes(action))
      throw new Error('Unknown login action')
    const attempt = this.attempts.get(text(args.attemptId, 'login attempt id'))
    if (!attempt)
      throw new Error('Login attempt expired; start again')
    if (action === 'login_cancel' && attempt.status === 'pending')
      attempt.controller.abort(new Error('Login cancelled'))
    if (action === 'login_reply') {
      if (attempt.status !== 'pending' || !attempt.reply)
        throw new Error('Login is not waiting for input')
      attempt.reply(text(args.answer, 'login answer', 8192))
    }
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
      delete attempt.prompt
      delete attempt.reply
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
      prompt: (message, manual) => this.prompt(attempt, message, manual),
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
      const login = attempt.channel === 'openai-codex'
        ? loginOpenAI
        : loginOpenCode
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
      const allowed = attempt.channel === 'openai-codex'
        ? ['auth.openai.com', 'chatgpt.com']
        : ['opencode.ai']
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

  private prompt(attempt: LoginAttempt, message: string, manual?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      const signal = AbortSignal.any([
        attempt.controller.signal,
        ...(manual
          ? [manual]
          : []),
      ])
      if (signal.aborted) {
        reject(signal.reason)
        return
      }
      if (attempt.reply) {
        reject(new Error('Login is already waiting for input'))
        return
      }
      function clear(): void {
        signal.removeEventListener('abort', abort)
        delete attempt.reply
        delete attempt.prompt
      }
      function abort(): void {
        clear()
        reject(signal.reason)
      }
      attempt.prompt = message
      attempt.reply = (answer) => {
        clear()
        resolve(answer)
      }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted)
        abort()
    })
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
