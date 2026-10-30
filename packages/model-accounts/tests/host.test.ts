import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { AdapterRegistrationHandle } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { setImmediate } from 'node:timers/promises'
import { it } from 'vitest'
import { apply } from '../src/index.js'

type Route = Parameters<Context['connection']['fetch']['register']>[0]

it('first key activates a route immediately; later mutations replace routes and dispose cleanly', async () => {
  let stored: CredentialRecord | undefined
  let route: Route | undefined
  let tool: ToolDefinition | undefined
  let providers: string[] = []
  let registrations = 0
  let replacements = 0
  const cleanups: (() => void)[] = []
  const ctx = {
    get: () => undefined,
    effect: (effect: () => () => void) => { cleanups.push(effect()) },
    credentials: {
      readRecord: async () => structuredClone(stored),
      modifyRecord: async (_key: unknown, mutate: (value: CredentialRecord | undefined) => Promise<CredentialRecord>) => {
        stored = structuredClone(await mutate(structuredClone(stored)))
        return stored
      },
    },
    llm: {
      registerAdapter: (next: string[]): AdapterRegistrationHandle => {
        registrations++
        providers = next
        return Object.assign(() => {
          providers = []
        }, {
          replace: (next: string[]) => {
            providers = next
            replacements++
          },
        })
      },
    },
    tools: {
      register: (value: ToolDefinition) => {
        tool = value
        return () => {}
      },
    },
    connection: {
      fetch: {
        register: (value: Route) => {
          route = value
          return () => {}
        },
      },
    },
  } as unknown as Context
  apply(ctx)
  const call = async (value: unknown): Promise<Response> => {
    assert.ok(route)
    return route.fetch(new Request('http://localhost/api/zephyr-models', {
      method: 'POST',
      body: JSON.stringify(value),
    }))
  }
  try {
    await setImmediate()
    assert.equal(registrations, 0)
    const added = await call({
      action: 'add_key',
      channel: 'commandcode-go',
      label: 'One',
      key: 'user_fake_test_secret',
    })
    assert.equal(added.status, 200)
    assert.equal(added.headers.get('cache-control'), 'no-store')
    assert.ok(!(await added.text()).includes('user_fake_test_secret'))
    await setImmediate()
    assert.deepEqual(providers, ['zephyr-commandcode-go'])
    assert.equal(registrations, 1)
    assert.ok(tool)
    assert.equal(tool.name, 'zephyr_accounts')
    await call({ action: 'deactivate', channel: 'commandcode-go' })
    await setImmediate()
    assert.deepEqual(providers, [])
    assert.equal(registrations, 1)
    assert.equal(replacements, 1)
    const oversized = await call({
      action: 'rename',
      id: 'missing',
      label: 'x'.repeat(70_000),
    })
    assert.equal(oversized.status, 400)
  }
  finally {
    for (const cleanup of cleanups.reverse()) cleanup()
  }
  assert.deepEqual(providers, [])
  assert.equal((await call({ action: 'list' })).status, 400)
})

it('account bundle exports only its own Host and Client', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8')) as { name: string, exports: Record<string, string> }
  assert.equal(manifest.name, 'dsh-model-accounts')
  assert.equal(manifest.exports['./uv-run'], undefined)
  for (const name of ['.', './client']) await readFile(manifest.exports[name]!)
  const patch = await readFile('cordis.patch.yml', 'utf8')
  assert.match(patch, /name: dsh-model-accounts/u)
  assert.doesNotMatch(patch, /preset-zephyr|dsh-persona|uv-run/u)
})
