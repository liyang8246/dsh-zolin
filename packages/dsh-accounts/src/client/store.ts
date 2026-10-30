import type { AccountSnapshot } from '../shared/types.js'
import type { AccountStore } from './types.js'

export function createAccountStore(load: () => Promise<AccountSnapshot>): AccountStore {
  let snapshot: AccountSnapshot | undefined
  let pending: Promise<AccountSnapshot> | undefined
  let revision = 0
  let disposed = false
  let timer: ReturnType<typeof setInterval> | undefined
  const listeners = new Set<() => void>()
  const stopPolling = (): void => {
    if (timer !== undefined)
      clearInterval(timer)
    timer = undefined
  }
  const notify = (value: AccountSnapshot): void => {
    if (disposed)
      return
    snapshot = value
    for (const listener of listeners) listener()
  }
  const publish = (value: AccountSnapshot): void => {
    revision++
    notify(value)
  }
  const store: AccountStore = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed)
        return () => {}
      listeners.add(listener)
      // Only read the Host's snapshot; provider quota refresh belongs to the Host.
      timer ??= setInterval(() => {
        void store.reload().catch(() => {})
      }, 60_000)
      return () => {
        listeners.delete(listener)
        if (!listeners.size)
          stopPolling()
      }
    },
    publish,
    async update(operation) {
      if (disposed)
        throw new Error('Model Accounts is unloading')
      const started = ++revision
      const value = await operation()
      if (revision === started)
        publish(value)
      return snapshot ?? value
    },
    reload() {
      if (disposed)
        return Promise.reject(new Error('Model Accounts is unloading'))
      if (pending)
        return pending
      const started = revision
      pending = load().then((value) => {
        // Reads must neither overwrite a mutation nor invalidate one still in flight.
        if (revision === started)
          notify(value)
        return snapshot ?? value
      }).finally(() => { pending = undefined })
      return pending
    },
    dispose() {
      disposed = true
      revision++
      stopPolling()
      listeners.clear()
    },
  }
  return store
}
