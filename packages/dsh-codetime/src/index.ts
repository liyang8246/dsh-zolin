import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { StatusPayload, StatusRequest } from './shared/types.js'
import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { scanHistory } from './host/history.js'
import {
  ensureMachineId,
  maskToken,
  resolveToken,
  uploadRollups,
  writeToken,
} from './host/remote.js'
import { SessionFolder, toWireRollup } from './host/rollups.js'
import { StateFile } from './host/state.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'codetime'

/** Wait for both the session store and the settings route transport. */
export const inject = ['sessions', 'connection']

/** Fold window, upload cadence, retention, and where local state lives. */
export interface ConfigOptions {
  /**
   * How far back the startup pass reads stored session logs, in days.
   * `0` keeps only activity seen while the Host runs.
   */
  historyDays?: number
  /** Automatic upload interval in minutes; `0` disables the timer. */
  syncMinutes?: number
  /** Days a quiet session stays in local state. */
  retentionDays?: number
  /** Absolute path of the local fold state. Defaults to `~/.dsh/codetime/state.json`. */
  statePath?: string
}

/** Schemastery validation for {@link ConfigOptions}. */
export const Config: z<ConfigOptions> = z.object({
  historyDays: z.number().min(0).max(3650).default(30),
  syncMinutes: z.number().min(0).max(1440).default(5),
  retentionDays: z.number().min(7).max(3650).default(120),
  statePath: z.string(),
})

/** Rollups per ingest request. */
const BATCH_SIZE = 10
/** Quiet period after the last folded event before an automatic upload. */
const SETTLE_MS = 20_000
/** Largest request body the route accepts. */
const MAX_BODY_BYTES = 4 * 1024

/** Read one JSON body, tolerating an empty payload. */
async function readBody(request: Request): Promise<StatusRequest> {
  const text = await request.text()
  if (text.length > MAX_BODY_BYTES)
    throw new Error('request body too large')
  if (!text.trim())
    return { action: 'status' }
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null)
    throw new Error('request body must be an object')
  const record = parsed as Record<string, unknown>
  const action = record.action
  return {
    action: action === 'save' || action === 'clear' || action === 'sync'
      ? action
      : 'status',
    token: typeof record.token === 'string'
      ? record.token
      : undefined,
    autoUpload: typeof record.autoUpload === 'boolean'
      ? record.autoUpload
      : undefined,
  }
}

/**
 * Fold Harness activity into codetime rollups and keep them uploaded.
 * @param ctx - plugin context; every registration is disposed with it.
 * @param config - fold window, upload cadence, retention, and host overrides.
 */
