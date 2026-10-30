import type { ClientBundleRegistration } from '@deepseek-ai/dsh-client-modules/client'
import type { AccountSnapshot, AccountView, LoginView, QuotaWindow } from '../src/types.js'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Script } from 'node:vm'
import { afterEach, describe, it, vi } from 'vitest'
import { channels } from '../src/channels.js'
import { en } from '../src/client/constants.js'
import { activeQuota, authorizationURL, channelOf, isObject, leftOf, levelOf, measuredWindows, readLogin, readSnapshot, resetTime } from '../src/client/data.js'
import { createAccountStore } from '../src/client/store.js'

afterEach(() => {
  vi.useRealTimers()
})

interface ViewElement {
  type: unknown
  props: Record<string, unknown>
  children: unknown[]
}

function elements(value: unknown): ViewElement[] {
  if (Array.isArray(value))
    return value.flatMap(elements)
  if (!isObject(value) || !isObject(value.props) || !Array.isArray(value.children))
    return []
  const element: ViewElement = { type: value.type, props: value.props, children: value.children }
  return [
    element,
    ...element.children.flatMap(elements),
    ...(typeof element.type === 'function'
      ? elements(element.type(element.props))
      : []),
  ]
}

function click(element: ViewElement | undefined): void {
  assert.ok(element && typeof element.props.onClick === 'function')
  element.props.onClick()
}

function account(id: string, usedPercent: number, active = true): AccountView {
  return {
    id,
    channel: 'openai-codex',
    label: id,
    createdAt: '2026-01-01T00:00:00Z',
    auth: 'oauth',
    active,
    quota: {
      status: 'ok',
      fetchedAt: '2026-01-01T00:00:00Z',
      windows: [
        { period: '5h', usedPercent },
      ],
    },
  }
}

function snapshot(accounts: AccountView[]): AccountSnapshot {
  return {
    channels,
    accounts,
    catalog: { source: 'https://models.dev/api.json', generatedAt: '2026-01-01', sha256: 'fixture' },
  }
}

