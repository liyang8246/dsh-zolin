// @env browser
import type { Context } from '@deepseek-ai/cordis'

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

/** One Host-generation catalog snapshot as the filter reads and rewrites it. */
interface CatalogState {
  value: { groups: readonly CatalogGroup[] } | null
  status: string
  error: string | null
}

/** The catalog store's readable face. */
interface CatalogStore {
  getSnapshot: () => CatalogState
  subscribe: (listener: () => void) => () => void
  set: (next: CatalogState) => void
}

/**
 * Keep only models whose name contains one of the keywords.
 * @param state - the shared catalog snapshot.
 * @param keywords - lowercase keywords; empty keeps everything.
 * @returns the snapshot with filtered provider groups.
 */
export function filterCatalog(state: CatalogState, keywords: readonly string[]): CatalogState {
  if (!keywords.length || state.value === null)
    return state
  const groups = state.value.groups
    .map(group => ({
      ...group,
      models: group.models.filter((model: CatalogModel) => matches(model.name, keywords)),
    }))
    .filter((group: CatalogGroup) => group.models.length > 0)
  return {
    ...state,
    value: { ...state.value, groups },
  }
}

/**
 * Filter the one Host-generation model catalog that every session directory copies,
 * so the composer seat and the /model popup share the filtered list.
 *
 * The resolver's own `directoryFor` is NOT wrapped: any method reached through
 * `ctx.get` becomes callable only under this plugin's inject set, where the
 * resolver's `this.ctx.remote.session` read is illegal and takes the composer
 * seat down with it.
 * @param ctx - client root context.
 * @param filter - the page-owned keyword filter.
 */
export function installModelFilter(ctx: Context, filter: ModelFilter): void {
  const models = ctx.get('modelDirectories') as { catalog?: { store?: CatalogStore } } | undefined
  const catalog = models?.catalog
  const source = catalog?.store
  if (catalog === undefined || source === undefined)
    return
  let cache: { snapshot: CatalogState, key: string, value: CatalogState } | undefined
  // Reads must return one stable object per state so React's store subscription settles.
  const read = (): CatalogState => {
    const snapshot = source.getSnapshot()
    const key = filter.getSnapshot()
    if (cache === undefined || cache.snapshot !== snapshot || cache.key !== key) {
      let value = snapshot
      try {
        value = filterCatalog(snapshot, filter.keywords())
      }
      catch {
        // A catalog the filter cannot read keeps its full model list; filtering is advisory.
      }
      cache = { snapshot, key, value }
    }
    return cache.value
  }
  const wrapped: CatalogStore = {
    getSnapshot: read,
    subscribe(listener) {
      const stopSource = source.subscribe(listener)
      const stopFilter = filter.subscribe(listener)
      return () => {
        stopSource()
        stopFilter()
      }
    },
    set: next => source.set(next),
  }
  Object.defineProperty(catalog, 'store', {
    configurable: true,
    get: () => wrapped,
  })
}
