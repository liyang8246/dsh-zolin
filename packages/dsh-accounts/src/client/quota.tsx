// @env browser
import type { ReactElement } from 'react'
import type { QuotaBarsProps, QuotaProps } from './types.js'
import { css } from './constants.js'
import { allWindows, leftOf, levelOf, resetTime } from './data.js'

export function createQuotaComponents(React: typeof import('react'), t: (path: string) => string) {
  const labelOf = (window: { period: string, label?: string }): string => window.period === '5h'
    ? '5h'
    : window.period === 'other'
      ? window.label ?? t('other')
      : t(window.period)

  function Quota({ quota }: QuotaProps): ReactElement {
    const windows = allWindows(quota?.windows ?? [])
    return (
      <div className={windows.length ? undefined : 'zph-quota-unavailable'}>
        {windows.length
          ? (
              <div className="zph-quota">
                {windows.map(window => (
                  <div key={`${window.period}-${window.label ?? ''}`} className="zph-window">
                    <div className="zph-window-head">
                      <span>
                        <strong>{labelOf(window)}</strong>
                        {` · ${Math.round(leftOf(window))}%`}
                      </span>
                      <span className="zph-muted">{resetTime(window.resetsAt, window.period === '5h')}</span>
                    </div>
                    <span className="zph-track" data-level={levelOf(window)} role="img" aria-label={`${labelOf(window)} ${t('left')} ${Math.round(leftOf(window))}%`}>
                      <b style={{ width: `${leftOf(window)}%` }} />
                    </span>
                    {window.used !== undefined && window.limit !== undefined && (
                      // The bar shows what is left, so the numbers beside it read the same way.
                      <div className="zph-muted">{`${t('left')} ${Math.round((window.limit - window.used) * 100) / 100} / ${window.limit} ${window.unit || ''}`}</div>
                    )}
                  </div>
                ))}
              </div>
            )
          : <p className="zph-muted">{t(quota ? 'unavailable' : 'notFetched')}</p>}
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
    const labels = windows.map(window => `${labelOf(window)} ${t('left')} ${Math.round(leftOf(window))}%`)
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

  return { Quota, QuotaBars }
}
