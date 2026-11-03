import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ModelBucket, ModelRollup, PluginState, SessionState, TimeBucket, TokenTotals, ToolRollup, TurnRollup, WireRollup } from '../shared/types.js'
import { createHash } from 'node:crypto'
import { emptyTokens } from './state.js'

const BUCKET_MS = 15 * 60_000
const MAX_TURN_MS = 2 * 60 * 60_000

/** ISO timestamp of the 15-minute bucket that owns `time`. */
export function bucketStamp(time: number): string {
  return new Date(Math.floor(time / BUCKET_MS) * BUCKET_MS).toISOString()
}

/** Last path segment of a working directory, used as the project label. */
export function projectName(cwd: string | undefined): string | undefined {
  if (!cwd)
    return undefined
  const segments = cwd.split(/[\\/]/).filter(Boolean)
  return segments[segments.length - 1]
}

/** Empty time bucket. */
function emptyBucket(ts: string): TimeBucket {
  return {
    ts,
    activityCount: 0,
    sessionStarts: 0,
    modelCalls: 0,
    toolCalls: 0,
    commandCalls: 0,
    fileReads: 0,
    fileWrites: 0,
    linesAdded: 0,
    linesRemoved: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
  }
}

/** Empty model rollup. */
function emptyModel(model: string): ModelRollup {
  return {
    model,
    callCount: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheCreation5mInputTokens: 0,
    cacheCreation1hInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
  }
}

/**
 * Folds DSH session events into codetime rollups, one accumulator per session.
 * The persisted cursor makes a repeated history scan add only new events.
 */
export class SessionFolder {
  private readonly currentTurn = new Map<string, string>()
  private readonly callNames = new Map<string, string>()

  constructor(private readonly state: PluginState) {}

  /** Fold one session's events; returns how many were new. */
  ingest(session: { id: string, cwd?: string }, events: readonly SessionEvent[]): number {
    let folded = 0
    for (const event of events) {
      const existing = this.state.sessions[session.id]
      if (existing && event.seq <= existing.cursor)
        continue
      const accumulator = this.accumulator(session, event.time)
      this.record(session.id, accumulator, event)
      folded += 1
    }
    return folded
  }

  /** Sessions whose local fold differs from the last accepted upload. */
  pendingSessions(): SessionState[] {
    return Object.values(this.state.sessions).filter(session => session.uploadedHash !== toWireRollup(session).payloadHash)
  }

  private accumulator(session: { id: string, cwd?: string }, time: number): SessionState {
    const existing = this.state.sessions[session.id]
    if (existing)
      return existing
    const stamp = new Date(time).toISOString()
    const created: SessionState = {
      sessionId: session.id,
      project: projectName(session.cwd),
      cwd: session.cwd,
      startedAt: stamp,
      lastEventAt: stamp,
      cursor: -1,
      eventCount: 0,
      promptCount: 0,
      turnCount: 0,
      toolCallCount: 0,
      commandCallCount: 0,
      tokens: emptyTokens(),
      timeBuckets: {},
      modelRollups: {},
      modelBuckets: {},
      toolRollups: {},
      turnRollups: {},
    }
    this.state.sessions[session.id] = created
    return created
  }

  private bucket(accumulator: SessionState, time: number): TimeBucket {
    const ts = bucketStamp(time)
    const existing = accumulator.timeBuckets[ts]
    if (existing)
      return existing
    const created = emptyBucket(ts)
    accumulator.timeBuckets[ts] = created
    return created
  }

  private turn(accumulator: SessionState, turn: number, time: number): TurnRollup {
    const turnId = `turn-${turn}`
    const existing = accumulator.turnRollups[turnId]
    if (existing)
      return existing
    const stamp = new Date(time).toISOString()
    const created: TurnRollup = {
      turnId,
      startedAt: stamp,
      lastEventAt: stamp,
      promptChars: 0,
      eventCount: 0,
      toolCallCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      durationMs: 0,
    }
    accumulator.turnRollups[turnId] = created
    return created
  }

