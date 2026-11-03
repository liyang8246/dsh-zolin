// @env browser
import type { Context } from '@deepseek-ai/cordis'
import type { ModelDirectory, ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'

/** Typing must not write the credential record per keystroke. */
const saveDelay = 400

/** A catalog model as the filter reads it. */
interface CatalogModel {
  id: string
  name: string
}

/** A provider group as the filter reads it. */
interface CatalogGroup {
  id: string
  name: string
  models: readonly CatalogModel[]
}

/** Composer model-name filter: the keyword text, its parsed form, and the Host-saved value. */
export interface ModelFilter {
  getSnapshot: () => string
  subscribe: (listener: () => void) => () => void
  setText: (text: string) => void
  hydrate: (text: string) => void
  keywords: () => readonly string[]
  dispose: () => void
}

export function keywordsOf(text: string): readonly string[] {
  return [
    ...new Set(text.toLowerCase().split(/\s+/).filter(Boolean)),
  ]
}

/**
 * Create the composer model filter.
 * @param save - persists a settled text change; typing alone never reaches it.
 * @returns the filter, hydrated once from the Host's saved text.
 */
export function createModelFilter(save?: (text: string) => void): ModelFilter {
  const listeners = new Set<() => void>()
  let text = ''
  let parsed: readonly string[] = []
  let hydrated = false
  let dirty = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const publish = (): void => {
    for (const listener of [...listeners]) listener()
  }
  return {
    getSnapshot: () => text,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    hydrate(value) {
      if (hydrated)
        return
      hydrated = true
      // A late answer must not discard what was typed while it was in flight.
      const next = value.trim()
      if (dirty || next === text)
        return
      text = next
      parsed = keywordsOf(next)
      publish()
    },
    setText(next) {
      // The input owns the exact text: trailing spaces must survive typing, they are separators only for parsing.
      const value = next.replace(/[\r\n\t]+/g, ' ')
      dirty = true
      if (value === text)
        return
      text = value
      parsed = keywordsOf(value)
      publish()
      if (timer !== undefined)
        clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        save?.(value.trim())
      }, saveDelay)
    },
    keywords: () => parsed,
    dispose() {
      if (timer !== undefined)
        clearTimeout(timer)
      timer = undefined
      listeners.clear()
    },
  }
}

function matches(name: string, keywords: readonly string[]): boolean {
  const lower = name.toLowerCase()
  return keywords.some(keyword => lower.includes(keyword))
}

/**
 * Keep only models whose name contains one of the keywords.
 * @param state - the session's model directory snapshot.
 * @param keywords - lowercase keywords; empty keeps everything.
 * @returns the snapshot with filtered provider groups; the selected model stays visible so the composer trigger keeps naming the model in use.
 */
export function filterModels(state: ModelDirectoryState, keywords: readonly string[]): ModelDirectoryState {
  if (!keywords.length)
    return state
  const groups = state.groups.map(group => ({
    ...group,
    models: group.models.filter((model: CatalogModel) => matches(model.name, keywords)),
  }))
  const { current } = state
  if (current !== null) {
    const source = state.groups.find((group: CatalogGroup) => group.id === current.provider)
    const model = source?.models.find((item: CatalogModel) => item.id === current.model)
    if (source !== undefined && model !== undefined) {
      const target = groups.find((group: CatalogGroup) => group.id === source.id)
      if (target === undefined) {
        groups.push({
          ...source,
          models: [model],
        })
      }
      else if (!target.models.some((item: CatalogModel) => item.id === model.id)) {
        target.models = [...target.models, model]
      }
    }
  }
  return {
    ...state,
    groups: groups.filter((group: CatalogGroup) => group.models.length > 0),
  }
}

/**
 * Filter every session model directory the composer seat and /model popup share.
 * Both entries read the directory's store, so the filter sits on the store
 * instead of on either surface.
 * @param ctx - client root context.
 * @param filter - the page-owned keyword filter.
 */
export function installModelFilter(ctx: Context, filter: ModelFilter): void {
  const models = ctx.get('modelDirectories')
  if (models === undefined)
    return
  const original = models.directoryFor
  const patched = new WeakSet<ModelDirectory>()
  models.directoryFor = (sessionId) => {
    const directory = original.call(models, sessionId)
    if (!patched.has(directory)) {
      patched.add(directory)
      try {
        filterDirectory(directory, filter)
      }
      catch {
        // A directory this Host's fields do not allow wrapping keeps its full model list; filtering is advisory.
      }
    }
    return directory
  }
  ctx.effect(() => () => {
    models.directoryFor = original
  })
}

function filterDirectory(directory: ModelDirectory, filter: ModelFilter): void {
  const source = directory.store
  let cache: { snapshot: ModelDirectoryState, key: string, value: ModelDirectoryState } | undefined
  // Reads must return one stable object per state so React's store subscription settles.
  const read = (): ModelDirectoryState => {
    const snapshot = source.getSnapshot()
    const key = filter.getSnapshot()
    if (cache === undefined || cache.snapshot !== snapshot || cache.key !== key) {
      let value: ModelDirectoryState
      try {
        value = filterModels(snapshot, filter.keywords())
      }
      catch {
        // Never let a catalog the filter cannot read take the model seat down with it.
        value = snapshot
      }
      cache = { snapshot, key, value }
    }
    return cache.value
  }
  const wrapped = {
    getSnapshot: read,
    subscribe(listener: () => void) {
      const stopSource = source.subscribe(listener)
      const stopFilter = filter.subscribe(listener)
      return () => {
        stopSource()
        stopFilter()
      }
    },
    set: (next: ModelDirectoryState) => {
      source.set(next)
    },
    update: (mutator: (draft: ModelDirectoryState) => void) => {
      source.update(mutator)
    },
  }
  Object.defineProperty(directory, 'store', {
    configurable: true,
    get: () => wrapped,
  })
}
