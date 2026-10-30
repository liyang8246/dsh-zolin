import type { Context } from '@deepseek-ai/cordis'
import type { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { GenerateOptions, MessageId, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { CatalogModel, StoredAccount } from '../src/types.ts'
import assert from 'node:assert/strict'
import { it, vi } from 'vitest'
import { buildCommandCodeRequest, CommandCodeError, fetchCommandCodeQuota, parseCommandCodeEvents, parseCommandCodeQuota, streamCommandCode } from '../src/commandcode.ts'
import { record } from '../src/validation.ts'

const account: StoredAccount = {
  id: 'one',
  channel: 'commandcode-go',
  label: 'Personal',
  createdAt: '2026-10-29',
  credential: { kind: 'api-key', key: 'user_test_secret' },
}
const model: CatalogModel = {
  id: 'test/model',
  name: 'Test',
  contextWindow: 128000,
  maxTokens: 64000,
  input: ['text'],
  reasoning: true,
  reasoningEfforts: ['low', 'high'],
}
function options(): GenerateOptions {
  return {
    provider: 'commandcode-go',
    model: model.id,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Hi' },
        ],
      },
    ],
  }
}
const context = {} as Context
const encoder = new TextEncoder()
const events = (...values: unknown[]) => `${values.map(value => JSON.stringify(value)).join('\n')}\n`
function body(text: string, chunkSize = 7) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const bytes = encoder.encode(text)
      for (let offset = 0; offset < bytes.length; offset += chunkSize) controller.enqueue(bytes.slice(offset, offset + chunkSize))
      controller.close()
    },
  })
}
async function collect<T>(input: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = []
  for await (const value of input) values.push(value)
  return values
}
async function withFetch<T>(implementation: typeof fetch, callback: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = implementation
  try {
    return await callback()
  }
  finally { globalThis.fetch = original }
}
function mockResponse(text: string) {
  return new Response(body(text), {
    headers: { 'Content-Type': 'application/x-ndjson' },
  })
}
const stream = (input = options()) => streamCommandCode(context, input, account, model)

// Global fetch replacement is serial: these tests do not use concurrent:true.
it('commandCode request matches CLI envelope and preserves history/tools/reasoning', () => {
  const input = options()
  input.system = 'Policy'
  input.messages.push(...[
    {
      role: 'assistant',
      id: 'a' as MessageId,
      source: { kind: 'model', provider: 'commandcode-go', model: model.id },
      content: [
        { type: 'reasoning', text: 'Consider' },
        {
          type: 'tool-call',
          id: 'call' as ToolCallId,
          name: 'read',
          arguments: '{"path":"a.ts"}',
        },
      ],
    },
    {
      role: 'tool',
      id: 't' as MessageId,
      source: { kind: 'tool', callId: 'call' as ToolCallId },
      toolCallId: 'call' as ToolCallId,
      isError: true,
      content: [
        { type: 'text', text: 'missing' },
      ],
    },
  ] satisfies GenerateOptions['messages'])
  input.reasoningEffort = 'high' as ReasoningEffortId
  input.tools = [
    {
      name: 'read',
      description: 'Read a file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
        },
        required: ['path'],
      },
    },
  ]
  const request = buildCommandCodeRequest(input, model)
  assert.equal(request.config.environment, `${process.platform}-${process.arch}`)
  assert.equal(request.config.workingDir, '.')
  assert.equal(request.permissionMode, 'standard')
  assert.equal(request.memory, null)
  assert.equal(request.params.system, 'Policy')
  assert.equal(request.params.max_tokens, 64000)
  assert.equal(request.params.stream, true)
  assert.equal(request.params.reasoning_effort, 'high')
  assert.deepEqual(request.params.tools[0].input_schema, input.tools[0].parameters)
  assert.deepEqual(request.params.messages[1], {
    role: 'assistant',
    content: [
      { type: 'reasoning', text: 'Consider' },
      {
        type: 'tool-call',
        toolCallId: 'call' as ToolCallId,
        toolName: 'read',
        input: { path: 'a.ts' },
      },
    ],
  })
  assert.deepEqual(request.params.messages[2], {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'call' as ToolCallId,
        toolName: 'read',
        output: { type: 'error-text', value: 'missing' },
      },
    ],
  })
})