  private record(sessionId: string, accumulator: SessionState, event: SessionEvent): void {
    const time = event.time
    const stamp = new Date(time).toISOString()
    accumulator.cursor = Math.max(accumulator.cursor, event.seq)
    accumulator.eventCount += 1
    accumulator.lastEventAt = stamp
    if (stamp < accumulator.startedAt)
      accumulator.startedAt = stamp
    const bucket = this.bucket(accumulator, time)
    const current = this.currentTurn.get(sessionId)

    if (event.type === 'turn/start') {
      accumulator.turnCount += 1
      bucket.activityCount += 1
      this.turn(accumulator, event.data.turn, time)
      this.currentTurn.set(sessionId, `turn-${event.data.turn}`)
    }

    const turn = current ? accumulator.turnRollups[current] : undefined
    if (turn) {
      turn.lastEventAt = stamp
      turn.eventCount += 1
    }

    switch (event.type) {
      case 'user/message': {
        if (event.data.source.kind !== 'user')
          break
        accumulator.promptCount += 1
        bucket.activityCount += 1
        if (turn) {
          turn.promptSubmittedAt ??= stamp
          turn.promptChars += textLength(event.data.content)
        }
        break
      }
      case 'assistant/message': {
        const source = event.data.message.source
        const model = `${source.provider}/${source.model}`
        const usage = event.data.usage
        const modelRollup = accumulator.modelRollups[model] ?? (accumulator.modelRollups[model] = emptyModel(model))
        modelRollup.callCount += 1
        bucket.modelCalls += 1
        bucket.activityCount += 1
        const modelBucket = this.modelBucket(accumulator, time, model)
        modelBucket.callCount += 1
        if (usage) {
          // codetime counts cached tokens inside `inputTokens` and repeats them
          // in `cachedInputTokens`; DSH reports them separately.
          const cacheRead = usage.cacheReadTokens ?? 0
          const cacheWrite = usage.cacheWriteTokens ?? 0
          const inputTokens = usage.inputTokens + cacheRead + cacheWrite
          const tokens = {
            inputTokens,
            cachedInputTokens: cacheRead + cacheWrite,
            cacheCreationInputTokens: cacheWrite,
            cacheReadInputTokens: cacheRead,
            outputTokens: usage.outputTokens,
            reasoningOutputTokens: usage.reasoningTokens ?? 0,
            totalTokens: usage.totalTokens ?? inputTokens + usage.outputTokens,
          }
          addTokens(modelRollup, tokens)
          addTokens(modelBucket, tokens)
          addTokens(accumulator.tokens, tokens)
          addTokens(bucket, tokens)
          if (turn) {
            turn.inputTokens += tokens.inputTokens
            turn.outputTokens += tokens.outputTokens
            turn.totalTokens += tokens.totalTokens
          }
        }
        break
      }
      case 'tool/call': {
        const name = event.data.name
        accumulator.toolCallCount += 1
        bucket.toolCalls += 1
        bucket.activityCount += 1
        const toolRollup = accumulator.toolRollups[name] ?? (accumulator.toolRollups[name] = {
          tool: name,
          callCount: 0,
          failureCount: 0,
          totalDurationMs: 0,
        })
        toolRollup.callCount += 1
        this.callNames.set(`${sessionId}:${event.data.callId}`, name)
        if (turn)
          turn.toolCallCount += 1
        break
      }
      case 'tool/result': {
        if (!event.data.message.isError)
          break
        const key = `${sessionId}:${event.data.message.toolCallId}`
        const name = this.callNames.get(key)
        this.callNames.delete(key)
        if (!name)
          break
        const toolRollup: ToolRollup = accumulator.toolRollups[name] ?? {
          tool: name,
          callCount: 0,
          failureCount: 0,
          totalDurationMs: 0,
        }
        toolRollup.failureCount += 1
        accumulator.toolRollups[name] = toolRollup
        break
      }
      case 'turn/end': {
        const closing = accumulator.turnRollups[`turn-${event.data.turn}`]
        if (closing) {
          closing.completedAt = stamp
          closing.durationMs = Math.min(Math.max(0, time - Date.parse(closing.startedAt)), MAX_TURN_MS)
        }
        this.currentTurn.delete(sessionId)
        break
      }
      default:
        break
    }
  }

