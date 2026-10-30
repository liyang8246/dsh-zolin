import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { ShellExecution, ShellRunResult } from '@deepseek-ai/dsh-shell'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import type { ToolArgs } from './args.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'

export const DEFAULT_TIMEOUT_MS = 120_000
export const MAX_TIMEOUT_MS = 600_000

const UV_CACHE_DIR = join(tmpdir(), 'dsh-uv-cache')
const UV_PYTHON_INSTALL_DIR = join(tmpdir(), 'dsh-uv-python')

export async function runUv(ctx: Context, args: ToolArgs, exec: ToolRunContext): Promise<{ text: string }> {
  const timeoutMs = Math.min(args.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)

  const policy = ctx.sandboxPolicy.resolve(
    exec.agent === undefined
      ? {}
      : { session: exec.agent.session },
  )
  const cwd = exec.agent === undefined
    ? ctx.workingDirectory.defaultDirectory
    : await ctx.workingDirectory.ensure(exec.agent, exec.signal)

  const spec = ctx.shell.resolve({
    command: 'uv run --no-project -',
    workdir: cwd,
    timeoutMs,
    onExpiry: 'kill',
    stdin: args.code,
    env: {
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      UV_CACHE_DIR,
      UV_PYTHON_INSTALL_DIR,
      UV_NO_PROGRESS: '1',
      NO_COLOR: '1',
    },
    sandboxPolicy: policy,
    signal: exec.signal,
  })

  let execution: ShellExecution
  try {
    execution = await ctx.shell.execute(spec)
  }
  catch (error) {
    throw new Error(`uv_run failed to start: ${error instanceof Error
      ? error.message
      : String(error)}`)
  }

  const result = await execution.result()
  return {
    text: formatResult(result),
  }
}

function formatResult(result: ShellRunResult): string {
  const parts: string[] = []
  const stdout = stripVTControlCharacters(result.stdout.text).trimEnd()
  const stderr = stripVTControlCharacters(result.stderr.text).trimEnd()
  if (stdout.length > 0)
    parts.push(stdout)
  if (stderr.length > 0)
    parts.push(`[stderr]\n${stderr}`)
  if (result.timedOut)
    parts.push(`[timed out after ${result.timeoutMs}ms]`)
  else if (result.aborted)
    parts.push('[aborted]')
  else if (result.signal !== null)
    parts.push(`[killed by signal: ${result.signal}]`)
  else if (result.exitCode !== null && result.exitCode !== 0)
    parts.push(`[exit code: ${result.exitCode}]`)
  if (result.sandbox?.denied) {
    parts.push(`[sandbox: file access denied under ${result.sandbox.mode} mode]`)
  }
  const spillPath = result.stdout.spillPath ?? result.stderr.spillPath
  if (result.stdout.truncated || result.stderr.truncated) {
    parts.push(spillPath === undefined
      ? '[output truncated]'
      : `[output truncated; full output: ${spillPath}]`)
  }
  return parts.length === 0
    ? '(no output)'
    : parts.join('\n')
}
