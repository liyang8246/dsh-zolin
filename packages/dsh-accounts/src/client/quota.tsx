// @env browser
import type { ReactElement } from 'react'
import type { QuotaBarsProps, QuotaProps } from './types.js'
import { css } from './constants.js'
import { leftOf, levelOf, measuredWindows, resetTime } from './data.js'

export function createQuotaComponents(React: typeof import('react'), t: (path: string) => string) {
  function Quota({ quota }: QuotaProps): ReactElement {
    const windows = quota?.status === 'ok'
      ? measuredWindows(quota.windows)
      : []
    return (
      <div className={windows.length ? undefined : 'zph-quota-unavailable'}>
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

  return { Quota, QuotaBars }
}