async function mountAccounts(respond: (request: Record<string, unknown>, signal: AbortSignal | undefined) => Promise<Response>): Promise<{ render: () => ViewElement[], composer: () => ViewElement[], notifications: Record<string, number>, dispose: () => void }> {
  const registrations: ClientBundleRegistration[] = []
  const effects: (() => void)[] = []
  const cleanups: (() => void)[] = []
  const state = new Map<string, unknown>()
  const dependencies = new Map<string, readonly unknown[]>()
  const effectCleanups = new Map<string, () => void>()
  const notifications: Record<string, number> = { settings: 0, composer: 0 }
  let frame = 'settings'
  let cursor = 0
  let page: (() => unknown) | undefined
  let composer: ((props: { sessionId: string }) => unknown) | undefined
  let english: Record<string, string> = {}
  const changed = (index: string, deps: readonly unknown[]): boolean => {
    const previous = dependencies.get(index)
    dependencies.set(index, deps)
    return !previous || deps.some((value, i) => !Object.is(value, previous[i]))
  }
  const react = {
    Fragment: Symbol('Fragment'),
    createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): ViewElement {
      return { type, props: props ?? {}, children }
    },
    useState(initial: unknown): [unknown, (value: unknown) => void] {
      const index = `${frame}:${cursor++}`
      if (!state.has(index))
        state.set(index, initial)
      return [
        state.get(index),
        (value) => { state.set(index, value) },
      ]
    },
    useRef(current: unknown): unknown {
      const index = `${frame}:${cursor++}`
      if (!state.has(index))
        state.set(index, { current })
      return state.get(index)
    },
    useCallback(callback: unknown, deps: readonly unknown[]): unknown {
      const index = `${frame}:${cursor++}`
      if (changed(index, deps))
        state.set(index, callback)
      return state.get(index)
    },
    useMemo: (factory: () => unknown) => factory(),
    useSyncExternalStore(subscribe: (listener: () => void) => () => void, getSnapshot: () => unknown): unknown {
      const index = `${frame}:${cursor++}`
      const component = frame
      if (!effectCleanups.has(index))
        effectCleanups.set(index, subscribe(() => { notifications[component]++ }))
      return getSnapshot()
    },
    useEffect(effect: () => void | (() => void), deps: readonly unknown[]): void {
      const index = `${frame}:${cursor++}`
      if (changed(index, deps)) {
        effects.push(() => {
          effectCleanups.get(index)?.()
          const cleanup = effect()
          if (cleanup)
            effectCleanups.set(index, cleanup)
          else effectCleanups.delete(index)
        })
      }
    },
  }
  const script = new Script(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'))
  script.runInNewContext({
    window: {
      __ModuleLoader__: {
        load: (value: ClientBundleRegistration) => registrations.push(value),
      },
    },
    document: { baseURI: 'http://harness.test/' },
    URL,
    AbortController,
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    fetch: async (url: URL, init: RequestInit): Promise<Response> => {
      assert.equal(url.href, 'http://harness.test/api/zephyr-models')
      assert.equal(init.redirect, 'error')
      assert.equal(init.credentials, 'same-origin')
      assert.ok(typeof init.body === 'string')
      const request: unknown = JSON.parse(init.body)
      assert.ok(isObject(request) && typeof request.action === 'string')
      return respond(request, init.signal ?? undefined)
    },
  })
  const registration = registrations[0]
  assert.ok(registration)
  const require = Object.assign((specifier: string) => {
    assert.equal(specifier, 'react')
    return react
  }, {
    async: async (): Promise<unknown> => { throw new Error('Unexpected dynamic import') },
  })
  const plugin = registration.factory(require)
  assert.ok(typeof plugin.apply === 'function')
  plugin.apply({
    effect(setup: () => void | (() => void)): void {
      const cleanup = setup()
      if (cleanup)
        cleanups.push(cleanup)
    },
    locale: {
      register(_namespace: string, locale: string, dictionary: Record<string, string>) {
        if (locale === 'en')
          english = dictionary
        return () => {}
      },
      bind: () => (key: string) => english[key] ?? key,
      getSnapshot: () => 0,
      subscribe: () => () => {},
    },
    get: () => ({
      directoryFor: () => ({
        store: {
          getSnapshot: () => ({
            current: { provider: 'zephyr-openai-codex' },
          }),
          subscribe: () => () => {},
        },
      }),
    }),
    slots: {
      inject: (_name: string, register: () => unknown) => register(),
      register(options: { name: string }, component: (props: { sessionId: string }) => unknown) {
        if (options.name === 'settings.section')
          page = () => component({ sessionId: 'session' })
        else if (options.name === 'conversation.input.right')
          composer = component
        return () => {}
      },
    },
  })
  return {
    notifications,
    render() {
      assert.ok(page)
      frame = 'settings'
      cursor = 0
      const tree = elements(page())
      for (const effect of effects.splice(0)) effect()
      return tree
    },
    composer() {
      assert.ok(composer)
      frame = 'composer'
      cursor = 0
      const tree = elements(composer({ sessionId: 'session' }))
      for (const effect of effects.splice(0)) effect()
      return tree
    },
    dispose() {
      for (const cleanup of effectCleanups.values()) cleanup()
      for (const cleanup of cleanups) cleanup()
    },
  }
}

