import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import assert from 'node:assert/strict'
import { it } from 'vitest'
import { normalizeCatalog, sources } from '../scripts/update-models.ts'
import { safeError } from '../src/errors.js'
import { jsonResponse, ProviderHTTPError } from '../src/http.js'
import { loginOpenCode, refreshOpenCode } from '../src/opencode.js'
import { fetchQuota, parseOpenAIQuota, parseOpenCodeQuota } from '../src/quota.js'
import { ModelAccountsService } from '../src/service.js'

it('malformed JSON never exposes upstream body fragments in public errors', async () => {
  for (const body of ['sk-synthetic-secret', '{"key":"user_synthetic_secret"']) {
    await assert.rejects(jsonResponse(new Response(body)), (error: unknown) => {
      assert.equal(safeError(error), 'Provider returned invalid JSON')
      return true
    })
  }
  await assert.rejects(jsonResponse(new Response('oversized'), 2), /exceeds size limit/u)
})

it('openAI windows use reported durations; missing month stays unavailable', () => {
  const quota = parseOpenAIQuota({
    plan_type: 'plus',
    rate_limit: {
      primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_at: 1800000000 },
      secondary_window: { used_percent: 45, limit_window_seconds: 604800 },
    },
  })
  assert.equal(quota.status, 'ok')
  assert.deepEqual(quota.windows.map(window => window.period), ['5h', 'week'])
  assert.equal(quota.windows[0]!.usedPercent, 12)
  assert.equal(quota.windows.find(window => window.period === 'month'), undefined)
  assert.equal(parseOpenAIQuota({ rate_limit: {} }).status, 'unavailable')
  const other = parseOpenAIQuota({
    rate_limit: {
      primary_window: { used_percent: 1, limit_window_seconds: 3600 },
    },
  })
  assert.equal(other.windows[0]!.period, 'other')
})

it('openCode quota parses percent/reset windows without inventing missing values', () => {
  const quota = parseOpenCodeQuota({
    usage: {
      rolling: { percent: 20, resetsAt: '2026-10-29T15:00:00Z', status: 'ok' },
      weekly: { percent: 100, status: 'rate-limited' },
      monthly: { status: 'ok' },
    },
  })
  assert.deepEqual(quota.windows.map(window => window.period), ['5h', 'week'])
  assert.equal(quota.windows[1]!.exhausted, true)
  assert.equal(parseOpenCodeQuota({
    usage: {
      rolling: { percent: -1 },
      weekly: { percent: '50' },
    },
  }).status, 'unavailable')
  // Missing upstream fields must be absent, not present as undefined, so tool results stay JSON-safe.
  for (const view of [
    quota,
    parseOpenAIQuota({
      rate_limit: {
        primary_window: { used_percent: 12, limit_window_seconds: 18000 },
      },
    }),
  ]) {
    assert.deepEqual(JSON.parse(JSON.stringify(view)), view)
  }
  assert.ok(!('resetsAt' in quota.windows[1]!))
})

it('openCode browser OAuth binds an organization and refreshes without losing identity', async () => {
  const previousFetch = globalThis.fetch
  const calls: { url: string, init?: RequestInit }[] = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    calls.push({ url, init })
    assert.equal(init?.redirect, 'error')
    if (url.endsWith('/auth/device/code')) {
      return Response.json({
        device_code: 'private-device',
        user_code: 'ABCD',
        verification_uri_complete: 'https://opencode.ai/console/auth/device?code=ABCD',
        expires_in: 300,
        interval: 0.001,
      })
    }
    if (url.endsWith('/auth/device/token')) {
      return Response.json({
        access_token: 'access-token',
        refresh_token: 'rotated-refresh',
        expires_in: 3600,
        org_id: 'org-selected',
      })
    }
    if (url.endsWith('/api/user'))
      return Response.json({ id: 'user-1', email: 'user@example.com' })
    if (url.endsWith('/api/orgs')) {
      return Response.json([
        { id: 'org-other', name: 'A' },
        { id: 'org-selected', name: 'Team' },
      ])
    }
    throw new Error('Unexpected OAuth URL')
  }
  try {
    const notices: unknown[] = []
    const tokens = await loginOpenCode({
      signal: new AbortController().signal,
      notify: notice => notices.push(notice),
      prompt: async () => { throw new Error('Unexpected prompt') },
    })
    assert.equal(tokens.accountId, 'user-1')
    assert.equal(tokens.orgId, 'org-selected')
    assert.equal(tokens.orgName, 'Team')
    assert.ok(!JSON.stringify(notices).includes('private-device'))
    const refreshed = await refreshOpenCode(tokens)
    assert.equal(refreshed.email, tokens.email)
    assert.equal(refreshed.orgName, 'Team')
    assert.equal(calls.length, 5)
    assert.match(String(calls[1]!.init?.body), /urn:ietf:params:oauth:grant-type:device_code/)
  }
  finally { globalThis.fetch = previousFetch }
})

it('openCode refuses an unexpected verification origin before notifying the browser', async () => {
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => Response.json({
    device_code: 'secret',
    user_code: 'code',
    verification_uri_complete: 'https://attacker.example/login',
    expires_in: 300,
    interval: 1,
  })
  try {
    await assert.rejects(loginOpenCode({
      signal: new AbortController().signal,
      notify: () => { throw new Error('Must not notify') },
      prompt: async () => '',
    }), /Unexpected OpenCode/)
  }
  finally { globalThis.fetch = previousFetch }
})

