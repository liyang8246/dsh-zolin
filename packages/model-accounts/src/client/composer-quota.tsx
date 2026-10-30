// @env browser
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ComponentType, ReactElement } from 'react'
import type { AccountStore, QuotaBarsProps } from './types.js'
import { activeQuota, channelOf } from './data.js'

export function createComposerQuota(
  React: typeof import('react'),
  ctx: Context,
  store: AccountStore,
  QuotaBars: ComponentType<QuotaBarsProps>,
): (props: PropsRuntime<'conversation.input.right'>) => ReactElement | null {
  return function ComposerQuota({ sessionId }: PropsRuntime<'conversation.input.right'>): ReactElement | null {
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
}