describe('browser client artifact', () => {
  it('registers its real IIFE as a classic factory and resolves React only when materialized', async () => {
    const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
    const script = new Script(source, { filename: 'client.js' })
    const registrations: ClientBundleRegistration[] = []
    const requested: string[] = []
    script.runInNewContext({
      window: {
        __ModuleLoader__: {
          load: (value: ClientBundleRegistration) => registrations.push(value),
        },
      },
    })
    assert.equal(registrations.length, 1)
    const registration = registrations[0]
    assert.ok(registration)
    assert.equal(registration.id, 'dsh-model-accounts')
    assert.equal(requested.length, 0)
    const require = Object.assign((specifier: string): unknown => {
      requested.push(specifier)
      assert.equal(specifier, 'react')
      return {}
    }, {
      async: async (): Promise<unknown> => { throw new Error('Unexpected dynamic import') },
    })
    const plugin = registration.factory(require)
    assert.deepEqual(requested, ['react'])
    assert.equal(typeof plugin.apply, 'function')
    assert.ok(Array.isArray(plugin.inject))
    assert.deepEqual(Array.from(plugin.inject), ['slots', 'locale', 'modelDirectories'])
  })

  it('requires explicit deletion confirmation and sends account RPCs without redirecting credentials', async () => {
    const requests: string[] = []
    const browser = await mountAccounts(async (request) => {
      requests.push(String(request.action))
      return Response.json(snapshot(request.action === 'remove'
        ? []
        : [
            account('one', 3),
          ]))
    })
    const render = browser.render
    render()
    try {
      await vi.waitFor(() => assert.ok(render().some(node => node.type === 'strong' && node.children.includes('one'))))
      const removeButton = (): ViewElement | undefined => render().filter(node => node.type === 'button' && node.children.includes(en.remove)).at(-1)
      const confirming = (): boolean => render().some(node => node.props.role === 'group' && node.props['aria-label'] === en.confirmRemove)
      click(removeButton())
      assert.ok(confirming())
      assert.equal(requests.filter(action => action === 'remove').length, 0)
      click(render().find(node => node.type === 'button' && node.children.includes(en.cancel)))
      assert.equal(confirming(), false)
      assert.equal(requests.filter(action => action === 'remove').length, 0)
      click(removeButton())
      click(removeButton())
      await vi.waitFor(() => assert.equal(render().some(node => node.type === 'strong' && node.children.includes('one')), false))
      assert.equal(requests.filter(action => action === 'remove').length, 1)
      assert.equal(requests.includes('client_probe'), false)
    }
    finally {
      browser.dispose()
    }
  })

  it.each(['activate', 'remove'] as const)('keeps settings and composer current when OAuth quota refresh resolves after %s', async (action) => {
    vi.useFakeTimers({
      toFake: [
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
      ],
    })
    const requests: string[] = []
    const before = snapshot([
      account('one', 3),
      account('two', 80, false),
    ])
    const after = snapshot(action === 'activate'
      ? [
          account('one', 3, false),
          account('two', 80),
        ]
      : [
          account('two', 80),
        ])
    let release!: (response: Response) => void
    const held = new Promise<Response>((resolve) => {
      release = resolve
    })
    const browser = await mountAccounts(async (request) => {
      requests.push(String(request.action))
      if (request.action === 'list') {
        return Response.json({
          ...before,
          login: { id: 'attempt', channel: 'openai-codex', status: 'pending' },
        })
      }
      if (request.action === 'login_status')
        return Response.json({ id: 'attempt', channel: 'openai-codex', status: 'authorized' })
      if (request.action === 'refresh_quota')
        return held
      assert.equal(request.action, action)
      return Response.json(after)
    })
    const selected = (): unknown[] => browser.render().filter(node => node.props.type === 'radio').map(node => node.props.checked)
    const bars = (tree: ViewElement[]): unknown[] => tree.filter(node => node.type === 'b' && isObject(node.props.style)).map(node => isObject(node.props.style)
      ? node.props.style.width
      : undefined)
    try {
      browser.render()
      browser.composer()
      await vi.advanceTimersByTimeAsync(0)
      assert.deepEqual(selected(), [true, false])
      assert.deepEqual(bars(browser.composer()), ['97%'])
      await vi.advanceTimersByTimeAsync(500)
      assert.deepEqual(requests, ['list', 'login_status', 'refresh_quota'])
      const settingsNotified = browser.notifications.settings
      const composerNotified = browser.notifications.composer
      if (action === 'activate') {
        const radio = browser.render().find(node => node.props.type === 'radio' && !node.props.checked)
        assert.ok(radio && typeof radio.props.onChange === 'function')
        radio.props.onChange()
      }
      else {
        click(browser.render().find(node => node.type === 'button' && node.children.includes(en.remove)))
        click(browser.render().filter(node => node.type === 'button' && node.children.includes(en.remove))[1])
      }
      await vi.advanceTimersByTimeAsync(0)
      const expected = action === 'activate'
        ? [false, true]
        : [true]
      assert.deepEqual(selected(), expected)
      assert.deepEqual(bars(browser.render()), action === 'activate'
        ? ['97%', '20%']
        : ['20%'])
      assert.deepEqual(bars(browser.composer()), ['20%'])
      assert.equal(browser.notifications.settings, settingsNotified + 1)
      assert.equal(browser.notifications.composer, composerNotified + 1)
      release(Response.json(before))
      await vi.advanceTimersByTimeAsync(0)
      assert.deepEqual(selected(), expected)
      assert.deepEqual(bars(browser.composer()), ['20%'])
      assert.deepEqual(requests, [
        'list',
        'login_status',
        'refresh_quota',
        action,
      ])
    }
    finally {
      browser.dispose()
    }
  })

  it('fails clearly outside the Harness loader instead of silently skipping registration', async () => {
    const script = new Script(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'))
    assert.throws(() => script.runInNewContext({ window: {} }), /Harness module loader is unavailable/)
  })
})

describe('quota presentation', () => {
  it('keeps reported windows ordered and omits absent or non-finite percentages', () => {
    const windows: QuotaWindow[] = [
      { period: 'month', usedPercent: 30 },
      { period: 'other', usedPercent: 40 },
      { period: 'week' },
      { period: '5h', usedPercent: 12 },
    ]
    assert.deepEqual(measuredWindows(windows).map(window => window.period), ['5h', 'month'])
    assert.deepEqual(measuredWindows([
      { period: '5h', usedPercent: Number.NaN },
      { period: 'week', usedPercent: Number.POSITIVE_INFINITY },
    ]), [])
    assert.equal(leftOf({ period: '5h', usedPercent: -2 }), 100)
    assert.equal(leftOf({ period: '5h', usedPercent: 102 }), 0)
    assert.equal(leftOf({ period: '5h', usedPercent: 95, exhausted: true }), 0)
    assert.equal(levelOf({ period: '5h', usedPercent: 80 }), 'high')
    assert.equal(levelOf({ period: '5h', usedPercent: 100 }), 'full')
    assert.equal(levelOf({ period: '5h', usedPercent: 20 }), 'ok')
  })

  it('recognizes only the existing provider prefix and known account channels', () => {
    assert.equal(channelOf('zephyr-openai-codex'), 'openai-codex')
    assert.equal(channelOf('zephyr-opencode-go'), 'opencode-go')
    assert.equal(channelOf('zephyr-commandcode-go'), 'commandcode-go')
    for (const provider of [
      undefined,
      null,
      'openai-codex',
      'zephyr-unknown',
      'dsh-model-accounts-openai-codex',
    ]) {
      assert.equal(channelOf(provider), undefined)
    }
  })

  it('does not render invalid or elapsed reset dates as a countdown', () => {
    const now = Date.parse('2026-01-01T00:00:00Z')
    assert.equal(resetTime('2026-01-01T01:03:00Z', true, now), '1h3min')
    assert.equal(resetTime('2026-01-01T00:05:00Z', true, now), '5min')
    assert.equal(resetTime('2025-12-31T23:59:00Z', true, now), '')
    assert.equal(resetTime('not a date', true, now), '')
    assert.equal(resetTime(undefined), '')
  })
})

describe('shared settings and composer snapshot', () => {
  it('notifies both consumers synchronously after a refresh, selection, disable, or removal', () => {
    const store = createAccountStore(async () => snapshot([]))
    const settings: number[][] = []
    const composer: number[][] = []
    const current = (): number[] => activeQuota(store.getSnapshot(), 'openai-codex').map(leftOf)
    const stopSettings = store.subscribe(() => settings.push(current()))
    const stopComposer = store.subscribe(() => composer.push(current()))
    store.publish(snapshot([
      account('one', 3),
    ]))
    store.publish(snapshot([
      account('one', 55),
    ]))
    store.publish(snapshot([
      account('one', 55, false),
      account('two', 80),
    ]))
    store.publish(snapshot([
      account('one', 55, false),
      account('two', 80, false),
    ]))
    store.publish(snapshot([]))
    assert.deepEqual(settings, [
      [97],
      [45],
      [20],
      [],
      [],
    ])
    assert.deepEqual(composer, settings)
    stopSettings()
    stopComposer()
    store.publish(snapshot([
      account('three', 0),
    ]))
    assert.equal(settings.length, 5)
    assert.equal(composer.length, 5)
  })

  it('clears old bars when quota is unavailable, failed, or missing', () => {
    const store = createAccountStore(async () => snapshot([]))
    const saved = account('one', 3)
    store.publish(snapshot([saved]))
    assert.equal(activeQuota(store.getSnapshot(), 'openai-codex')[0]?.usedPercent, 3)
    for (const status of ['error', 'unavailable'] as const) {
      store.publish(snapshot([
        {
          ...saved,
          quota: {
            status,
            fetchedAt: '',
            windows: [
              { period: '5h', usedPercent: 3 },
            ],
          },
        },
      ]))
      assert.deepEqual(activeQuota(store.getSnapshot(), 'openai-codex'), [])
    }
    store.publish(snapshot([
      { ...saved, quota: undefined },
    ]))
    assert.deepEqual(activeQuota(store.getSnapshot(), 'openai-codex'), [])
    assert.deepEqual(activeQuota(store.getSnapshot(), undefined), [])
  })

  it('deduplicates only in-flight list requests and reads fresh host data on the next mount', async () => {
    let resolve!: (value: AccountSnapshot) => void
    const pending = new Promise<AccountSnapshot>((done) => {
      resolve = done
    })
    let calls = 0
    const newer = snapshot([
      account('one', 20),
    ])
    const store = createAccountStore(() => ++calls === 1
      ? pending
      : Promise.resolve(newer))
    const first = store.reload()
    assert.equal(store.reload(), first)
    resolve(snapshot([
      account('one', 3),
    ]))
    await first
    assert.equal(calls, 1)
    await store.reload()
    assert.equal(calls, 2)
    assert.equal(store.getSnapshot(), newer)
  })

  it('does not let an older list response overwrite a newer mutation snapshot', async () => {
    let resolve!: (value: AccountSnapshot) => void
    const store = createAccountStore(() => new Promise((done) => {
      resolve = done
    }))
    const loading = store.reload()
    const refreshed = snapshot([
      account('one', 70),
    ])
    store.publish(refreshed)
    resolve(snapshot([
      account('one', 3),
    ]))
    assert.equal(await loading, refreshed)
    assert.equal(store.getSnapshot(), refreshed)
  })

  it.each(['before', 'after'] as const)('does not let a local read finishing %s a pending mutation invalidate its result', async (order) => {
    const old = snapshot([
      account('one', 3),
    ])
    const fresh = snapshot([
      account('two', 80),
    ])
    let resolveRead!: (value: AccountSnapshot) => void
    let resolveMutation!: (value: AccountSnapshot) => void
    const store = createAccountStore(() => new Promise((resolve) => {
      resolveRead = resolve
    }))
    store.publish(old)
    const update = store.update(() => new Promise((resolve) => {
      resolveMutation = resolve
    }))
    const reading = store.reload()
    if (order === 'before') {
      resolveRead(old)
      await reading
    }
    resolveMutation(fresh)
    assert.equal(await update, fresh)
    if (order === 'after') {
      resolveRead(old)
      await reading
    }
    assert.equal(store.getSnapshot(), fresh)
    store.dispose()
  })

  it('does not publish a pending mutation after the plugin is disposed', async () => {
    let resolve!: (value: AccountSnapshot) => void
    const store = createAccountStore(async () => snapshot([]))
    const update = store.update(() => new Promise((done) => {
      resolve = done
    }))
    store.dispose()
    resolve(snapshot([
      account('one', 3),
    ]))
    await update
    assert.equal(store.getSnapshot(), undefined)
    await assert.rejects(store.update(async () => snapshot([])), /unloading/)
  })

  it('shares one local snapshot timer and stops it after the last subscriber or plugin disposal', async () => {
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval'],
    })
    let calls = 0
    const store = createAccountStore(async () => {
      calls++
      return snapshot([])
    })
    vi.advanceTimersByTime(60_000)
    assert.equal(calls, 0)
    const stopSettings = store.subscribe(() => {})
    const stopComposer = store.subscribe(() => {})
    vi.advanceTimersByTime(60_000)
    await store.reload()
    assert.equal(calls, 1)
    stopSettings()
    vi.advanceTimersByTime(60_000)
    await store.reload()
    assert.equal(calls, 2)
    stopComposer()
    vi.advanceTimersByTime(60_000)
    assert.equal(calls, 2)
    store.subscribe(() => {})
    vi.advanceTimersByTime(60_000)
    await store.reload()
    assert.equal(calls, 3)
    store.dispose()
    vi.advanceTimersByTime(120_000)
    assert.equal(calls, 3)
    await assert.rejects(store.reload(), /unloading/)
  })

  it('allows retry after a failed list instead of caching its rejected promise', async () => {
    let calls = 0
    const fresh = snapshot([])
    const store = createAccountStore(async () => {
      if (++calls === 1)
        throw new Error('offline')
      return fresh
    })
    await assert.rejects(store.reload(), /offline/)
    assert.equal(await store.reload(), fresh)
  })
})