it('commandCode rejects unprojected images and unsupported controls rather than dropping them', () => {
  const input = options()
  input.messages = [
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
            bytes: 1,
          },
        },
      ],
    },
  ]
  assert.throws(() => buildCommandCodeRequest(input, model), /text-only.*image/)
  assert.throws(() => buildCommandCodeRequest({
    ...options(),
    stop: ['END'],
  }, model), /stop-sequence/)
  assert.throws(() => buildCommandCodeRequest({
    ...options(),
    maxTokens: 64001,
  }, model), /token limit/)
  assert.throws(() => buildCommandCodeRequest({
    ...options(),
    reasoningEffort: 'off' as ReasoningEffortId,
  }, model), /reasoning effort/)
})

it('only developer tool bookkeeping is omitted from the complete declarations route', () => {
  const input = options()
  const content = [
    { type: 'tool-addition', toolName: 'read' },
    { type: 'tool-removal', toolName: 'old' },
  ] satisfies GenerateOptions['messages'][number]['content']
  input.messages.unshift({
    role: 'developer',
    id: 'd' as MessageId,
    source: { kind: 'user' },
    content,
  })
  assert.equal(buildCommandCodeRequest(input, model).params.messages.length, 1)
  input.messages = [
    { role: 'user', content },
  ]
  assert.throws(() => buildCommandCodeRequest(input, model), /text-only.*tool-addition/)
})

it('invalid stored keys fail before provider access', async () => {
  await withFetch(async () => {
    throw new Error('Invalid keys must not reach fetch')
  }, async () => {
    for (const key of [
      '',
      ' ',
      'key\r\nheader',
      'key\u0000tail',
    ]) {
      const invalid: StoredAccount = {
        ...account,
        credential: { kind: 'api-key', key },
      }
      await assert.rejects(() => collect(streamCommandCode(context, options(), invalid, model)), (error: unknown) => error instanceof CommandCodeError && error.code === 'AUTH')
      await assert.rejects(() => fetchCommandCodeQuota(invalid), (error: unknown) => error instanceof CommandCodeError && error.code === 'AUTH')
    }
  })
})

it('nDJSON parser bounds UTF-8 bytes and rejects malformed event envelopes', async () => {
  const wire = events({
    type: 'text-delta',
    text: '界'.repeat(750_000),
  })
  assert.ok(wire.length < 2 * 1024 * 1024)
  for (const text of [
    wire,
    wire.trimEnd(),
  ]) {
    await assert.rejects(() => collect(parseCommandCodeEvents(body(text, text.length * 3))), (error: unknown) => error instanceof CommandCodeError && error.code === 'INVALID_RESPONSE')
  }
  for (const text of [
    'null',
    '[]',
    '{"type":1}',
    '{"type":""}',
  ]) {
    await assert.rejects(() => collect(parseCommandCodeEvents(body(text))), /Invalid.*event/)
  }
})

it('nDJSON parser handles split multibyte Unicode, CRLF, final partial line and optional SSE', async () => {
  const wire = ': ping\r\nevent: message\r\ndata: {"type":"text-delta","text":"你好🙂"}\r\n' + '{"type":"finish"}'
  assert.deepEqual(await collect(parseCommandCodeEvents(body(wire, 1))), [
    { type: 'text-delta', text: '你好🙂' },
    { type: 'finish' },
  ])
  await assert.rejects(() => collect(parseCommandCodeEvents(body('{not json}\n'))), /Malformed/)
})

it('stream closes the matching interleaved text/reasoning blocks and uses final authoritative usage', async () => {
  const wire = events(
    { type: 'reasoning-start', id: 'r' },
    { type: 'reasoning-delta', id: 'r', text: 'Think' },
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', text: 'Answer' },
    { type: 'reasoning-end', id: 'r' },
    { type: 'text-end', id: 't' },
    {
      type: 'finish-step',
      usage: { inputTokens: 1, outputTokens: 1 },
      finishReason: 'stop',
    },
    {
      type: 'finish',
      finishReason: 'stop',
      totalUsage: {
        inputTokens: 20,
        outputTokens: 5,
        inputTokenDetails: { cacheReadTokens: 8, cacheWriteTokens: 2 },
        outputTokenDetails: { reasoningTokens: 3 },
      },
    },
  )
  await withFetch(async (url, init) => {
    assert.equal(url, 'https://api.commandcode.ai/alpha/generate')
    assert.equal(init?.redirect, 'error')
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer user_test_secret')
    assert.equal(new Headers(init?.headers).get('x-command-code-version'), '1.88.2')
    return mockResponse(wire)
  }, async () => {
    const output = await collect(stream())
    assert.deepEqual(output.filter(chunk => chunk.type === 'block-end'), [
      {
        type: 'block-end',
        index: 0,
        block: { type: 'reasoning', text: 'Think' },
      },
      {
        type: 'block-end',
        index: 1,
        block: { type: 'text', text: 'Answer' },
      },
    ])
    assert.deepEqual(output.at(-2), {
      type: 'usage',
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 25,
        cacheReadTokens: 8,
        cacheWriteTokens: 2,
        reasoningTokens: 3,
      },
    })
    assert.deepEqual(output.at(-1), {
      type: 'finish',
      reason: { kind: 'stop' },
    })
    assert.equal(output.filter(chunk => chunk.type === 'finish').length, 1)
  })
})

