// @env browser
import type { Context } from '@deepseek-ai/cordis'
import type { ComponentType, ReactElement } from 'react'
import type { ChannelId, LoginView } from '../shared/types.js'
import type { ModelFilter } from './model-filter.js'
import type { AccountStore, ClientRequest, QuotaProps } from './types.js'
import { call } from './api.js'
import { css } from './constants.js'
import { authorizationURL, isLoginRequest } from './data.js'

export function createAccountsPage(
  React: typeof import('react'),
  ctx: Context,
  store: AccountStore,
  t: (path: string) => string,
  Quota: ComponentType<QuotaProps>,
  filter: ModelFilter,
): () => ReactElement {
  const errorMessage = (error: unknown): string => error instanceof Error
    ? error.message
    : t('failed')

  return function AccountsPage(): ReactElement {
    React.useSyncExternalStore(fn => ctx.locale.subscribe(fn), () => ctx.locale.getSnapshot())
    const data = React.useSyncExternalStore(store.subscribe, store.getSnapshot)
    const filterText = React.useSyncExternalStore(filter.subscribe, filter.getSnapshot)
    const [busy, setBusy] = React.useState(false)
    const [error, setError] = React.useState('')
    const [form, setForm] = React.useState<ChannelId | null>(null)
    const [label, setLabel] = React.useState('')
    const [apiKey, setApiKey] = React.useState('')
    const [login, setLogin] = React.useState<LoginView | null>(null)
    const [copied, setCopied] = React.useState(false)
    const [removing, setRemoving] = React.useState<string | null>(null)
    const [resetting, setResetting] = React.useState<string | null>(null)
    const mounted = React.useRef(true)
    React.useEffect(() => {
      mounted.current = true
      void store.reload().then((value) => {
        if (!mounted.current)
          return
        setLogin(value.login ?? null)
        if (value.login?.status === 'pending')
          setForm(value.login.channel)
      }).catch((error: unknown) => {
        if (mounted.current)
          setError(errorMessage(error))
      })
      return () => {
        mounted.current = false
      }
    }, [])

    const finishLogin = React.useCallback(async (value: LoginView, signal?: AbortSignal): Promise<void> => {
      if (value.status === 'authorized') {
        await store.update(() => call({ action: 'refresh_quota' }, signal).catch((error: unknown) => {
          if (signal?.aborted)
            throw error
          return call({ action: 'list' }, signal)
        }))
      }
      if (!mounted.current || signal?.aborted)
        return
      if (value.error)
        setError(value.error)
      setLogin(null)
      setForm(null)
    }, [])

    React.useEffect(() => {
      if (login?.status !== 'pending')
        return
      const attemptId = login.id
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout>
      async function poll(): Promise<void> {
        try {
          const value = await call({ action: 'login_status', attemptId }, controller.signal)
          if (controller.signal.aborted)
            return
          if (value.status === 'pending') {
            setLogin(value)
            timer = setTimeout(() => {
              void poll()
            }, 1000)
            return
          }
          await finishLogin(value, controller.signal)
        }
        catch (error) {
          if (!controller.signal.aborted) {
            setError(errorMessage(error))
            setLogin(null)
          }
        }
      }
      timer = setTimeout(() => {
        void poll()
      }, 500)
      return () => {
        clearTimeout(timer)
        controller.abort()
      }
    }, [login?.id, login?.status, finishLogin])

    async function run(request: ClientRequest): Promise<void> {
      setBusy(true)
      setError('')
      try {
        const value = isLoginRequest(request)
          ? await call(request)
          : await store.update(() => call(request))
        if ('accounts' in value) {
          if (mounted.current && request.action === 'remove')
            setRemoving(null)
          if (mounted.current && request.action === 'reset_credit')
            setResetting(null)
          if (mounted.current && request.action === 'add_key') {
            setApiKey('')
            setForm(null)
          }
        }
        else if (mounted.current) {
          if (request.action === 'login_cancel') {
            setLogin(null)
            setForm(null)
          }
          else if (value.status === 'pending') {
            setLogin(value)
          }
          else {
            await finishLogin(value)
          }
        }
      }
      catch (error) {
        if (mounted.current)
          setError(errorMessage(error))
      }
      finally {
        if (mounted.current)
          setBusy(false)
      }
    }

    function button(caption: string, request: ClientRequest, disabled = busy): ReactElement {
      return (
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            void run(request)
          }}
        >
          {caption}
        </button>
      )
    }

    function loginPanel(value: LoginView): ReactElement {
      const url = authorizationURL(value)
      return (
        <div className="zph-login" role="status">
          <strong>{t('pending')}</strong>
          {url && (
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(url).then(() => {
                  setCopied(true)
                  setTimeout(setCopied, 2_000, false)
                }).catch(() => setError(t('copyFailed')))
              }}
            >
              {copied
                ? t('copied')
                : t('copyLink')}
            </button>
          )}
          {value.notice?.code && (
            <span>
              {`${t('code')}: `}
              <code>{value.notice.code}</code>
            </span>
          )}
          {button(t('cancel'), { action: 'login_cancel', attemptId: value.id })}
        </div>
      )
    }

    return (
      <section className="zph-accounts" aria-label={t('title')} aria-busy={busy}>
        <style>{css}</style>
        <h2>{t('title')}</h2>
        <div className="zph-filter">
          <label>
            <span>{t('modelFilter')}</span>
            <input
              type="text"
              value={filterText}
              placeholder={t('modelFilterPlaceholder')}
              autoComplete="off"
              spellCheck={false}
              onChange={event => filter.setText(event.currentTarget.value)}
            />
          </label>
          <p className="zph-muted">{t('modelFilterHint')}</p>
        </div>
        {error && <p role="alert" className="zph-error">{error}</p>}
        {!data
          ? <p role="status">{t('loading')}</p>
          : data.channels.map((channel) => {
              const accounts = data.accounts.filter(account => account.channel === channel.id)
              const active = accounts.find(account => account.active)
              const first = accounts[0]
              return (
                <div key={channel.id} className="zph-channel">
                  <div className="zph-head zph-row zph-between">
                    <h3>{channel.name}</h3>
                    <label className="zph-switch">
                      <input
                        type="checkbox"
                        role="switch"
                        aria-label={channel.name}
                        checked={Boolean(active)}
                        disabled={busy || !first}
                        onChange={() => {
                          if (active)
                            void run({ action: 'deactivate', channel: channel.id })
                          else if (first)
                            void run({ action: 'activate', channel: channel.id, id: first.id })
                        }}
                      />
                    </label>
                  </div>
                  {accounts.map(account => (
                    <article key={account.id} className="zph-account">
                      <div className="zph-row">
                        <label>
                          <input type="radio" name={`zph-${channel.id}`} checked={account.active} disabled={busy} onChange={() => { void run({ action: 'activate', channel: channel.id, id: account.id }) }} />
                          <strong>{account.label}</strong>
                        </label>
                        {account.quota?.plan && <span className="zph-pill">{account.quota.plan}</span>}
                        <div className="zph-actions">
                          {typeof account.quota?.resetCredits === 'number' && (
                            <button
                              type="button"
                              disabled={busy || !account.quota.resetCredits}
                              aria-expanded={resetting === account.id}
                              aria-controls={`zph-reset-${account.id}`}
                              onClick={() => setResetting(account.id)}
                            >
                              {`${t('resetCredit')} (${account.quota.resetCredits})`}
                            </button>
                          )}
                          {button(t('refresh'), { action: 'refresh_quota', id: account.id })}
                          <button
                            type="button"
                            disabled={busy}
                            aria-expanded={removing === account.id}
                            aria-controls={`zph-remove-${account.id}`}
                            onClick={() => setRemoving(account.id)}
                          >
                            {t('remove')}
                          </button>
                        </div>
                      </div>
                      {resetting === account.id && (
                        <div id={`zph-reset-${account.id}`} className="zph-row" role="group" aria-label={t('confirmResetCredit')}>
                          <span>{t('confirmResetCredit')}</span>
                          {button(t('resetCredit'), { action: 'reset_credit', id: account.id })}
                          <button type="button" disabled={busy} onClick={() => setResetting(null)}>{t('cancel')}</button>
                        </div>
                      )}
                      {removing === account.id && (
                        <div id={`zph-remove-${account.id}`} className="zph-row" role="group" aria-label={t('confirmRemove')}>
                          <span>{t('confirmRemove')}</span>
                          {button(t('remove'), { action: 'remove', id: account.id })}
                          <button type="button" disabled={busy} onClick={() => setRemoving(null)}>{t('cancel')}</button>
                        </div>
                      )}
                      <Quota quota={account.quota} />
                      {account.checkin?.active && (
                        <div className="zph-row">
                          <span className="zph-muted">
                            {`${t('checkin')} · ${account.checkin.checkedIn
                              ? t('checkedIn')
                              : t('notCheckedIn')}`}
                            {` · +${account.checkin.dailyCredit} · ${t('streak')} ${account.checkin.streakDays}${t('days')}`}
                            {account.checkin.weekProgress
                              ? ` · ${t('weekProgress')} ${account.checkin.weekProgress.filter(Boolean).length}/7`
                              : ''}
                          </span>
                          {!account.checkin.checkedIn && button(t('checkin'), { action: 'checkin', id: account.id })}
                        </div>
                      )}
                      {Boolean(account.benefits?.length) && button(`${t('claimBenefits')} (${account.benefits?.length})`, { action: 'claim_benefits', id: account.id })}
                    </article>
                  ))}
                  {!accounts.length && <p className="zph-account zph-muted">{t('empty')}</p>}
                  <div className="zph-add">
                    <button
                      type="button"
                      disabled={busy || (login?.status === 'pending' && login.channel !== channel.id)}
                      onClick={() => {
                        if (form === channel.id && login?.channel === channel.id && login.status === 'pending') {
                          void run({ action: 'login_cancel', attemptId: login.id })
                          return
                        }
                        setForm(form === channel.id
                          ? null
                          : channel.id)
                        setLabel('')
                        setApiKey('')
                      }}
                    >
                      {form === channel.id
                        ? t('cancel')
                        : t('add')}
                    </button>
                    {form === channel.id && (
                      <>
                        <form
                          className="zph-form"
                          onSubmit={(event) => {
                            event.preventDefault()
                            if (channel.auth.includes('api-key')) {
                              void run({
                                action: 'add_key',
                                channel: channel.id,
                                label,
                                key: apiKey,
                              })
                            }
                          }}
                        >
                          <div className="zph-row zph-align-end">
                            <label className="zph-grow">
                              {t('label')}
                              <input value={label} maxLength={160} required autoComplete="off" onChange={event => setLabel(event.currentTarget.value)} />
                            </label>
                            {channel.auth.includes('oauth') && button(t('login'), { action: 'login_start', channel: channel.id, label }, busy || !label.trim() || login?.status === 'pending')}
                          </div>
                          {channel.auth.includes('api-key') && (
                            <div className="zph-row zph-align-end">
                              <label className="zph-grow">
                                {t('key')}
                                <input type="password" value={apiKey} required maxLength={32768} autoComplete="off" spellCheck={false} onChange={event => setApiKey(event.currentTarget.value)} />
                              </label>
                              <button type="submit" disabled={busy || !label.trim() || !apiKey.trim()}>{t('save')}</button>
                            </div>
                          )}
                        </form>
                        {login?.channel === channel.id && loginPanel(login)}
                      </>
                    )}
                  </div>
                </div>
              )
            })}
      </section>
    )
  }
}
