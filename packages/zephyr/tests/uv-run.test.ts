import type { Context } from '@deepseek-ai/cordis'
import type { ShellExecRequest, ShellRunResult } from '@deepseek-ai/dsh-shell'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'vitest'
import { readArgs } from '../src/uv-run/args.js'
import { createDefinition } from '../src/uv-run/definition.js'
import { inject } from '../src/uv-run/index.js'

import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, runUv } from '../src/uv-run/run.js'

function outcome(overrides: Partial<ShellRunResult> = {}): ShellRunResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    stdout: { text: '', truncated: false } as ShellRunResult['stdout'],
    stderr: { text: '', truncated: false } as ShellRunResult['stderr'],
    ...overrides,
  }
}

function fixture(result = outcome()) {
  let request: ShellExecRequest | undefined
  let policyQuery: unknown
  let ensureArgs: unknown[] | undefined
  const policy = { mode: 'read-only' }
  const ctx = {
    sandboxPolicy: {
      resolve(query: unknown) {
        policyQuery = query
        return policy
      },
    },
    workingDirectory: {
      defaultDirectory: 'default-workdir',
      async ensure(agent: unknown, signal: AbortSignal) {
        ensureArgs = [agent, signal]
        return 'session-workdir'
      },
    },
    shell: {
      resolve(value: ShellExecRequest) {
        request = value
        return value
      },
      async execute(value: ShellExecRequest) {
        assert.equal(value, request)
        return {
          result: async () => result,
        }
      },
    },
  } as unknown as Context
  return {
    ctx,
    policy,
    request: () => request,
    policyQuery: () => policyQuery,
    ensureArgs: () => ensureArgs,
  }
}

function execution(signal = new AbortController().signal, agent?: unknown): ToolRunContext {
  return {
    signal,
    ...(agent === undefined
      ? {}
      : { agent }),
  } as unknown as ToolRunContext
}

it('arguments reject invalid objects, empty code and invalid timeouts', () => {
  for (const raw of [null, [], 1, 'code']) assert.throws(() => readArgs(raw), /expected an object/)
  for (const code of [undefined, '', ' \n', 2]) assert.throws(() => readArgs({ code }), /invalid code/)
  for (const timeoutMs of [0, -1, NaN, Infinity, '100', null]) assert.throws(() => readArgs({ code: 'pass', timeoutMs }), /invalid timeoutMs/)
  assert.deepEqual(readArgs({ code: 'print("你好")\n' }), { code: 'print("你好")\n' })
  assert.deepEqual(readArgs({ code: 'pass', timeoutMs: 1 }), { code: 'pass', timeoutMs: 1 })
})

it('the tool definition validates arguments before invoking the shell', async () => {
  const mock = fixture()
  const definition = createDefinition(mock.ctx)
  assert.equal(definition.name, 'uv_run')
  assert.deepEqual(inject, [
    'tools',
    'shell',
    'workingDirectory',
    'sandboxPolicy',
  ])
  await assert.rejects(async () => definition.execute({ code: '' }, execution()), /invalid code/)
  assert.equal(mock.request(), undefined)
})

it('session policy, cwd, cancellation and stdin are passed unchanged; timeout is capped', async () => {
  const mock = fixture()
  const controller = new AbortController()
  const agent = {
    session: { id: 'session-one' },
  }
  const code = 'print("quotes \\ and 你好")\n'
  await runUv(mock.ctx, { code, timeoutMs: MAX_TIMEOUT_MS + 1 }, execution(controller.signal, agent))
  const request = mock.request()!
  assert.deepEqual(mock.policyQuery(), { session: agent.session })
  assert.deepEqual(mock.ensureArgs(), [agent, controller.signal])
  assert.equal(request.sandboxPolicy, mock.policy)
  assert.equal(request.signal, controller.signal)
  assert.equal(request.workdir, 'session-workdir')
  assert.equal(request.command, 'uv run --no-project -')
  assert.equal(request.stdin, code)
  assert.equal(request.timeoutMs, MAX_TIMEOUT_MS)
  assert.equal(request.onExpiry, 'kill')
  assert.deepEqual(request.env, {
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    UV_CACHE_DIR: join(tmpdir(), 'dsh-uv-cache'),
    UV_PYTHON_INSTALL_DIR: join(tmpdir(), 'dsh-uv-python'),
    UV_NO_PROGRESS: '1',
    NO_COLOR: '1',
  })
  controller.abort()
  assert.equal(request.signal?.aborted, true)
})

it('calls without an agent use Host defaults and preserve smaller explicit deadlines', async () => {
  const mock = fixture()
  assert.deepEqual(await runUv(mock.ctx, { code: 'pass' }, execution()), { text: '(no output)' })
  assert.deepEqual(mock.policyQuery(), {})
  assert.equal(mock.ensureArgs(), undefined)
  assert.equal(mock.request()?.workdir, 'default-workdir')
  assert.equal(mock.request()?.timeoutMs, DEFAULT_TIMEOUT_MS)
  await runUv(mock.ctx, { code: 'pass', timeoutMs: 42 }, execution())
  assert.equal(mock.request()?.timeoutMs, 42)
})

it('output strips terminal controls and reports stderr, status, sandbox denial and spill path', async () => {
  const mock = fixture(outcome({
    exitCode: 7,
    stdout: { text: '\u001B[31mhello\u001B[0m\n', truncated: true, spillPath: 'full-output.txt' } as ShellRunResult['stdout'],
    stderr: { text: 'failure\n', truncated: false } as ShellRunResult['stderr'],
    sandbox: { mode: 'read-only', denied: true },
  }))
  assert.deepEqual(await runUv(mock.ctx, { code: 'pass' }, execution()), {
    text: 'hello\n[stderr]\nfailure\n[exit code: 7]\n[sandbox: file access denied under read-only mode]\n[output truncated; full output: full-output.txt]',
  })
})

it('timeout, abort, signal termination and pathless truncation have distinct markers', async () => {
  const cases: [Partial<ShellRunResult>, string][] = [
    [
      { timedOut: true, timeoutMs: 5, exitCode: 1 },
      '[timed out after 5ms]',
    ],
    [
      { aborted: true, exitCode: 1 },
      '[aborted]',
    ],
    [
      { signal: 'SIGTERM', exitCode: null },
      '[killed by signal: SIGTERM]',
    ],
    [
      {
        stdout: { text: '', truncated: true } as ShellRunResult['stdout'],
      },
      '[output truncated]',
    ],
    [
      {
        stderr: { text: '', truncated: true, spillPath: 'stderr.txt' } as ShellRunResult['stderr'],
      },
      '[output truncated; full output: stderr.txt]',
    ],
  ]
  for (const [result, expected] of cases) {
    assert.deepEqual(await runUv(fixture(outcome(result)).ctx, { code: 'pass' }, execution()), { text: expected })
  }
})

it('startup failures retain their cause', async () => {
  const mock = fixture()
  mock.ctx.shell.execute = async () => {
    throw new Error('uv missing')
  }
  await assert.rejects(runUv(mock.ctx, { code: 'pass' }, execution()), /uv_run failed to start: uv missing/)
})
