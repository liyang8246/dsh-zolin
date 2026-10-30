import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { AccountState, OAuthTokens } from '../src/types.js'
import assert from 'node:assert/strict'
import { it } from 'vitest'
import { Accounts, readState, stateKey } from '../src/accounts.js'

// The credential document validates every key before any plugin starts, so an invalid literal
// here would abort Harness startup with no plugin stack.
it('the credential key is a valid <scope>/<id>', () => {
  assert.equal(stateKey, 'zephyr/accounts')
  assert.match(stateKey, /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/)
})

class MemoryCredentials {
  value: CredentialRecord | undefined
  private tail = Promise.resolve()
  async readRecord() { return structuredClone(this.value) }
  modifyRecord(_key: unknown, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) {
    const operation = this.tail.then(async () => {
      const next = await mutate(structuredClone(this.value))
      if (next)
        this.value = structuredClone(next)
      return structuredClone(this.value)
    })
    this.tail = operation.then(() => {}, () => {})
    return operation
  }
}
function tokens(id: string, expires = Date.now() + 3_600_000): OAuthTokens {
  return {
    access: `access-${id}`,
    refresh: `refresh-${id}`,
    expires,
    accountId: id,
    email: `${id}@example.com`,
  }
}
function accounts(store = new MemoryCredentials(), refresh = async (_channel: unknown, value: OAuthTokens) => value) {
  return {
    store,
    manager: new Accounts(store as unknown as Context['credentials'], refresh),
  }
}

it('five OpenAI and three OpenCode accounts persist; only one per channel is active', async () => {
  const { store, manager } = accounts()
  const openai = await Promise.all(Array.from({ length: 5 }, (_, i) => manager.add('openai-codex', `OpenAI ${i}`, {
    kind: 'oauth',
    tokens: tokens(`ai${i}`),
  })))
  const opencode = await Promise.all(Array.from({ length: 3 }, (_, i) => manager.add('opencode-go', `Go ${i}`, {
    kind: 'oauth',
    tokens: tokens(`go${i}`),
  })))
  await manager.activate('openai-codex', openai[4]!)
  await manager.activate('opencode-go', opencode[2]!)
  const restored = accounts(store).manager
  const views = await restored.list()
  assert.equal(views.length, 8)
  assert.deepEqual(views.filter(view => view.active).map(view => view.id), [openai[4], opencode[2]])
  const publicJSON = JSON.stringify(views)
  assert.ok(!publicJSON.includes('access-ai') && !publicJSON.includes('refresh-ai') && !publicJSON.includes('tokens'))
  assert.equal((await restored.resolve('openai-codex')).id, openai[4])
})

it('cross-channel selection fails without touching the current selection', async () => {
  const { manager } = accounts()
  const id = await manager.add('opencode-go', 'Go', {
    kind: 'oauth',
    tokens: tokens('go'),
  })
  await assert.rejects(manager.activate('openai-codex', id), /does not belong/)
  assert.equal((await manager.list())[0]!.active, true)
  await manager.deactivate('opencode-go')
  await assert.rejects(manager.resolve('opencode-go'), /No active account/)
})

it('removing the active account never silently selects a replacement', async () => {
  const { manager } = accounts()
  const first = await manager.add('opencode-go', 'First', {
    kind: 'oauth',
    tokens: tokens('one'),
  })
  await manager.add('opencode-go', 'Second', {
    kind: 'oauth',
    tokens: tokens('two'),
  })
  await manager.remove(first)
  assert.equal((await manager.list())[0]!.active, false)
  await assert.rejects(manager.resolve('opencode-go'), /No active account/)
})

it('reconnecting an OAuth identity updates its tokens without creating a duplicate', async () => {
  const { manager } = accounts()
  const id = await manager.add('openai-codex', 'First', {
    kind: 'oauth',
    tokens: tokens('same'),
  })
  const again = await manager.add('openai-codex', 'Updated', {
    kind: 'oauth',
    tokens: {
      ...tokens('same'),
      access: 'new-access',
    },
  })
  assert.equal(again, id)
  assert.equal((await manager.list()).length, 1)
  assert.equal((await manager.list())[0]!.label, 'Updated')
})

it('oAuth tokens refresh once under concurrent requests and persist atomically', async () => {
  let refreshes = 0
  const { manager } = accounts(undefined, async (_channel, previous) => {
    refreshes++
    await Promise.resolve()
    return {
      ...previous,
      access: 'new-access',
      refresh: 'rotated-refresh',
      expires: Date.now() + 3_600_000,
    }
  })
  await manager.add('openai-codex', 'Expired', {
    kind: 'oauth',
    tokens: tokens('expired', 1),
  })
  const result = await Promise.all(Array.from({ length: 8 }, () => manager.resolve('openai-codex')))
  assert.equal(refreshes, 1)
  for (const account of result) {
    assert.deepEqual(account.credential, {
      kind: 'oauth',
      tokens: {
        ...tokens('expired'),
        access: 'new-access',
        refresh: 'rotated-refresh',
        expires: account.credential.kind === 'oauth'
          ? account.credential.tokens.expires
          : 0,
      },
    })
  }
})

