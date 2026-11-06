// @env browser
import type { Context } from '@deepseek-ai/cordis'
import type { ReactElement } from 'react'
import type { StatusPayload } from '../shared/types.js'
import { call } from './api.js'
import { css } from './strings.js'

/**
 * Build the settings section component.
 * @param React - React from the browser module table.
 * @param ctx - Client context carrying the locale service.
 * @param t - locale-bound translator for this plugin's namespace.
 * @returns the slot component for `settings.section`.
 */
export function createSettings(
  React: typeof import('react'),
  ctx: Context,
  t: (path: string) => string,
): () => ReactElement {
  return function CodeTimeSettings(): ReactElement {
    React.useSyncExternalStore(fn => ctx.locale.subscribe(fn), () => ctx.locale.getSnapshot())
    const [status, setStatus] = React.useState<StatusPayload | null>(null)
    const [token, setToken] = React.useState('')
    const [busy, setBusy] = React.useState(false)
    const [notice, setNotice] = React.useState('')
    const [error, setError] = React.useState('')
    const mounted = React.useRef(true)

    const apply = React.useCallback((value: StatusPayload): void => {
      if (!mounted.current)
        return
      setStatus(value)
    }, [])

    const run = React.useCallback(async (
      action: 'status' | 'save' | 'clear' | 'sync',
      payload: { token?: string, autoUpload?: boolean } = {},
      message?: string,
    ): Promise<void> => {
      setBusy(true)
      setError('')
      if (message)
        setNotice('')
      try {
        const value = await call({ action, ...payload })
        apply(value)
        if (message)
          setNotice(message)
        if (action === 'save' || action === 'clear')
          setToken('')
      }
      catch (failure) {
        if (mounted.current) {
          setError(failure instanceof Error
            ? failure.message
            : t('failed'))
        }
      }
      finally {
        if (mounted.current)
          setBusy(false)
      }
    }, [apply, t])

    React.useEffect(() => {
      mounted.current = true
      void run('status')
      return () => {
        mounted.current = false
      }
    }, [run])

    // While an upload is running or work is queued, re-read status until it settles.
    React.useEffect(() => {
      if (!status || (!status.uploading && status.pending === 0))
        return
      const timer = setTimeout(() => {
        void call({ action: 'status' }).then(apply).catch(() => {})
      }, 4_000)
      return () => clearTimeout(timer)
    }, [status, apply])

    const configured = status?.configured ?? false
    const autoUpload = status?.autoUpload ?? true

    return (
      <section className="ct-settings" aria-label={t('title')} aria-busy={busy}>
        <style>{css}</style>
        <div>
          <h2>{t('title')}</h2>
          <p className="ct-sub">{t('subtitle')}</p>
        </div>

        <div className="ct-card">
          <div>
            <p className="ct-state">
              {!status
                ? t(error ? 'unavailable' : 'loading')
                : configured
                  ? t('connected')
                  : t('notConnected')}
              {configured && status?.maskedToken && <span className="ct-badge">{status.maskedToken}</span>}
            </p>
            {status && !configured && <p className="ct-muted">{t('tokenHint')}</p>}
          </div>

          <form
            className="ct-form"
            onSubmit={(event) => {
              event.preventDefault()
              void run('save', { token }, t('saved'))
            }}
          >
            <div className="ct-inline">
              <label className="ct-grow">
                {t('tokenLabel')}
                <input
                  type="password"
                  value={token}
                  placeholder={t('tokenPlaceholder')}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={event => setToken(event.currentTarget.value)}
                />
              </label>
              <button type="submit" data-primary="true" disabled={busy || !token.trim()}>
                {t('save')}
              </button>
            </div>
            <div className="ct-actions">
              <button type="button" disabled={busy || !configured} onClick={() => { void run('sync', {}, t('uploaded')) }}>
                {t('syncNow')}
              </button>
              <button type="button" disabled={busy || !configured} onClick={() => { void run('clear', {}, t('cleared')) }}>
                {t('disconnect')}
              </button>
              <label className="ct-switch ct-spacer">
                <input
                  type="checkbox"
                  role="switch"
                  aria-checked={autoUpload}
                  disabled={busy}
                  checked={autoUpload}
                  onChange={(event) => { void run('save', { autoUpload: event.currentTarget.checked }) }}
                />
                {t('autoUpload')}
              </label>
            </div>
          </form>

          {notice && <p className="ct-ok" role="status">{notice}</p>}
          {error && <p className="ct-error" role="alert">{error}</p>}
          {status?.lastError && !error && <p className="ct-error" role="alert">{status.lastError}</p>}

          <div className="ct-stats">
            <span>{`${status?.pending ?? 0} ${t('pending')}`}</span>
            <span>{`${status?.sessions ?? 0} ${t('sessions')}`}</span>
            <span>
              {`${t('lastUpload')}: ${status?.lastUploadAt
                ? new Date(status.lastUploadAt).toLocaleString()
                : t('never')}`}
            </span>
            {status?.machineId && <span>{`${t('machine')}: ${status.machineId.slice(0, 8)}`}</span>}
          </div>
        </div>
      </section>
    )
  }
}