export function apply(ctx: Context, config: ConfigOptions): void {
  const statePath = config.statePath ?? join(homedir(), '.dsh', 'codetime', 'state.json')
  const state = new StateFile(statePath, config.retentionDays ?? 120)
  const historyDays = config.historyDays ?? 30
  const syncMinutes = config.syncMinutes ?? 5

  let folder: SessionFolder | undefined
  let scanning = false
  let uploading = false
  let settle: ReturnType<typeof setTimeout> | undefined
  const queued: Array<{ id: string, cwd: string | undefined, event: SessionEvent }> = []

  const scheduleSync = (): void => {
    if (settle || !state.state.settings.autoUpload)
      return
    settle = setTimeout(() => {
      settle = undefined
      // eslint-disable-next-line ts/no-use-before-define -- closed-over scheduler
      void sync()
    }, SETTLE_MS)
    settle.unref?.()
  }

  const fold = (id: string, cwd: string | undefined, events: readonly SessionEvent[]): void => {
    if (!folder) {
      for (const event of events) queued.push({ id, cwd, event })
      return
    }
    if (folder.ingest({ id, cwd }, events) > 0) {
      state.schedule()
      scheduleSync()
    }
  }

  ctx.effect(() => ctx.on('session/event', (session, event) => {
    fold(session.header.id, session.header.cwd, [event])
  }))

  // Uploads one batch per request; `folder` may still be loading on first call.
  const sync = async (): Promise<void> => {
    if (uploading || !folder)
      return
    const changed = folder.pendingSessions()
    if (changed.length === 0)
      return
    const token = await resolveToken()
    if (!token) {
      state.state.lastError = 'token is not configured'
      await state.write()
      return
    }
    uploading = true
    try {
      const machineId = await ensureMachineId()
      const rollups = changed.map(toWireRollup)
      const totals = { inserted: 0, skipped: 0, conflicts: 0 }
      for (let index = 0; index < rollups.length; index += BATCH_SIZE) {
        const batch = rollups.slice(index, index + BATCH_SIZE)
        const result = await uploadRollups({
          token,
          machineId,
          rollups: batch,
        })
        totals.inserted += result.inserted
        totals.skipped += result.skipped
        totals.conflicts += result.conflicts
        for (const rollup of batch) {
          const session = state.state.sessions[rollup.sessionId]
          if (session)
            session.uploadedHash = rollup.payloadHash
        }
      }
      state.state.lastUploadAt = Date.now()
      state.state.lastSync = totals
      state.state.lastError = undefined
      await state.write()
    }
    catch (error) {
      state.state.lastError = error instanceof Error
        ? error.message
        : String(error)
      await state.write()
    }
    finally {
      uploading = false
    }
  }

  const status = async (): Promise<StatusPayload> => {
    const token = await resolveToken()
    return {
      configured: Boolean(token),
      maskedToken: token
        ? maskToken(token)
        : undefined,
      autoUpload: state.state.settings.autoUpload,
      machineId: await ensureMachineId(),
      sessions: Object.keys(state.state.sessions).length,
      pending: folder
        ? folder.pendingSessions().length
        : 0,
      uploading,
      lastUploadAt: state.state.lastUploadAt,
      lastError: state.state.lastError,
      lastSync: state.state.lastSync,
    }
  }

  const scan = async (): Promise<void> => {
    if (!folder || scanning)
      return
    scanning = true
    try {
      await scanHistory(ctx, folder, historyDays)
      state.state.lastScanAt = Date.now()
      await state.write()
    }
    finally {
      scanning = false
      if (state.state.settings.autoUpload)
        void sync()
    }
  }

  const ready: Promise<void> = (async () => {
    await state.load()
    folder = new SessionFolder(state.state)
    const pending = queued.splice(0)
    for (const item of pending)
      folder.ingest({ id: item.id, cwd: item.cwd }, [item.event])
    await scan()
  })().catch((error: unknown) => {
    console.error('codetime: initial fold failed:', error)
  })

  ctx.effect(() => {
    if (syncMinutes <= 0)
      return () => {}
    const timer = setInterval(() => {
      if (state.state.settings.autoUpload)
        void sync()
    }, syncMinutes * 60_000)
    timer.unref?.()
    return () => {
      clearInterval(timer)
      if (settle) {
        clearTimeout(settle)
        settle = undefined
      }
    }
  })

  ctx.effect(() => () => {
    void state.flush()
  })

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/codetime',
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request: Request): Promise<Response> {
      try {
        const body = await readBody(request)
        await ready
        if (body.action === 'save') {
          const token = body.token?.trim()
          if (token !== undefined && !token)
            throw new Error('token must not be empty')
          if (token !== undefined)
            await writeToken(token)
          if (body.autoUpload !== undefined) {
            state.state.settings.autoUpload = body.autoUpload
            await state.write()
          }
          // Persisted work from before this token existed uploads without a restart.
          void sync()
        }
        if (body.action === 'clear') {
          await writeToken(undefined)
          state.state.lastError = undefined
          await state.write()
        }
        if (body.action === 'sync')
          await sync()
        return Response.json(await status(), {
          headers: { 'Cache-Control': 'no-store' },
        })
      }
      catch (error) {
        const message = error instanceof Error
          ? error.message
          : String(error)
        return Response.json({ error: message }, {
          status: 400,
          headers: { 'Cache-Control': 'no-store' },
        })
      }
    },
  }))
}
