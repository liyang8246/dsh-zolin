// @env browser
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ComponentType, ReactElement } from 'react'
import type { ChannelId } from '../shared/types.js'
import type { AccountStore, QuotaBarsProps } from './types.js'
import { activeQuota, channelOf } from './data.js'

export function createComposerQuota(
  React: typeof import('react'),
  ctx: Context,
  store: AccountStore,
  QuotaBars: ComponentType<QuotaBarsProps>,
): (props: PropsRuntime<'conversation.input.right'>) => ReactElement | null {
  // A Session reports no model selection until its projection arrives, and a
  // reloading catalog reports none at all. The channel resolved last outlives
  // both, so a new conversation keeps the bars it was already showing instead
  // of blinking them out until the selection lands.
  let lastChannel: ChannelId | undefined
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
    const current = state?.current
    // An unresolved selection falls back to the remembered channel; a resolved
    // one that belongs to no channel of this plugin (another provider) hides them.
    // No directory at all (an addressed subagent session) keeps them hidden.
    let channel: ChannelId | undefined
    if (current === null)
      channel = lastChannel
    else if (current !== undefined)
      channel = channelOf(current.provider)
    if (channel !== undefined)
      lastChannel = channel
    React.useEffect(() => {
      if (channel)
        void store.reload().catch(() => {})
    }, [channel])
    return <QuotaBars windows={activeQuota(data, channel)} />
  }
}
