import type { Context } from '@deepseek-ai/cordis'
import type { CatalogModel, ChannelId, ModelCatalog, StoredAccount } from '../src/types.js'
import assert from 'node:assert/strict'
import { it } from 'vitest'
import { fetchCodexModels, parseCodexModels } from '../src/codex-models.js'
import { createTransport } from '../src/transport.js'

const payload = {
  models: [
    {
      slug: 'gpt-6.1-sol',
      display_name: 'GPT-6.1-Sol',
      supported_in_api: true,
      visibility: 'list',
      context_window: 500000,
      max_context_window: 872000,
      input_modalities: ['text', 'image'],
      supported_reasoning_levels: [
        { effort: 'low' },
        { effort: 'ultra' },
      ],
    },
    {
      slug: 'gpt-reserve',
      display_name: 'GPT-Reserve',
      supported_in_api: true,
      visibility: 'hide',
      context_window: 272000,
      input_modalities: ['text'],
    },
    {
      slug: 'image-only',
      display_name: 'Image',
      supported_in_api: false,
      visibility: 'list',
      context_window: 272000,
    },
  ],
}

it('codex model list keeps only listed API models with their reported metadata', () => {
  const models = parseCodexModels(payload)
  assert.deepEqual(models.map(model => model.id), ['gpt-6.1-sol'])
  assert.deepEqual(models[0], {
    id: 'gpt-6.1-sol',
    name: 'GPT-6.1-Sol',
    contextWindow: 500000,
    maxTokens: 128000,
    input: ['text', 'image'],
    reasoning: true,
    reasoningEfforts: ['low', 'ultra'],
  })
  assert.throws(() => parseCodexModels({
    models: [payload.models[1]],
  }), /no usable models/)
  assert.throws(() => parseCodexModels({ models: 'nope' }), /Invalid Codex model list/)
})

it('codex model fetch authenticates with the account and never follows redirects', async () => {
  const saved = globalThis.fetch
  let url = ''
  let headers = new Headers()
  globalThis.fetch = async (input, init) => {
    url = String(input)
    headers = new Headers(init?.headers)
    assert.equal(init?.redirect, 'error')
    return Response.json(payload)
  }
  try {
    const account: StoredAccount = {
      id: 'a',
      channel: 'openai-codex',
      label: 'A',
      createdAt: '2026-01-01',
      credential: {
        kind: 'oauth',
        tokens: {
          access: 'private-access',
          refresh: 'private-refresh',
          expires: 0,
          accountId: 'acct-1',
        },
      },
    }
    const models = await fetchCodexModels(account)
    assert.deepEqual(models.map(model => model.id), ['gpt-6.1-sol'])
    assert.match(url, /^https:\/\/chatgpt\.com\/backend-api\/codex\/models\?client_version=\d+\.\d+\.\d+$/)
    assert.equal(headers.get('authorization'), 'Bearer private-access')
    assert.equal(headers.get('chatgpt-account-id'), 'acct-1')
    await assert.rejects(fetchCodexModels({
      ...account,
      credential: { kind: 'api-key', key: 'secret' },
    }), /requires OAuth/)
  }
  finally { globalThis.fetch = saved }
})

const fallback: CatalogModel = {
  id: 'demo',
  name: 'Demo',
  contextWindow: 1000,
  maxTokens: 100,
  input: ['text'],
  reasoning: false,
  reasoningEfforts: [],
}
const live: CatalogModel = {
  id: 'gpt-live-only',
  name: 'Live',
  contextWindow: 500000,
  maxTokens: 128000,
  input: ['text'],
  reasoning: false,
  reasoningEfforts: [],
}
const catalog: ModelCatalog = {
  'openai': [fallback],
  'opencode-go': [fallback],
  'commandcode': [fallback],
}
const context = {
  get: () => undefined,
} as unknown as Context
function account(channel: ChannelId): StoredAccount {
  return {
    id: 'a',
    channel,
    label: 'a',
    createdAt: '2026-01-01',
    credential: {
      kind: 'oauth',
      tokens: { access: 'access', refresh: 'refresh', expires: Date.now() + 60_000 },
    },
  }
}

it('a live Codex catalog replaces the snapshot and stays usable when the refresh fails', async () => {
  let refresh = 0
  const list = createTransport(context, async () => account('openai-codex'), catalog, async (channel) => {
    refresh++
    assert.equal(channel, 'openai-codex')
    catalog.openai = [live]
  })
  const models = await list.listModels('zephyr-openai-codex')
  assert.deepEqual(models.map(model => model.id), ['gpt-live-only'])
  assert.equal(refresh, 1)
  assert.equal((await list.resolveModel('zephyr-openai-codex', 'gpt-live-only')).context?.contextWindow, 500000)

  // A failing refresh keeps the previous catalog instead of breaking the call.
  const broken = createTransport(context, async () => account('openai-codex'), {
    ...catalog,
    openai: [live],
  }, async () => { throw new Error('unavailable') })
  assert.deepEqual((await broken.listModels('zephyr-openai-codex')).map(model => model.id), ['gpt-live-only'])
})
