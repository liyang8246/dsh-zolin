import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { LoginView, OAuthTokens } from '../src/types.js'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, it, vi } from 'vitest'
import { Accounts } from '../src/accounts.js'
import { Logins } from '../src/logins.js'
import { refreshOpenAI } from '../src/openai.js'

afterEach(() => {
  vi.useRealTimers()
})

function accounts(): Accounts {
  let stored: CredentialRecord | undefined
  return new Accounts({
    readRecord: async () => structuredClone(stored),
    modifyRecord: async (_key, mutate) => {
      const next = await mutate(structuredClone(stored))
      if (next)
        stored = structuredClone(next)
      return structuredClone(stored)
    },
  }, async (_channel, tokens) => tokens)
}

async function withFetch(implementation: typeof fetch, run: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch
  globalThis.fetch = implementation
  try {
    await run()
  }
  finally {
    globalThis.fetch = original
  }
}

async function until(read: () => LoginView | undefined, predicate: (view: LoginView) => boolean): Promise<LoginView> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const value = read()
    if (value && predicate(value))
      return value
    await delay(10)
  }
  throw new Error('Login did not reach the expected state')
}

function jwt(): string {
  return `e30.${Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' },
  })).toString('base64url')}.signature`
}
function device(): Response {
  return Response.json({
    device_code: 'private-device-code',
    user_code: 'ABCD',
    verification_uri_complete: 'https://opencode.ai/console/auth/device?code=ABCD',
    expires_in: 300,
    interval: 0.001,
  })
}

