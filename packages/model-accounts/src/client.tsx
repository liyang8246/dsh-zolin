// @env browser
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { DshWindow } from '@deepseek-ai/dsh-client-modules/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReactElement } from 'react'
import type { ClientRequest, LoginRequest, QuotaBarsProps, QuotaProps, SnapshotRequest } from './client/types.js'
import type { AccountSnapshot, ChannelId, LoginView } from './types.js'
import { css, en, zh } from './client/constants.js'
import { activeQuota, authorizationURL, channelOf, isLoginRequest, isObject, leftOf, levelOf, measuredWindows, readLogin, readSnapshot, resetTime } from './client/data.js'
import { createAccountStore } from './client/store.js'

const dshWindow: Window & DshWindow = window
const loader = dshWindow.__ModuleLoader__
if (!loader || typeof loader.load !== 'function')
  throw new Error('Harness module loader is unavailable')

loader.load({
  id: 'dsh-model-accounts',
  factory(require) {
    const React = require('react') as typeof import('react')
    return {
      inject: ['slots', 'locale', 'modelDirectories'],
      apply(ctx: Context): void {
        ctx.effect(() => ctx.locale.register('zephyr-accounts', 'en', en))
        ctx.effect(() => ctx.locale.register('zephyr-accounts', 'zh', zh))
        const t = ctx.locale.bind('zephyr-accounts')

        async function call(request: SnapshotRequest, signal?: AbortSignal): Promise<AccountSnapshot>
        async function call(request: LoginRequest, signal?: AbortSignal): Promise<LoginView>
        async function call(request: ClientRequest, signal?: AbortSignal): Promise<AccountSnapshot | LoginView>
        async function call(request: ClientRequest, signal?: AbortSignal): Promise<AccountSnapshot | LoginView> {
          const response = await fetch(new URL('api/zephyr-models', document.baseURI), {
            method: 'POST',
            credentials: 'same-origin',
            redirect: 'error',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(request),
            signal,
          })
          const value: unknown = await response.json()
          signal?.throwIfAborted()
          const error = isObject(value) && typeof value.error === 'string'
            ? value.error
            : undefined
          if (!response.ok || (error && isObject(value) && !('status' in value)))
            throw new Error(error || `HTTP ${response.status}`)
          return isLoginRequest(request)
            ? readLogin(value)
            : readSnapshot(value)
        }

        const store = createAccountStore(() => call({ action: 'list' }))
        ctx.effect(() => () => store.dispose())
        const errorMessage = (error: unknown): string => error instanceof Error
          ? error.message
          : t('failed')

        function Quota({ quota }: QuotaProps): ReactElement {
          const windows = quota?.status === 'ok'
            ? measuredWindows(quota.windows)
            : []
          return (
            <div>
              {windows.length
                ? (
                    <div className="zph-quota">
                      {windows.map(window => (
                        <div key={window.period} className="zph-window">
                          <div className="zph-window-head">
                            <span>
                              <strong>
                                {window.period === '5h'
                                  ? '5h'
                                  : t(window.period)}
                              </strong>
                              {` · ${Math.round(leftOf(window))}%`}
                            </span>
                            <span className="zph-muted">{resetTime(window.resetsAt, window.period === '5h')}</span>
                          </div>
                          <span className="zph-track" data-level={levelOf(window)} role="img" aria-label={`${window.period} ${t('left')} ${Math.round(leftOf(window))}%`}>
                            <b style={{ width: `${leftOf(window)}%` }} />
                          </span>
                          {window.used !== undefined && window.limit !== undefined && (
                            <div className="zph-muted">{`${window.used} / ${window.limit} ${window.unit || ''}`}</div>
                          )}
                        </div>
                      ))}
                    </div>
                  )
                : <p className="zph-muted">{t(quota ? 'unavailable' : 'notFetched')}</p>}
              {quota?.status === 'ok' && quota.windows.filter(window => window.period === 'other').map((window, index) => (
                <div className="zph-muted" key={index}>{`${window.label || t('other')}: ${window.usedPercent?.toFixed(1) ?? '—'}% ${t('used')}`}</div>
              ))}
              {quota?.reason && (
                <p className={quota.status === 'error'
                  ? 'zph-error'
                  : 'zph-muted'}
                >
                  {quota.reason}
                </p>
              )}
            </div>
          )
        }

        function QuotaBars({ windows }: QuotaBarsProps): ReactElement | null {
          if (!windows.length)
            return null
          const labels = windows.map(window => `${window.period === '5h'
            ? '5h'
            : t(window.period)} ${t('left')} ${Math.round(leftOf(window))}%`)
          return (
            <span className="zph-composer-quota" role="img" data-count={windows.length} title={labels.join(' · ')} aria-label={labels.join(', ')}>
              <style>{css}</style>
              {windows.map(window => (
                <span key={window.period} className="zph-track" data-level={levelOf(window)}>
                  <b style={{ width: `${leftOf(window)}%` }} />
                </span>
              ))}
            </span>
          )
        }

        function ComposerQuota({ sessionId }: PropsRuntime<'conversation.input.right'>): ReactElement | null {
          React.useSyncExternalStore(fn => ctx.locale.subscribe(fn), () => ctx.locale.getSnapshot())
          const models = ctx.get('modelDirectories')
          const modelStore = React.useMemo(() => {
            try {
              return models?.directoryFor(sessionId).store
            }
            catch {
              return undefined
            }
          }, [models, sessionId])
          const state = React.useSyncExternalStore(
            React.useCallback(listener => modelStore
              ? modelStore.subscribe(listener)
              : () => {}, [modelStore]),
            React.useCallback(() => modelStore?.getSnapshot(), [modelStore]),
          )
          const data = React.useSyncExternalStore(store.subscribe, store.getSnapshot)
          const channel = channelOf(state?.current?.provider)
          React.useEffect(() => {
            if (channel)
              void store.reload().catch(() => {})
          }, [channel])
          return <QuotaBars windows={activeQuota(data, channel)} />
        }

        function AccountsPage(): ReactElement {
          React.useSyncExternalStore(fn => ctx.locale.subscribe(fn), () => ctx.locale.getSnapshot())
          const data = React.useSyncExternalStore(store.subscribe, store.getSnapshot)
          const [busy, setBusy] = React.useState(false)
          const [error, setError] = React.useState('')
          const [form, setForm] = React.useState<ChannelId | null>(null)
          const [label, setLabel] = React.useState('')
          const [apiKey, setApiKey] = React.useState('')
          const [login, setLogin] = React.useState<LoginView | null>(null)
          const [answer, setAnswer] = React.useState('')
          const [paste, setPaste] = React.useState(false)
          const [removing, setRemoving] = React.useState<string | null>(null)
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
            setAnswer('')
            setPaste(false)
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
                if (mounted.current && request.action === 'add_key') {
                  setApiKey('')
                  setForm(null)
                }
              }
              else if (mounted.current) {
                if (request.action === 'login_cancel') {
                  setLogin(null)
                  setForm(null)
                  setAnswer('')
                  setPaste(false)
                }
                else if (value.status === 'pending') {
                  setLogin(value)
                  if (request.action === 'login_start') {
                    setPaste(false)
                    setAnswer('')
                  }
                  if (request.action === 'login_reply') {
                    setAnswer('')
                    setPaste(false)
                  }
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
                {url && <a href={url} target="_blank" rel="noreferrer noopener">{t('open')}</a>}
                {value.notice?.code && (
                  <span>
                    {`${t('code')}: `}
                    <code>{value.notice.code}</code>
                  </span>
                )}
                {value.prompt && !paste && <button type="button" className="zph-link" onClick={() => setPaste(true)}>{t('paste')}</button>}
                {value.prompt && paste && (
                  <form
                    className="zph-row"
                    onSubmit={(event) => {
                      event.preventDefault()
                      void run({ action: 'login_reply', attemptId: value.id, answer })
                    }}
                  >
                    <input value={answer} required maxLength={8192} autoComplete="off" placeholder={value.prompt} aria-label={value.prompt} onChange={event => setAnswer(event.currentTarget.value)} />
                    <button type="submit" disabled={busy || !answer.trim()}>{t('reply')}</button>
                  </form>
                )}
                {button(t('cancel'), { action: 'login_cancel', attemptId: value.id })}
              </div>
            )
          }

          return (
            <section className="zph-accounts" aria-label={t('title')} aria-busy={busy}>
              <style>{css}</style>
              <div className="zph-row zph-between">
                <h2>{t('title')}</h2>
                {button(t('refreshAll'), { action: 'refresh_quota' })}
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
                            {removing === account.id && (
                              <div id={`zph-remove-${account.id}`} className="zph-row" role="group" aria-label={t('confirmRemove')}>
                                <span>{t('confirmRemove')}</span>
                                {button(t('remove'), { action: 'remove', id: account.id })}
                                <button type="button" disabled={busy} onClick={() => setRemoving(null)}>{t('cancel')}</button>
                              </div>
                            )}
                            <Quota quota={account.quota} />
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
                              setAnswer('')
                              setPaste(false)
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

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'zephyr-accounts',
          order: 12,
          label: () => t('title'),
        }, AccountsPage))
        ctx.slots.inject('conversation.input.right', () => ctx.slots.register({ name: 'conversation.input.right', id: 'zephyr-quota' }, ComposerQuota))
      },
    }
  },
})