describe('browser response and navigation boundaries', () => {
  it('validates nested host responses without casting JSON or echoing malformed payloads', () => {
    const valid = snapshot([
      account('one', 25),
    ])
    assert.equal(readSnapshot(valid), valid)
    const malformed = {
      ...valid,
      accounts: [
        {
          ...account('one', 25),
          quota: {
            status: 'ok',
            fetchedAt: '',
            windows: [
              { period: '5h', usedPercent: 'secret-not-a-number' },
            ],
          },
        },
      ],
    }
    assert.throws(() => readSnapshot(malformed), { message: 'Invalid account response' })
    assert.throws(() => readSnapshot({
      ...valid,
      channels: [
        { ...channels[0], id: 'unknown' },
      ],
    }), /Invalid account response/)
    assert.throws(() => readSnapshot({ ...valid, catalog: null }), /Invalid account response/)
    assert.throws(() => readLogin({
      id: 'attempt',
      channel: 'openai-codex',
      status: 'pending',
      notice: { url: 3 },
    }), /Invalid login response/)
  })

  it('exposes only HTTPS authorization URLs on the channel allowlist', () => {
    const login: LoginView = {
      id: 'attempt',
      channel: 'openai-codex',
      status: 'pending',
      prompt: 'Paste redirect URL',
    }
    const withURL = (url: string): LoginView => ({
      ...login,
      notice: { url },
    })
    assert.equal(readLogin(login), login)
    assert.equal(authorizationURL(withURL('https://auth.openai.com/authorize?state=public')), 'https://auth.openai.com/authorize?state=public')
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,login',
      'http://auth.openai.com/',
      'https://auth.openai.com.attacker.example/',
      'https://user:password@auth.openai.com/',
      'https://auth.openai.com:8443/',
      'not a URL',
      'https://opencode.ai/',
    ]) {
      assert.equal(authorizationURL(withURL(url)), undefined)
    }
    assert.equal(authorizationURL({
      ...withURL('https://opencode.ai/console/auth/device'),
      channel: 'opencode-go',
    }), 'https://opencode.ai/console/auth/device')
    assert.equal(authorizationURL({
      ...withURL('https://opencode.ai/'),
      channel: 'commandcode-go',
    }), undefined)
  })
})