it('caller cancellation after token rotation never discards the new refresh token', async () => {
  const controller = new AbortController()
  const { manager } = accounts(undefined, async (_channel, previous) => {
    controller.abort(new Error('User cancelled'))
    return {
      ...previous,
      access: 'rotated-access',
      refresh: 'only-valid-refresh',
      expires: Date.now() + 3_600_000,
    }
  })
  await manager.add('openai-codex', 'Expired', {
    kind: 'oauth',
    tokens: tokens('cancel', 1),
  })
  await assert.rejects(manager.resolve('openai-codex', controller.signal), /User cancelled/)
  const saved = await manager.resolve('openai-codex')
  assert.equal(saved.credential.kind === 'oauth' && saved.credential.tokens.refresh, 'only-valid-refresh')
})

it('credential and persisted-state validation fail closed', async () => {
  const { manager } = accounts()
  await assert.rejects(manager.add('openai-codex', 'Wrong method', { kind: 'api-key', key: 'secret' }), /not supported/)
  await assert.rejects(manager.add('commandcode-go', 'Invalid key', { kind: 'api-key', key: 'key\r\nheader' }), /Invalid/)
  assert.throws(() => readState({ version: 2, accounts: [], active: {} }), /version/)
  assert.throws(() => readState({
    version: 1,
    accounts: [],
    active: { 'openai-codex': 'missing' },
  }), /selection/)
  const valid: AccountState = { version: 1, accounts: [], active: {} }
  assert.deepEqual(readState(valid), { ...valid, quotas: {} })
  // Stored quotas survive a restart; malformed entries are dropped instead of failing the parse.
  const stored = readState({
    version: 1,
    accounts: [],
    active: {},
    quotas: {
      one: {
        status: 'ok',
        fetchedAt: '2026-10-30T00:00:00.000Z',
        windows: [
          { period: '5h', usedPercent: 3 },
        ],
      },
      broken: { status: 'nope' },
    },
  })
  assert.deepEqual(Object.keys(stored.quotas ?? {}), ['one'])
})

it('legacy grant payloads keep account ids, selections, and optional identity metadata', async () => {
  const { manager, store } = accounts()
  const first = await manager.add('opencode-go', 'Team', {
    kind: 'oauth',
    tokens: {
      ...tokens('legacy'),
      orgId: 'team',
      orgName: 'Team',
    },
  })
  await manager.deactivate('opencode-go')
  const before = structuredClone(store.value)
  const restored = accounts(store).manager
  assert.equal((await restored.read()).version, 1)
  assert.equal((await restored.list())[0]!.id, first)
  assert.equal((await restored.list())[0]!.orgName, 'Team')
  assert.equal((await restored.list())[0]!.active, false)
  assert.deepEqual(store.value, before)
  assert.deepEqual(JSON.parse(JSON.stringify(await restored.list())), await restored.list())
})

it('oAuth identity deduplication includes organization and never reactivates a reconnected account', async () => {
  const { manager } = accounts()
  const first = await manager.add('opencode-go', 'A', {
    kind: 'oauth',
    tokens: {
      ...tokens('same'),
      orgId: 'a',
      orgName: 'A',
    },
  })
  const second = await manager.add('opencode-go', 'B', {
    kind: 'oauth',
    tokens: {
      ...tokens('same'),
      orgId: 'b',
      orgName: 'B',
    },
  })
  assert.notEqual(first, second)
  await manager.deactivate('opencode-go')
  const again = await manager.add('opencode-go', 'A renamed', {
    kind: 'oauth',
    tokens: {
      ...tokens('same'),
      orgId: 'a',
      orgName: 'A',
      access: 'new-access',
    },
  })
  assert.equal(again, first)
  assert.equal((await manager.list()).length, 2)
  assert.equal((await manager.list()).some(account => account.active), false)
})

it('separate managers share the credential-store rotation lock and a failed refresh leaves old tokens intact', async () => {
  const store = new MemoryCredentials()
  let refreshes = 0
  let fail = true
  const refresh = async (_channel: unknown, previous: OAuthTokens): Promise<OAuthTokens> => {
    refreshes++
    if (fail)
      throw new Error('Transient refresh failure')
    return {
      ...previous,
      access: 'new-access',
      refresh: 'rotated-refresh',
      expires: Date.now() + 3_600_000,
    }
  }
  const first = accounts(store, refresh).manager
  const second = accounts(store, refresh).manager
  await first.add('openai-codex', 'Expired', {
    kind: 'oauth',
    tokens: tokens('shared', 1),
  })
  const before = structuredClone(store.value)
  await assert.rejects(first.resolve('openai-codex'), /Transient refresh failure/)
  assert.deepEqual(store.value, before)
  fail = false
  const resolved = await Promise.all([
    first.resolve('openai-codex'),
    second.resolve('openai-codex'),
  ])
  assert.equal(refreshes, 2)
  assert.deepEqual(resolved[0], resolved[1])
})

