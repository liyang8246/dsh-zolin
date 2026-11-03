import type { SyncCounts, WireRollup } from '../shared/types.js'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir, hostname, platform } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

/** The one ingest host this plugin reports to. */
export const REMOTE_URL = 'https://codetime.dev'

/** Directory the codetime CLI owns; the plugin shares it so one token works for both. */
export function codetimeHome(): string {
  return join(homedir(), '.codetime')
}

/** Path of the shared CLI config file. */
function configPath(): string {
  return join(codetimeHome(), 'config.json')
}

/** Raw shared config as the CLI wrote it; unknown keys are preserved on write. */
async function readConfig(): Promise<Record<string, unknown>> {
  let raw: string
  try {
    raw = await readFile(configPath(), 'utf8')
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return {}
    throw error
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null
      ? parsed as Record<string, unknown>
      : {}
  }
  catch {
    // A corrupted config must not break the plugin; saving a token rewrites it.
    return {}
  }
}

/** Resolve the effective upload token: process environment, then the CLI config. */
export async function resolveToken(): Promise<string | undefined> {
  const fromEnv = process.env.CODETIME_TOKEN
  if (fromEnv && fromEnv.trim())
    return fromEnv.trim()
  const token = (await readConfig()).token
  return typeof token === 'string' && token
    ? token
    : undefined
}

/**
 * Store or clear the token in the CLI's config file.
 * @param token - token to persist; `undefined` removes it.
 */
export async function writeToken(token: string | undefined): Promise<void> {
  const config = await readConfig()
  if (token)
    config.token = token
  else
    delete config.token
  await mkdir(codetimeHome(), { recursive: true })
  const temporary = `${configPath()}.tmp`
  await writeFile(temporary, `${JSON.stringify(config)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, configPath()).catch(async (error: unknown) => {
    await rm(temporary, { force: true })
    throw error
  })
}

/** Read the machine id, minting and persisting one on first use. */
export async function ensureMachineId(): Promise<string> {
  const path = join(codetimeHome(), 'machine-id')
  try {
    const existing = (await readFile(path, 'utf8')).trim()
    if (existing)
      return existing
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw error
  }
  const created = randomUUID()
  await mkdir(codetimeHome(), { recursive: true })
  await writeFile(path, `${created}\n`, 'utf8')
  return created
}

/** Mask a token for display: four leading and four trailing characters around twenty dots. */
export function maskToken(token: string): string {
  const dots = '•'.repeat(20)
  if (token.length <= 8)
    return dots
  return `${token.slice(0, 4)}${dots}${token.slice(-4)}`
}

/**
 * POST one batch of session rollups to `/v3/agent/ingest` with `replace: true`,
 * so re-uploading a session refreshes it instead of duplicating it.
 * @returns inserted, skipped, and conflict counts reported by the server.
 * @throws when the host rejects the batch; the response body is included.
 */
export async function uploadRollups(input: {
  token: string
  machineId: string
  rollups: WireRollup[]
}): Promise<SyncCounts> {
  const response = await fetch(`${REMOTE_URL}/v3/agent/ingest`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'dsh-codetime/0.1.0',
      'authorization': `Bearer ${input.token}`,
      'x-machine-id': input.machineId,
      'x-machine-hostname': hostname(),
      'x-machine-name': hostname(),
      'x-machine-platform': platform(),
    },
    body: JSON.stringify({ rollups: input.rollups, replace: true }),
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`codetime API ${response.status}: ${body.slice(0, 400)}`)
  }
  const data: unknown = await response.json()
  const record = (typeof data === 'object' && data !== null
    ? data
    : {}) as Record<string, unknown>
  return {
    inserted: Number(record.inserted) || 0,
    skipped: Number(record.skipped) || 0,
    conflicts: Number(record.conflicts) || 0,
  }
}