it('stream maps incremental and complete tool calls exactly once', async () => {
  const wire = events(
    { type: 'tool-input-start', id: 'c', toolName: 'read' },
    { type: 'tool-input-delta', id: 'c', delta: '{"path":' },
    { type: 'tool-input-delta', id: 'c', delta: '"x"}' },
    { type: 'tool-input-end', id: 'c' },
    {
      type: 'tool-call',
      toolCallId: 'c',
      toolName: 'read',
      input: { path: 'x' },
    },
    {
      type: 'finish-step',
      finishReason: 'tool-calls',
      usage: { inputTokens: 2, outputTokens: 3 },
    },
    { type: 'finish', finishReason: 'tool-calls' },
  )
  await withFetch(async () => mockResponse(wire), async () => {
    const output = await collect(stream())
    assert.equal(output.filter(chunk => chunk.type === 'block-start').length, 1)
    assert.deepEqual(output.find(chunk => chunk.type === 'block-end'), {
      type: 'block-end',
      index: 0,
      block: {
        type: 'tool-call',
        id: 'c',
        name: 'read',
        arguments: '{"path":"x"}',
      },
    })
    assert.deepEqual(output.at(-1), {
      type: 'finish',
      reason: { kind: 'tool-calls' },
    })
  })
})

it('only a real finish event completes the stream, not finish-step or [DONE]', async () => {
  for (const wire of [
    events({ type: 'finish-step', finishReason: 'stop' }),
    '[DONE]\n',
    events({ type: 'text-delta', text: 'partial' }),
  ]) {
    await withFetch(async () => mockResponse(wire), async () => {
      await assert.rejects(() => collect(stream()), (error: unknown) => error instanceof CommandCodeError && error.code === 'STREAM_CLOSED')
    })
  }
  await withFetch(async () => mockResponse(events({ type: 'tool-input-start', id: 'c', toolName: 'read' }, { type: 'tool-input-delta', id: 'c', delta: '{' }, { type: 'finish' })), async () => {
    await assert.rejects(() => collect(stream()), /incomplete JSON/)
  })
})

it('hTTP and in-stream errors retain safe codes, retry delay and redacted diagnostics', async () => {
  await withFetch(async () => new Response('{"error":{"message":"user_test_secret: too many requests"}}', {
    status: 429,
    headers: { 'retry-after': '2' },
  }), async () => {
    await assert.rejects(() => collect(stream()), (error: unknown) => {
      assert.ok(error instanceof CommandCodeError)
      assert.equal(error.code, 'RATE_LIMIT')
      assert.equal(error.status, 429)
      assert.equal(error.providerRetryAfterMs, 2000)
      assert.ok(!error.message.includes('user_test_secret'))
      return true
    })
  })
  await withFetch(async () => mockResponse(events({
    type: 'error',
    error: { message: 'PREMIUM_CREDITS_EXHAUSTED', statusCode: 400 },
  })), async () => {
    await assert.rejects(() => collect(stream()), (error: unknown) => error instanceof CommandCodeError && error.code === 'QUOTA_EXCEEDED')
  })
})

it('caller cancellation cancels a blocked reader and never emits success', async () => {
  const controller = new AbortController()
  let cancelled = false
  await withFetch(async () => new Response(new ReadableStream<Uint8Array>({
    cancel() { cancelled = true },
  })), async () => {
    const reading = collect(stream({
      ...options(),
      signal: controller.signal,
    }))
    setImmediate(() => controller.abort(new DOMException('Stopped', 'AbortError')))
    await assert.rejects(() => reading, { name: 'AbortError' })
    assert.equal(cancelled, true)
  })
})

it('breaking consumption cancels the upstream response reader', async () => {
  let cancelled = false
  const wire = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encoder.encode(events({ type: 'text-start' }, { type: 'text-delta', text: 'Hi' }))) },
    cancel() { cancelled = true },
  })
  await withFetch(async () => new Response(wire), async () => {
    const iterator = stream()[Symbol.asyncIterator]()
    assert.equal((await iterator.next()).value?.type, 'block-start')
    await iterator.return?.()
    assert.equal(cancelled, true)
  })
})