it('cancellation while waiting for the store lock does not begin a token rotation', async () => {
  let refreshes = 0
  const { manager, store } = accounts(undefined, async (_channel, previous) => {
    refreshes++
    return { ...previous, expires: Date.now() + 3_600_000 }
  })
  await manager.add('openai-codex', 'Expired', {
    kind: 'oauth',
    tokens: tokens('queued', 1),
  })
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const blocking = store.modifyRecord(stateKey, async (current) => {
    await gate
    return current
  })
  const controller = new AbortController()
  const pending = manager.resolve('openai-codex', controller.signal)
  const rejected = assert.rejects(pending, /Stopped/)
  await new Promise<void>(resolve => setImmediate(resolve))
  controller.abort(new Error('Stopped'))
  release()
  await blocking
  await rejected
  assert.equal(refreshes, 0)
})

it('quota cache failures do not block credentials and late quota writes cannot revive deleted accounts', async () => {
  for (const quotas of [
    null,
    [],
    {
      bad: null,
      array: [],
      wrong: { status: 'nope' },
    },
  ]) {
    assert.deepEqual(readState({
      version: 1,
      accounts: [],
      active: {},
      quotas,
    }).quotas, {})
  }
  const { manager, store } = accounts()
  const id = await manager.add('commandcode-go', 'Key', { kind: 'api-key', key: 'test-key' })
  const quota = {
    status: 'ok' as const,
    fetchedAt: '2026-01-01',
    windows: [
      { period: '5h' as const, usedPercent: 10, resetsAt: undefined },
    ],
  }
  await manager.saveQuota(id, quota)
  const restored = accounts(store).manager
  assert.deepEqual(await restored.quotas(), {
    [id]: JSON.parse(JSON.stringify(quota)),
  })
  await restored.remove(id)
  await manager.saveQuota(id, quota)
  assert.deepEqual(await restored.quotas(), {})
  await assert.rejects(restored.resolve('commandcode-go'), /No active account/)
})

it('invalid record kinds and failed mutations never overwrite saved credentials', async () => {
  const { manager, store } = accounts()
  store.value = { kind: 'api-key', key: 'untouched' }
  await assert.rejects(manager.read(), /Invalid Zephyr credential record/)
  await assert.rejects(manager.add('commandcode-go', 'New', { kind: 'api-key', key: 'new' }), /Invalid Zephyr credential record/)
  assert.deepEqual(store.value, { kind: 'api-key', key: 'untouched' })
})

it('unsupported stored authentication methods fail closed without rewriting the grant', async () => {
  for (const [channel, credential] of [
    [
      'openai-codex',
      { kind: 'api-key', key: 'invalid-for-codex' },
    ],
    [
      'opencode-go',
      { kind: 'api-key', key: 'invalid-for-opencode' },
    ],
    [
      'commandcode-go',
      {
        kind: 'oauth',
        tokens: tokens('invalid-for-commandcode'),
      },
    ],
  ] as const) {
    const { manager, store } = accounts()
    store.value = {
      kind: 'grant',
      payload: {
        version: 1,
        accounts: [
          {
            id: 'existing',
            channel,
            label: 'Existing',
            createdAt: '2026-01-01',
            credential,
          },
        ],
        active: { [channel]: 'existing' },
      },
    }
    const before = structuredClone(store.value)
    await assert.rejects(manager.read(), /Authentication method not supported/)
    await assert.rejects(manager.rename('existing', 'Changed'), /Authentication method not supported/)
    assert.deepEqual(store.value, before)
  }
})

it('malformed cached quota windows are discarded and unknown fields never reach public views', () => {
  const state = readState({
    version: 1,
    accounts: [],
    active: {},
    quotas: {
      existing: {
        status: 'ok',
        fetchedAt: '2026-01-01',
        reason: [],
        plan: 1,
        extra: 'not-public',
        windows: [
          null,
          {},
          { period: 'unknown' },
          { period: 'week', usedPercent: '10' },
          { period: 'week', usedPercent: Number.NaN },
          { period: 'week', used: -1 },
          { period: 'week', limit: Number.POSITIVE_INFINITY },
          { period: 'week', resetsAt: [] },
          { period: 'week', exhausted: 'false' },
          {
            period: '5h',
            usedPercent: 10,
            exhausted: false,
            extra: 'not-public',
          },
        ],
      },
    },
  })
  assert.deepEqual(state.quotas, {
    existing: {
      status: 'ok',
      fetchedAt: '2026-01-01',
      windows: [
        { period: '5h', usedPercent: 10, exhausted: false },
      ],
    },
  })
  assert.deepEqual(JSON.parse(JSON.stringify(state)), state)
})