it('login attempts persist through Accounts and expose only detached public views', async () => {
  const manager = accounts()
  let changes = 0
  const logins = new Logins(manager, () => {
    changes++
    throw new Error('Observer failure')
  })
  await withFetch(async (input) => {
    const url = String(input)
    if (url.endsWith('/auth/device/code'))
      return device()
    if (url.endsWith('/auth/device/token')) {
      return Response.json({
        access_token: 'private-access',
        refresh_token: 'private-refresh',
        expires_in: 3600,
        org_id: 'org-1',
      })
    }
    if (url.endsWith('/api/user'))
      return Response.json({ id: 'user-1', email: 'user@example.com' })
    if (url.endsWith('/api/orgs')) {
      return Response.json([
        { id: 'org-1', name: 'Team' },
      ])
    }
    throw new Error('Unexpected mock URL')
  }, async () => {
    try {
      const start = logins.dispatch('login_start', { channel: 'opencode-go', label: 'Team' })
      assert.throws(() => logins.dispatch('login_start', { channel: 'opencode-go', label: 'Duplicate' }), /already running/)
      const other = logins.dispatch('login_start', { channel: 'openai-codex', label: 'Other channel' })
      assert.notEqual(other.id, start.id)
      logins.dispatch('login_cancel', { attemptId: other.id })
      const pending = await until(() => logins.pending, view => Boolean(view.notice))
      assert.ok(pending.notice?.url)
      pending.notice.url = 'https://attacker.example/'
      assert.match(logins.pending!.notice!.url!, /^https:\/\/opencode\.ai\//)
      const complete = await until(() => logins.dispatch('login_status', { attemptId: start.id }), view => view.status !== 'pending')
      assert.equal(complete.status, 'authorized')
      assert.equal(logins.pending, undefined)
      assert.equal(changes, 1)
      assert.equal((await manager.list())[0]!.orgName, 'Team')
      const output = JSON.stringify({ complete, accounts: await manager.list() })
      assert.ok(!/private-|controller|reply/.test(output))
    }
    finally { logins.dispose() }
  })
})

it('cancellation clears notices immediately, rejects stale input, and permits another attempt', async () => {
  const manager = accounts()
  const logins = new Logins(manager, () => {})
  let tokenRequests = 0
  await withFetch(async (input) => {
    if (String(input).endsWith('/auth/device/code'))
      return device()
    tokenRequests++
    throw new Error('A cancelled login must not poll')
  }, async () => {
    try {
      const start = logins.dispatch('login_start', { channel: 'opencode-go', label: 'Cancel' })
      await until(() => logins.pending, view => Boolean(view.notice))
      const cancelled = logins.dispatch('login_cancel', { attemptId: start.id })
      assert.deepEqual(cancelled, { id: start.id, channel: 'opencode-go', status: 'cancelled' })
      assert.equal(logins.pending, undefined)
      assert.throws(() => logins.dispatch('login_reply', { attemptId: start.id, answer: 'late' }), /not waiting/)
      const next = logins.dispatch('login_start', { channel: 'opencode-go', label: 'Again' })
      assert.throws(() => logins.dispatch('login_status', { attemptId: start.id }), /expired/)
      logins.dispatch('login_cancel', { attemptId: next.id })
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(tokenRequests, 0)
      assert.deepEqual(await manager.list(), [])
    }
    finally { logins.dispose() }
  })
})

it('the browser prompt accepts one reply and never forwards endpoint error bodies', async () => {
  const manager = accounts()
  const logins = new Logins(manager, () => {})
  let requests = 0
  await withFetch(async (input) => {
    assert.match(String(input), /auth\.openai\.com\/oauth\/token$/)
    requests++
    return Response.json({
      error: { message: 'private-access private-refresh' },
    }, { status: 400 })
  }, async () => {
    try {
      const start = logins.dispatch('login_start', { channel: 'openai-codex', label: 'Browser' })
      const pending = await until(() => logins.pending, view => Boolean(view.prompt && view.notice?.url))
      const state = new URL(pending.notice!.url!).searchParams.get('state')
      const answer = `http://localhost:1455/auth/callback?code=test-code&state=${state}`
      logins.dispatch('login_reply', { attemptId: start.id, answer })
      assert.throws(() => logins.dispatch('login_reply', { attemptId: start.id, answer }), /not waiting/)
      const failed = await until(() => logins.dispatch('login_status', { attemptId: start.id }), view => view.status !== 'pending')
      assert.equal(failed.status, 'error')
      assert.equal(failed.error, 'Sign-in failed; try again')
      assert.ok(!JSON.stringify(failed).includes('private-'))
      assert.equal(requests, 1)
      assert.deepEqual(await manager.list(), [])
    }
    finally { logins.dispose() }
  })
})

it('a successful browser reply clears its manual prompt and stores validated tokens once', async () => {
  const manager = accounts()
  let changes = 0
  const logins = new Logins(manager, () => {
    changes++
  })
  await withFetch(async () => Response.json({
    access_token: jwt(),
    refresh_token: 'private-refresh',
    expires_in: 3600,
  }), async () => {
    try {
      const start = logins.dispatch('login_start', { channel: 'openai-codex', label: 'Browser' })
      const pending = await until(() => logins.pending, view => Boolean(view.prompt && view.notice?.url))
      const state = new URL(pending.notice!.url!).searchParams.get('state')
      logins.dispatch('login_reply', { attemptId: start.id, answer: `http://localhost:1455/auth/callback?code=test-code&state=${state}` })
      const complete = await until(() => logins.dispatch('login_status', { attemptId: start.id }), view => view.status !== 'pending')
      assert.deepEqual(complete, { id: start.id, channel: 'openai-codex', status: 'authorized' })
      assert.equal(changes, 1)
      assert.equal((await manager.list()).length, 1)
      assert.ok(!JSON.stringify(await manager.list()).includes('private-refresh'))
    }
    finally { logins.dispose() }
  })
})

it('aborting a browser prompt settles once without storing credentials or exposing controls', async () => {
  const manager = accounts()
  const logins = new Logins(manager, () => {
    throw new Error('Cancelled login must not commit')
  })
  await withFetch(async () => {
    throw new Error('No provider request before consent')
  }, async () => {
    try {
      const start = logins.dispatch('login_start', { channel: 'openai-codex', label: 'Cancel browser' })
      await until(() => logins.pending, view => Boolean(view.prompt))
      const cancelled = logins.dispatch('login_cancel', { attemptId: start.id })
      assert.deepEqual(cancelled, { id: start.id, channel: 'openai-codex', status: 'cancelled' })
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.deepEqual(logins.dispatch('login_status', { attemptId: start.id }), cancelled)
      assert.deepEqual(await manager.list(), [])
    }
    finally { logins.dispose() }
  })
})

it('unexpected authorization origins and unknown actions fail without exposing login internals', async () => {
  const logins = new Logins(accounts(), () => {})
  await withFetch(async () => Response.json({
    device_code: 'private-device-code',
    user_code: 'ABCD',
    verification_uri_complete: 'https://attacker.example/',
    expires_in: 300,
    interval: 1,
  }), async () => {
    try {
      assert.throws(() => logins.dispatch('unknown', {}), /Unknown login action/)
      assert.throws(() => logins.dispatch('login_start', { channel: 'commandcode-go', label: 'Key' }), /does not support OAuth/)
      const start = logins.dispatch('login_start', { channel: 'opencode-go', label: 'Bad origin' })
      const failed = await until(() => logins.dispatch('login_status', { attemptId: start.id }), view => view.status !== 'pending')
      assert.deepEqual(failed, {
        id: start.id,
        channel: 'opencode-go',
        status: 'error',
        error: 'Sign-in failed; try again',
      })
    }
    finally { logins.dispose() }
  })
})

it('login timeout and plugin disposal abort outstanding work and clear pending state', async () => {
  const manager = accounts()
  const logins = new Logins(manager, () => {})
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout'],
  })
  try {
    await withFetch(async () => device(), async () => {
      const start = logins.dispatch('login_start', { channel: 'opencode-go', label: 'Timeout' })
      vi.advanceTimersByTime(15 * 60_000 + 1)
      assert.equal(logins.dispatch('login_status', { attemptId: start.id }).status, 'cancelled')
      logins.dispatch('login_start', { channel: 'opencode-go', label: 'Dispose' })
      logins.dispose()
      assert.equal(logins.pending, undefined)
      assert.equal(vi.getTimerCount(), 0)
      assert.throws(() => logins.dispatch('login_status', { attemptId: start.id }), /unloading/)
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.deepEqual(await manager.list(), [])
    })
  }
  finally {
    logins.dispose()
    vi.useRealTimers()
  }
})

it('openAI refresh shares token validation, preserves identity and redacts bad responses', async () => {
  const previous: OAuthTokens = {
    access: jwt(),
    refresh: 'old-refresh',
    expires: 1,
    email: 'user@example.com',
  }
  await withFetch(async () => Response.json({
    access_token: jwt(),
    refresh_token: 'new-refresh',
    expires_in: 3600,
  }), async () => {
    const tokens = await refreshOpenAI(previous)
    assert.equal(tokens.accountId, 'test-account')
    assert.equal(tokens.email, previous.email)
    assert.equal(tokens.refresh, 'new-refresh')
  })
  for (const payload of [
    {
      access_token: jwt(),
      refresh_token: 'private-refresh',
      expires_in: -1,
    },
    {
      access_token: jwt(),
      refresh_token: 'private-refresh\r\nheader',
      expires_in: 3600,
    },
  ]) {
    await withFetch(async () => Response.json(payload), async () => {
      await assert.rejects(refreshOpenAI(previous), (error: Error) => error.message === 'OpenAI token refresh failed')
    })
  }
})
