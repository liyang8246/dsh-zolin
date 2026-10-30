import type { Context } from '@deepseek-ai/cordis'
import type { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { GenerateOptions, MessageId, ReasoningEffortId, StreamChunk, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { CatalogModel, ChannelId, LoginInteraction, LoginNotice, ModelCatalog, StoredAccount } from '../src/types.js'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { zstdDecompressSync } from 'node:zlib'
import { describe, it } from 'vitest'
import { loginOpenAI, refreshOpenAI } from '../src/openai.js'
import { createTransport } from '../src/transport.js'
import { record } from '../src/validation.js'

const model: CatalogModel = {
  id: 'demo',
  name: 'Demo',
  contextWindow: 128000,
  maxTokens: 4096,
  input: ['text', 'image'],
  reasoning: true,
  reasoningEfforts: ['low', 'medium', 'high'],
}
const catalog: ModelCatalog = {
  'openai': [model],
  'opencode-go': [model],
  'commandcode': [model],
}
function account(channel: ChannelId, id = 'first'): StoredAccount {
  return {
    id,
    channel,
    label: id,
    createdAt: '2026-01-01',
    credential: { kind: 'api-key', key: `secret-${id}` },
  }
}
const context = {
  get: () => undefined,
} as unknown as Context
function request(provider = 'zephyr-opencode-go'): GenerateOptions {
  return {
    provider,
    model: 'demo',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hello' },
        ],
      },
    ],
    sessionId: 'stable-session' as GenerateOptions['sessionId'],
  }
}
async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const result: StreamChunk[] = []
  for await (const chunk of stream) result.push(chunk)
  return result
}
function completion() {
  return [
    `data: ${JSON.stringify({
      id: 'c',
      model: 'demo',
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: 'hello' },
          finish_reason: null,
        },
      ],
    })}`,
    `data: ${JSON.stringify({
      id: 'c',
      model: 'demo',
      choices: [
        { index: 0, delta: {}, finish_reason: 'stop' },
      ],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 5,
        total_tokens: 17,
        prompt_tokens_details: { cached_tokens: 4 },
      },
    })}`,
    'data: [DONE]',
    '',
  ].join('\n\n')
}
function jwt() {
  return `e30.${Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: 'native-account' },
  })).toString('base64url')}.signature`
}
function codexSSE() {
  const output = {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    content: [
      { type: 'output_text', text: 'hello', annotations: [] },
    ],
    status: 'completed',
  }
  const events = [
    {
      type: 'response.created',
      response: { id: 'resp_1', status: 'in_progress' },
    },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...output, content: [], status: 'in_progress' },
    },
    {
      type: 'response.content_part.added',
      output_index: 0,
      content_index: 0,
      item_id: 'msg_1',
      part: { type: 'output_text', text: '', annotations: [] },
    },
    {
      type: 'response.output_text.delta',
      output_index: 0,
      content_index: 0,
      item_id: 'msg_1',
      delta: 'hello',
    },
    { type: 'response.output_item.done', output_index: 0, item: output },
    {
      type: 'response.completed',
      response: {
        id: 'resp_1',
        status: 'completed',
        output: [output],
        usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
      },
    },
  ]
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}
async function capture(input: string | URL | Request, init?: RequestInit) {
  const req = new Request(input, init)
  const bytes = Buffer.from(await req.arrayBuffer())
  const body: unknown = JSON.parse((req.headers.get('content-encoding') === 'zstd'
    ? zstdDecompressSync(bytes)
    : bytes).toString())
  return {
    url: req.url,
    headers: req.headers,
    body: record(body),
  }
}