it('quota parses real cap/used/resetAt windows and an explicit monthly grant without guessing', () => {
  const quota = parseCommandCodeQuota({}, {
    credits: { monthlyCredits: '7.5', monthlyCreditsGranted: '10', planId: 'individual-go-v1' },
    windowLimits: {
      fiveHour: { cap: '3', used: '.75', resetAt: 1780000000000 },
      weekly: { cap: 15, used: 1.5, resetAt: '1780100000' },
    },
  }, {
    success: true,
    data: { planId: 'individual-go-v1', currentPeriodEnd: '2026-11-01T00:00:00Z' },
  })
  assert.equal(quota.status, 'ok')
  assert.equal(quota.plan, 'individual-go-v1')
  assert.deepEqual(quota.windows.map(window => [window.period, window.usedPercent]), [
    ['5h', 25],
    ['week', 10],
    ['month', 25],
  ])
  assert.equal(quota.windows[2].resetsAt, '2026-11-01T00:00:00.000Z')
  assert.equal(parseCommandCodeQuota({}, {
    credits: { monthlyCredits: 7.5 },
  }, {
    success: true,
    data: { planId: 'individual-go' },
  }).status, 'unavailable')
  assert.equal(parseCommandCodeQuota({}, {
    credits: { monthlyCredits: 7.5 },
  }).windows.length, 0)
  assert.equal(parseCommandCodeQuota({}, {
    credits: {
      windowLimits: {
        fiveHour: { cap: 4, used: 1 },
      },
    },
  }).windows[0].usedPercent, 25)
})

it('quota fetch binds one account, uses whoami org.id and never follows redirects or polls', async () => {
  const paths: string[] = []
  await withFetch(async (url, init) => {
    const path = String(url).replace('https://api.commandcode.ai', '')
    paths.push(path)
    assert.equal(init?.redirect, 'error')
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer user_test_secret')
    if (path === '/alpha/whoami?limits=1') {
      return Response.json({
        user: { id: 'u' },
        org: { id: 'org/one' },
        orgLimits: [],
      })
    }
    if (path === '/alpha/billing/credits?orgId=org%2Fone') {
      return Response.json({
        credits: { monthlyCredits: 8, monthlyCreditsGranted: 10 },
      })
    }
    if (path === '/alpha/billing/subscriptions?orgId=org%2Fone') {
      return Response.json({
        success: true,
        data: { planId: 'individual-go-v1', currentPeriodEnd: '2026-11-01T00:00:00Z' },
      })
    }
    throw new Error(`Unexpected ${path}`)
  }, async () => {
    const quota = await fetchCommandCodeQuota(account)
    assert.equal(quota.windows.find(window => window.period === 'month')?.usedPercent, 20)
    assert.equal(paths.length, 3)
  })
})

it('missing or failed quota data does not become a zero-percent fabricated budget', async () => {
  await withFetch(async url => String(url).includes('/whoami')
    ? Response.json({ org: null })
    : String(url).includes('/credits')
      ? Response.json({
          credits: { monthlyCredits: 8 },
        })
      : new Response('unavailable', { status: 503 }), async () => {
    const quota = await fetchCommandCodeQuota(account)
    assert.equal(quota.status, 'unavailable')
    assert.deepEqual(quota.windows, [])
    assert.match(quota.reason ?? '', /unavailable/)
  })
})

it('stream projects common file attachments through the execution-world llm handle service', async () => {
  const input = options()
  input.messages = [
    {
      role: 'user',
      content: [
        {
          type: 'file',
          attachment: { attachmentId: 'file-one' as AttachmentId, name: 'input.txt', bytes: 20 },
        },
      ],
    },
  ]
  let projected = false
  const ctx = {
    llm: {
      fileRequestText: (attachment: unknown) => {
        projected = true
        assert.deepEqual(attachment, { attachmentId: 'file-one' as AttachmentId, name: 'input.txt', bytes: 20 })
        return '[input.txt: use the read-only saved copy at D:\\attachments\\one.txt]'
      },
    },
  } as unknown as Context
  await withFetch(async (_url, init) => {
    const request: unknown = JSON.parse(String(init?.body))
    const params = record(record(request).params)
    assert.ok(Array.isArray(params.messages))
    assert.equal(new Headers(init?.headers).get('user-agent'), 'dsh-zephyr/0.2.0')
    assert.deepEqual(record(params.messages[0]).content, [
      { type: 'text', text: '[input.txt: use the read-only saved copy at D:\\attachments\\one.txt]' },
    ])
    return mockResponse(events({ type: 'finish', finishReason: 'stop' }))
  }, async () => {
    await collect(streamCommandCode(ctx, input, account, model))
    assert.equal(projected, true)
    assert.equal(input.messages[0].content[0].type, 'file')
  })
})