  private modelBucket(accumulator: SessionState, time: number, model: string): ModelBucket {
    const ts = bucketStamp(time)
    const key = `${ts}\0${model}`
    const existing = accumulator.modelBuckets[key]
    if (existing)
      return existing
    const { estimatedCostUsd: _ignored, ...rest } = emptyModel(model)
    const created: ModelBucket = { ...rest, ts }
    accumulator.modelBuckets[key] = created
    return created
  }
}

/** Sum text blocks of one message's content. */
function textLength(content: readonly { type: string, text?: string }[]): number {
  let total = 0
  for (const block of content) {
    if (block.type === 'text' && block.text)
      total += block.text.length
  }
  return total
}

/** Add token counters onto any record that carries the seven token fields. */
function addTokens(target: TokenTotals, tokens: TokenTotals): void {
  target.inputTokens += tokens.inputTokens
  target.cachedInputTokens += tokens.cachedInputTokens
  target.cacheCreationInputTokens += tokens.cacheCreationInputTokens
  target.cacheReadInputTokens += tokens.cacheReadInputTokens
  target.outputTokens += tokens.outputTokens
  target.reasoningOutputTokens += tokens.reasoningOutputTokens
  target.totalTokens += tokens.totalTokens
}

/** Deterministic JSON with sorted object keys. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(stableStringify).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** `sha256:` hash of a rollup without its own hash field. */
export function payloadHash(rollup: WireRollup): string {
  const { payloadHash: _ignored, ...rest } = rollup
  return `sha256:${createHash('sha256').update(stableStringify(rest)).digest('hex')}`
}

/** Project one folded session into the ingest wire body. */
export function toWireRollup(session: SessionState): WireRollup {
  const durationMs = Math.max(0, Date.parse(session.lastEventAt) - Date.parse(session.startedAt))
  const base: WireRollup = {
    rollupKey: `rollup:dsh:${session.sessionId}`,
    payloadHash: '',
    schemaVersion: 3,
    source: 'dsh',
    project: session.project,
    sessionId: session.sessionId,
    agent: 'dsh',
    startedAt: session.startedAt,
    lastEventAt: session.lastEventAt,
    eventCount: session.eventCount,
    promptCount: session.promptCount,
    turnCount: session.turnCount,
    toolCallCount: session.toolCallCount,
    commandCallCount: session.commandCallCount,
    inputTokens: session.tokens.inputTokens,
    cachedInputTokens: session.tokens.cachedInputTokens,
    cacheCreationInputTokens: session.tokens.cacheCreationInputTokens,
    cacheReadInputTokens: session.tokens.cacheReadInputTokens,
    outputTokens: session.tokens.outputTokens,
    reasoningOutputTokens: session.tokens.reasoningOutputTokens,
    totalTokens: session.tokens.totalTokens,
    linesAdded: 0,
    linesRemoved: 0,
    durationMs,
    timeBuckets: Object.values(session.timeBuckets).sort((left, right) => left.ts.localeCompare(right.ts)),
    modelRollups: Object.values(session.modelRollups).sort((left, right) => right.callCount - left.callCount || left.model.localeCompare(right.model)),
    modelBuckets: Object.values(session.modelBuckets).sort((left, right) => left.ts.localeCompare(right.ts) || left.model.localeCompare(right.model)),
    toolRollups: Object.values(session.toolRollups).sort((left, right) => right.callCount - left.callCount || left.tool.localeCompare(right.tool)),
    fileRollups: [],
    turnRollups: Object.values(session.turnRollups).sort((left, right) => left.startedAt.localeCompare(right.startedAt)),
  }
  return {
    ...base,
    payloadHash: payloadHash(base),
  }
}