// Tests patch fetch serially: no real credentials, providers, or profile state are used.
describe('provider transport and OAuth contracts', () => {
  it('prepared call captures one account, exposes prefixed route, and preserves wire attribution/session', async () => {
    let selected = account('opencode-go')
    let resolutions = 0
    const adapter = createTransport(context, async () => {
      resolutions++
      return selected
    }, catalog)
    assert.equal(adapter.providerInfo('zephyr-opencode-go').id, 'zephyr-opencode-go')
    assert.equal((await adapter.listModels('zephyr-opencode-go'))[0]?.provider, 'zephyr-opencode-go')
    const prepared = await adapter.prepareCall('zephyr-opencode-go', 'demo')
    selected.credential = { kind: 'api-key', key: 'mutated-after-prepare' }
    selected = account('opencode-go', 'second')
    let sent: Awaited<ReturnType<typeof capture>> | undefined
    const saved = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      sent = await capture(input, init)
      return new Response(completion(), {
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    try {
      const chunks = await collect(prepared.stream(request()))
      assert.equal(resolutions, 1)
      assert.ok(sent)
      assert.match(sent.url, /opencode\.ai\/inference\/go\/openai\/v1\/chat\/completions$/)
      assert.equal(sent.headers.get('authorization'), 'Bearer secret-first')
      assert.equal(sent.headers.get('x-opencode-session'), 'stable-session')
      assert.match(sent.headers.get('user-agent') ?? '', /^dsh-zephyr\//)
      assert.deepEqual(chunks.filter(chunk => chunk.type === 'finish').map(chunk => chunk.reason.kind), ['stop'])
      const usage = chunks.find(chunk => chunk.type === 'usage')
      assert.ok(usage)
      assert.equal(usage.usage.inputTokens, 8)
      assert.equal(usage.usage.cacheReadTokens, 4)
      const finish = chunks.at(-1)
      assert.ok(finish?.type === 'finish' && !JSON.stringify(finish.replayState).includes('secret-first'))
    }
    finally { globalThis.fetch = saved }
  })

  it('tool arguments stream and settle as one complete tool call', async () => {
    const saved = globalThis.fetch
    const frames = [
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'lookup', arguments: '{"x":' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: '1}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          { index: 0, delta: {}, finish_reason: 'tool_calls' },
        ],
      },
    ]
    globalThis.fetch = async () => new Response(`${frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    })
    try {
      const adapter = createTransport(context, async () => account('opencode-go'), catalog)
      const chunks = await collect(adapter.stream(request()))
      const end = chunks.find(chunk => chunk.type === 'block-end')
      assert.ok(end)
      assert.deepEqual(end.block, {
        type: 'tool-call',
        id: 'call_1',
        name: 'lookup',
        arguments: '{"x":1}',
      })
      assert.deepEqual(chunks.filter(chunk => chunk.type === 'block-start').length, 1)
      const finish = chunks.at(-1)
      assert.ok(finish?.type === 'finish')
      assert.equal(finish.reason.kind, 'tool-calls')
    }
    finally { globalThis.fetch = saved }
  })

  it('images use verified attachments and appear in the request; absent service is an explicit error', async () => {
    const attachments = {
      readImage: async () => ({
        data: new Uint8Array([1, 2, 3]),
        ref: { mediaType: 'image/png' },
      }),
    }
    const imageContext = {
      get: () => attachments,
    } as unknown as Context
    const options = request()
    options.messages = [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            attachment: {
              attachmentId: 'image' as AttachmentId,
              mediaType: 'image/png',
              width: 1,
              height: 1,
              bytes: 3,
            },
          },
        ],
      },
    ]
    const saved = globalThis.fetch
    let body: Record<string, unknown> | undefined
    globalThis.fetch = async (input, init) => {
      body = (await capture(input, init)).body
      return new Response(completion(), {
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    try {
      await collect(createTransport(imageContext, async () => account('opencode-go'), catalog).stream(options))
      assert.ok(JSON.stringify(body).includes('data:image/png;base64,AQID'))
      const absent = await collect(createTransport(context, async () => account('opencode-go'), catalog).stream(options))
      const finish = absent.at(-1)
      assert.ok(finish?.type === 'finish')
      assert.equal(finish.reason.kind, 'error')
      assert.match(JSON.stringify(finish), /attachment service is unavailable/)
    }
    finally { globalThis.fetch = saved }
  })

  it('codex reuses Responses transport and never sends another account/channel encrypted replay', async () => {
    const selected: StoredAccount = {
      ...account('openai-codex'),
      credential: {
        kind: 'oauth',
        tokens: {
          access: jwt(),
          refresh: 'refresh-secret',
          expires: Date.now() + 60000,
        },
      },
    }
    const saved = globalThis.fetch
    const bodies: Record<string, unknown>[] = []
    globalThis.fetch = async (input, init) => {
      const sent = await capture(input, init)
      assert.match(sent.url, /backend-api\/codex\/responses$/)
      bodies.push(sent.body)
      return new Response(codexSSE(), {
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    try {
      const adapter = createTransport(context, async () => selected, catalog)
      const options = request('zephyr-openai-codex')
      const reasoning = {
        type: 'reasoning',
        id: 'rs_1',
        summary: [
          { type: 'summary_text', text: 'reason' },
        ],
        encrypted_content: 'private-signature',
      }
      const history = {
        id: 'm1' as MessageId,
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'reason' },
          { type: 'text', text: 'prior' },
        ],
        source: {
          kind: 'model',
          provider: options.provider,
          model: 'demo',
          replayState: {
            response: {
              kind: 'zephyr-pi',
              version: 1,
              channel: 'openai-codex',
              account: 'other',
              model: 'demo',
            },
            blocks: [
              {
                thinkingSignature: JSON.stringify(reasoning),
              },
              {},
            ],
          },
        },
      } satisfies GenerateOptions['messages'][number]
      options.messages = [history, ...options.messages]
      const first = await collect(adapter.stream(options))
      const finish = first.at(-1)
      assert.ok(finish?.type === 'finish')
      assert.equal(finish.reason.kind, 'stop')
      assert.ok(!JSON.stringify(bodies[0]).includes('private-signature'))
      history.source.replayState.response.account = selected.id
      await collect(adapter.stream(options))
      assert.ok(JSON.stringify(bodies[1]).includes('private-signature'))
      history.source.replayState.response.channel = 'opencode-go'
      await collect(adapter.stream(options))
      assert.ok(!JSON.stringify(bodies[2]).includes('private-signature'))
    }
    finally { globalThis.fetch = saved }
  })

  it('openCode organization, file handles, and reasoning_content survive projection', async () => {
    const selected: StoredAccount = {
      ...account('opencode-go'),
      credential: {
        kind: 'oauth',
        tokens: {
          access: 'oauth-access',
          refresh: 'oauth-refresh',
          expires: Date.now() + 60000,
          orgId: 'org_1',
        },
      },
    }
    const fileContext = {
      get: () => undefined,
      llm: {
        fileRequestText: () => '[file: report.txt at /readonly/report.txt]',
      },
    } as unknown as Context
    const localCatalog: ModelCatalog = {
      ...catalog,
      'opencode-go': [
        { ...model, reasoningField: 'reasoning_content' },
      ],
    }
    const options = request()
    options.messages = [
      {
        role: 'assistant',
        id: 'assistant' as MessageId,
        source: { kind: 'model', provider: options.provider, model: 'demo' },
        content: [
          { type: 'reasoning', text: 'previous reasoning' },
          { type: 'text', text: 'previous response' },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'file',
            attachment: { attachmentId: 'file' as AttachmentId, name: 'report.txt', bytes: 10 },
          },
        ],
      },
    ]
    const saved = globalThis.fetch
    let sent: Awaited<ReturnType<typeof capture>> | undefined
    globalThis.fetch = async (input, init) => {
      sent = await capture(input, init)
      return new Response(completion(), {
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    try {
      await collect(createTransport(fileContext, async () => selected, localCatalog).stream(options))
      assert.ok(sent)
      assert.equal(sent.headers.get('x-opencode-org-id'), 'org_1')
      assert.equal(sent.headers.get('authorization'), 'Bearer oauth-access')
      assert.ok(JSON.stringify(sent.body).includes('/readonly/report.txt'))
      assert.ok(Array.isArray(sent.body.messages))
      const assistant = sent.body.messages.map((message: unknown) => record(message)).find(message => message.role === 'assistant')
      assert.ok(assistant)
      assert.equal(assistant.reasoning_content, 'previous reasoning')
    }
    finally { globalThis.fetch = saved }
  })

  it('hTTP status and Retry-After are retained without leaking credentials', async () => {
    const saved = globalThis.fetch
    globalThis.fetch = async () => Response.json({
      error: { message: 'Too many requests for secret-first', type: 'rate_limit_error' },
    }, {
      status: 429,
      headers: { 'retry-after': '7' },
    })
    try {
      const chunks = await collect(createTransport(context, async () => account('opencode-go'), catalog).stream(request()))
      const finish = chunks.at(-1)
      assert.ok(finish?.type === 'finish')
      assert.ok(finish.reason.kind === 'error')
      assert.equal(finish.reason.failure.code, 'RATE_LIMIT')
      assert.equal(finish.reason.failure.status, 429)
      assert.equal(finish.reason.failure.providerRetryAfterMs, 7000)
      assert.ok(!JSON.stringify(finish).includes('secret-first'))
    }
    finally { globalThis.fetch = saved }
  })

  it('oversized images request durable offloading instead of silently dropping content', async () => {
    const imageContext = {
      get: () => ({
        readImage: async () => ({
          data: new Uint8Array(16 * 1024 * 1024),
          ref: { mediaType: 'image/png' },
        }),
      }),
    } as unknown as Context
    const options = request()
    options.messages = [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            attachment: {
              attachmentId: 'image' as AttachmentId,
              mediaType: 'image/png',
              width: 1,
              height: 1,
              bytes: 16 * 1024 * 1024,
            },
          },
        ],
      },
    ]
    const chunks = await collect(createTransport(imageContext, async () => account('opencode-go'), catalog).stream(options))
    const finish = chunks.at(-1)
    assert.ok(finish?.type === 'finish')
    assert.ok(finish.reason.kind === 'error')
    assert.equal(finish.reason.failure.code, 'IMAGE_OFFLOAD_REQUIRED')
    assert.equal(finish.reason.failure.offloadImages, 1)
  })

  it('cancellation after a usage yield cannot expose a buffered successful finish', async () => {
    const saved = globalThis.fetch
    globalThis.fetch = async () => new Response(completion(), {
      headers: { 'content-type': 'text/event-stream' },
    })
    const controller = new AbortController()
    try {
      const iterator = createTransport(context, async () => account('opencode-go'), catalog).stream({
        ...request(),
        signal: controller.signal,
      })[Symbol.asyncIterator]()
      while (true) {
        const next = await iterator.next()
        assert.ok(!next.done)
        if (next.value.type === 'usage')
          break
      }
      controller.abort()
      const next = await iterator.next()
      assert.ok(!next.done && next.value.type === 'finish')
      assert.equal(next.value.reason.kind, 'aborted')
      assert.equal((await iterator.next()).done, true)
    }
    finally { globalThis.fetch = saved }
  })

  it('aborted requests settle once without provider access', async () => {
    const controller = new AbortController()
    const adapter = createTransport(context, async () => account('opencode-go'), catalog)
    const prepared = await adapter.prepareCall('zephyr-opencode-go', 'demo')
    controller.abort()
    const chunks = await collect(prepared.stream({
      ...request(),
      signal: controller.signal,
    }))
    assert.equal(chunks.length, 1)
    assert.ok(chunks[0]?.type === 'finish')
    assert.equal(chunks[0].reason.kind, 'aborted')
  })

  it('explicit none disables Codex reasoning instead of clamping to low', async () => {
    const quiet: CatalogModel = {
      ...model,
      reasoningEfforts: ['none', 'low', 'high'],
    }
    const selected: StoredAccount = {
      ...account('openai-codex'),
      credential: {
        kind: 'oauth',
        tokens: {
          access: jwt(),
          refresh: 'r',
          expires: Date.now() + 60000,
        },
      },
    }
    const saved = globalThis.fetch
    const bodies: Record<string, unknown>[] = []
    globalThis.fetch = async (input, init) => {
      bodies.push((await capture(input, init)).body)
      return new Response(codexSSE(), {
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    try {
      const adapter = createTransport(context, async () => selected, {
        ...catalog,
        openai: [quiet],
      })
      await collect(adapter.stream({
        ...request('zephyr-openai-codex'),
        reasoningEffort: 'none' as ReasoningEffortId,
      }))
      await collect(adapter.stream({
        ...request('zephyr-openai-codex'),
        reasoningEffort: 'low' as ReasoningEffortId,
      }))
      assert.equal(record(bodies[0].reasoning).effort, 'none')
      assert.equal(record(bodies[1].reasoning).effort, 'low')
    }
    finally { globalThis.fetch = saved }
  })

  it('codex history from another account drops Responses item ids but keeps call ids', async () => {
    const selected: StoredAccount = {
      ...account('openai-codex'),
      credential: {
        kind: 'oauth',
        tokens: {
          access: jwt(),
          refresh: 'r',
          expires: Date.now() + 60000,
        },
      },
    }
    const saved = globalThis.fetch
    let body: Record<string, unknown> | undefined
    globalThis.fetch = async (input, init) => {
      body = (await capture(input, init)).body
      return new Response(codexSSE(), {
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    try {
      const options = request('zephyr-openai-codex')
      options.messages = [
        {
          role: 'assistant',
          id: 'a' as MessageId,
          source: {
            kind: 'model',
            provider: options.provider,
            model: 'demo',
            replayState: {
              response: {
                kind: 'zephyr-pi',
                version: 1,
                channel: 'openai-codex',
                account: 'other',
                model: 'demo',
              },
              blocks: [{}],
            },
          },
          content: [
            {
              type: 'tool-call',
              id: 'call_1|fc_item' as ToolCallId,
              name: 'lookup',
              arguments: '{}',
            },
          ],
        },
        {
          role: 'tool',
          id: 't' as MessageId,
          toolCallId: 'call_1|fc_item' as ToolCallId,
          isError: false,
          content: [
            { type: 'text', text: 'ok' },
          ],
          source: { kind: 'tool', callId: 'call_1|fc_item' as ToolCallId },
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'continue' },
          ],
        },
      ]
      const chunks = await collect(createTransport(context, async () => selected, catalog).stream(options))
      const finish = chunks.at(-1)
      assert.ok(finish?.type === 'finish')
      assert.equal(finish.reason.kind, 'stop')
      assert.ok(body && Array.isArray(body.input))
      const items = body.input.map((item: unknown) => record(item))
      const call = items.find(item => item.type === 'function_call')
      const result = items.find(item => item.type === 'function_call_output')
      assert.ok(call && result)
      assert.equal(call.id, undefined)
      assert.equal(call.call_id, 'call_1')
      assert.equal(result.call_id, 'call_1')
    }
    finally { globalThis.fetch = saved }
  })

  it('openAI login uses the browser callback flow and refresh reuses pi OAuth', async () => {
    const saved = globalThis.fetch
    try {
      globalThis.fetch = async (input) => {
        assert.match(String(input), /auth\.openai\.com\/oauth\/token$/)
        return Response.json({
          access_token: jwt(),
          refresh_token: 'refresh-value',
          expires_in: 3600,
        })
      }
      const refreshed = await refreshOpenAI({
        access: jwt(),
        refresh: 'old-refresh',
        expires: 0,
      })
      assert.equal(refreshed.accountId, 'native-account')
      assert.equal(refreshed.refresh, 'refresh-value')

      const notices: LoginNotice[] = []
      const prompts: Parameters<LoginInteraction['prompt']>[] = []
      const controller = new AbortController()
      let network = 0
      globalThis.fetch = async () => {
        network++
        throw new Error('Browser login must not exchange a token before consent')
      }
      const login = loginOpenAI({
        signal: controller.signal,
        notify: notice => notices.push(notice),
        prompt: (message, signal) => {
          prompts.push([message, signal])
          return new Promise((_, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('prompt aborted')), { once: true })
          })
        },
      })
      const deadline = Date.now() + 10_000
      while (!notices.some(notice => notice.url) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
      const notice = notices.find(value => value.url)
      assert.ok(notice?.url, 'the browser authorization URL was announced')
      const url = new URL(notice.url)
      assert.equal(url.origin, 'https://auth.openai.com')
      assert.equal(url.pathname, '/oauth/authorize')
      assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:1455/auth/callback')
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
      assert.ok(prompts[0])
      assert.match(prompts[0][0], /paste/i)
      controller.abort()
      await assert.rejects(login)
      assert.equal(network, 0)
      assert.ok(!JSON.stringify(notices).includes('refresh-value'))
    }
    finally { globalThis.fetch = saved }
  })
})