it('abort after a usage yield or with buffered events still cannot emit a successful finish', async () => {
  for (const wire of [
    events({
      type: 'finish',
      totalUsage: { inputTokens: 1, outputTokens: 1 },
    }),
    events({ type: 'text-start' }, { type: 'text-delta', text: 'Buffered' }, { type: 'finish' }),
  ]) {
    const controller = new AbortController()
    await withFetch(async () => mockResponse(wire), async () => {
      const iterator = stream({
        ...options(),
        signal: controller.signal,
      })[Symbol.asyncIterator]()
      await iterator.next()
      controller.abort(new DOMException('Stopped', 'AbortError'))
      await assert.rejects(() => iterator.next(), { name: 'AbortError' })
    })
  }
})

it('missing old usage fields and partially metered steps do not fabricate zero counters or totals', async () => {
  for (const wire of [
    events({
      type: 'finish',
      totalUsage: { outputTokens: 2 },
    }),
    events({ type: 'finish-step' }, {
      type: 'finish-step',
      usage: { inputTokens: 10, outputTokens: 2 },
    }, { type: 'finish' }),
  ]) {
    await withFetch(async () => mockResponse(wire), async () => {
      const output = await collect(stream())
      assert.equal(output.some(chunk => chunk.type === 'usage'), false)
    })
  }
  await withFetch(async () => mockResponse(events({
    type: 'finish',
    totalUsage: { prompt_tokens: 4, completion_tokens: 2 },
  })), async () => {
    const output = await collect(stream())
    assert.deepEqual(output[0], {
      type: 'usage',
      usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
    })
  })
  await withFetch(async () => mockResponse(events({
    type: 'finish',
    totalUsage: {
      inputTokens: 20,
      outputTokens: 2,
      inputTokenDetails: { noCacheTokens: 4, cacheReadTokens: 3 },
    },
  })), async () => {
    const output = await collect(stream())
    assert.deepEqual(output[0], {
      type: 'usage',
      usage: { inputTokens: 4, outputTokens: 2, cacheReadTokens: 3 },
    })
  })
})

it('hTTP-200 error envelopes and failed quota objects never supply fake budgets', async () => {
  const parsed = parseCommandCodeQuota({}, {
    success: false,
    credits: { monthlyCredits: 8, monthlyCreditsGranted: 10 },
    windowLimits: {
      fiveHour: { cap: 3, used: 1 },
    },
  }, {
    success: false,
    data: { planId: 'old' },
  })
  assert.equal(parsed.status, 'unavailable')
  assert.equal(parsed.plan, undefined)
  assert.deepEqual(parsed.windows, [])
  await withFetch(async () => Response.json({ success: false, error: 'Not authenticated' }), async () => {
    await assert.rejects(() => fetchCommandCodeQuota(account), (error: unknown) => error instanceof CommandCodeError && error.code === 'AUTH')
  })
})

it('an interrupted response reader fails rather than silently returning partial success', async () => {
  let reads = 0
  const wire = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!reads++)
        controller.enqueue(encoder.encode(events({ type: 'text-delta', text: 'Partial' })))
      else controller.error(new Error('Dropped connection'))
    },
  })
  await withFetch(async () => new Response(wire), async () => {
    await assert.rejects(() => collect(stream()), (error: unknown) => error instanceof CommandCodeError && error.code === 'NETWORK')
  })
})

it('quota cancellation also interrupts a stalled JSON body after headers arrive', async () => {
  const controller = new AbortController()
  let cancelled = false
  await withFetch(async () => new Response(new ReadableStream<Uint8Array>({
    cancel() { cancelled = true },
  })), async () => {
    const pending = fetchCommandCodeQuota(account, controller.signal)
    setImmediate(() => controller.abort(new DOMException('Stopped', 'AbortError')))
    await assert.rejects(() => pending, { name: 'AbortError' })
    assert.equal(cancelled, true)
  })
})

it('quota fetches have a finite abortable timeout', async () => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout'],
  })
  try {
    await withFetch(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    }), async () => {
      const pending = fetchCommandCodeQuota(account)
      vi.advanceTimersByTime(15001)
      await assert.rejects(() => pending, (error: unknown) => error instanceof CommandCodeError && error.code === 'TIMEOUT')
    })
  }
  finally {
    vi.useRealTimers()
  }
})