it('openCode refresh signs out only on 400 invalid_grant and keeps other HTTP failures', async () => {
  const previousFetch = globalThis.fetch
  const tokens = { access: 'access-token', refresh: 'private-refresh', expires: 0 }
  const respond = (status: number, body: unknown): void => {
    globalThis.fetch = async () => Response.json(body, { status })
  }
  try {
    respond(400, { error: 'invalid_grant' })
    await assert.rejects(refreshOpenCode(tokens), /invalid_grant; reconnect/)
    respond(400, { error: 'server_error' })
    await assert.rejects(refreshOpenCode(tokens), /HTTP 400/)
    respond(503, { error: 'invalid_grant' })
    await assert.rejects(refreshOpenCode(tokens), (error: Error) => /HTTP 503/.test(error.message) && !error.message.includes('reconnect'))
  }
  finally { globalThis.fetch = previousFetch }
})

it('openCode Go reports 403 as no allowance without masking other failures', async () => {
  const previousFetch = globalThis.fetch
  const stored = {
    id: 'a',
    channel: 'opencode-go',
    label: 'One',
    createdAt: '2026-01-01',
    credential: {
      kind: 'oauth',
      tokens: {
        access: 'private-access',
        refresh: 'private-refresh',
        expires: 1,
        orgId: 'org',
      },
    },
  } as const
  try {
    globalThis.fetch = async () => Response.json({ type: 'error' }, { status: 403 })
    const quota = await fetchQuota(stored)
    assert.equal(quota.status, 'unavailable')
    assert.deepEqual(quota.windows, [])
    globalThis.fetch = async () => Response.json({ type: 'error' }, { status: 401 })
    await assert.rejects(fetchQuota(stored), (error: unknown) => error instanceof ProviderHTTPError && error.status === 401)
  }
  finally { globalThis.fetch = previousFetch }
})

it('uI operations and the model-facing entry point share state but authentication stays user-only', async () => {
  let stored: CredentialRecord | undefined
  const ctx = {
    credentials: {
      readRecord: async () => structuredClone(stored),
      modifyRecord: async (_key: unknown, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) => {
        const value = await mutate(structuredClone(stored))
        if (value)
          stored = value
        return stored
      },
    },
  } as unknown as Context
  const service = new ModelAccountsService(ctx)
  let changes = 0
  service.onChange = () => changes++
  try {
    await assert.rejects(service.dispatch({
      action: 'add_key',
      channel: 'opencode-go',
      label: 'Forbidden',
      key: 'model-supplied',
    }, 'agent'), /user-only/)
    await assert.rejects(service.dispatch({ action: 'login_start', channel: 'openai-codex', label: 'Forbidden' }, 'agent'), /user-only/)
    await assert.rejects(service.dispatch({ action: 'refresh_quota', id: 'not-an-account' }, 'agent'), /Account not found/)
    await assert.rejects(service.dispatch({
      action: 'add_key',
      channel: 'opencode-go',
      label: 'Key',
      key: 'not-accepted',
    }, 'ui'), /not supported/)
    await service.dispatch({
      action: 'add_key',
      channel: 'commandcode-go',
      label: 'One',
      key: 'private-api-key-one',
    }, 'ui')
    assert.equal(changes, 1, 'the first API key must immediately publish its newly active model route')
    assert.deepEqual(await service.activeChannels(), ['commandcode-go'])
    await service.dispatch({
      action: 'add_key',
      channel: 'commandcode-go',
      label: 'Two',
      key: 'private-api-key-two',
    }, 'ui')
    const state = await service.accounts.list()
    await service.dispatch({ action: 'activate', channel: 'commandcode-go', id: state[1]!.id }, 'agent')
    assert.deepEqual(await service.activeChannels(), ['commandcode-go'])
    assert.ok(changes >= 1)
    const fromUI = await service.dispatch({ action: 'list' }, 'ui') as Record<string, unknown>
    delete fromUI.login
    const fromAgent = await service.dispatch({ action: 'list' }, 'agent')
    assert.deepEqual(fromUI, fromAgent)
    assert.ok(!JSON.stringify(fromAgent).includes('private-api-key'))
    await service.dispatch({ action: 'remove', id: state[1]!.id }, 'agent')
    assert.equal((await service.accounts.list())[0]!.active, false)
    assert.deepEqual(await service.activeChannels(), [])
  }
  finally { service.dispose() }
})

it('model generator rejects missing provider data and keeps only text tool models', () => {
  assert.deepEqual(sources, ['opencode-go', 'commandcode'])
  assert.throws(() => normalizeCatalog({}), /provider/)
  const models = {
    good: {
      id: 'good',
      name: 'Good',
      tool_call: true,
      interleaved: false,
      modalities: {
        input: ['text', 'image', 'pdf'],
        output: ['text'],
      },
      limit: { context: 128000, output: 8000 },
      reasoning_options: [
        {
          type: 'effort',
          values: ['low', 'high'],
        },
      ],
    },
    image: { id: 'image-only', tool_call: false },
  }
  const result = normalizeCatalog(Object.fromEntries(sources.map(source => [
    source,
    { models },
  ])))
  assert.deepEqual(Object.keys(result), sources)
  assert.equal(result['opencode-go'].length, 1)
  assert.deepEqual(result['opencode-go'][0].input, ['text', 'image'])
  assert.deepEqual(result['opencode-go'][0].reasoningEfforts, ['low', 'high'])
  assert.equal(result.commandcode.length, 1)
})
