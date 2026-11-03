import type { PluginState, SessionState } from '../shared/types.js'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const SAVE_DELAY_MS = 1_000

/** Blank token counters. */
export function emptyTokens(): SessionState['tokens'] {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  }
}

/** State with no folded activity. */
export function createState(): PluginState {
  return {
    version: 1,
    sessions: {},
    settings: { autoUpload: true },
  }
}

/** Drop sessions that have been quiet past the retention window. */
export function prune(state: PluginState, retentionDays: number, now: number): void {
  const cutoff = now - retentionDays * 86_400_000
  for (const [id, session] of Object.entries(state.sessions)) {
    if (Date.parse(session.lastEventAt) < cutoff)
      delete state.sessions[id]
  }
}

/**
 * Durable JSON state. Writes are debounced and atomic; concurrent writes are
 * serialized so the file never contains a partial body.
 */
export class StateFile {
  state: PluginState = createState()
  private timer?: ReturnType<typeof setTimeout>
  private writing: Promise<void> = Promise.resolve()
  private closed = false
  private readonly retentionDays: number

  constructor(private readonly path: string, retentionDays: number) {
    this.retentionDays = retentionDays
  }

  /** Load previous state, or start empty when the file is absent. */
  async load(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return
      throw error
    }
    const parsed: unknown = JSON.parse(raw)
    this.state = isPluginState(parsed)
      ? parsed
      : createState()
  }

  /** Request a debounced write. */
  schedule(): void {
    if (this.closed || this.timer)
      return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.write()
    }, SAVE_DELAY_MS)
    this.timer.unref?.()
  }

  /** Write the current state now. */
  write(): Promise<void> {
    this.writing = this.writing.then(() => this.writeNow())
    return this.writing
  }

  /** Flush pending activity and stop accepting writes. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.closed = true
    await this.write()
  }

  private async writeNow(): Promise<void> {
    prune(this.state, this.retentionDays, Date.now())
    const body = `${JSON.stringify(this.state)}\n`
    const temporary = `${this.path}.tmp`
    await mkdir(dirname(this.path), { recursive: true })
    await writeFile(temporary, body, 'utf8')
    await rename(temporary, this.path).catch(async (error: unknown) => {
      await rm(temporary, { force: true })
      throw error
    })
  }
}

/** Validate a decoded state file at the durable-file boundary. */
function isPluginState(value: unknown): value is PluginState {
  if (typeof value !== 'object' || value === null)
    return false
  const candidate = value as Partial<PluginState>
  return candidate.version === 1
    && typeof candidate.sessions === 'object' && candidate.sessions !== null
    && typeof candidate.settings === 'object' && candidate.settings !== null
    && typeof candidate.settings.autoUpload === 'boolean'
}
