/** Token counters for one aggregation level. */
export interface TokenTotals {
  inputTokens: number
  cachedInputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
}

/** One model route's totals inside a session rollup. */
export interface ModelRollup {
  model: string
  callCount: number
  inputTokens: number
  cachedInputTokens: number
  cacheCreationInputTokens: number
  cacheCreation5mInputTokens: number
  cacheCreation1hInputTokens: number
  cacheReadInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
  estimatedCostUsd: number
}

/** One model route's totals inside a 15-minute bucket. */
export type ModelBucket = Omit<ModelRollup, 'estimatedCostUsd'> & { ts: string }

/** One tool's call and failure counts inside a session rollup. */
export interface ToolRollup {
  tool: string
  callCount: number
  failureCount: number
  totalDurationMs: number
}

/** Activity and usage inside one 15-minute bucket. */
export interface TimeBucket {
  ts: string
  activityCount: number
  sessionStarts: number
  modelCalls: number
  toolCalls: number
  commandCalls: number
  fileReads: number
  fileWrites: number
  linesAdded: number
  linesRemoved: number
  inputTokens: number
  cachedInputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
  estimatedCostUsd: number
}

/** One turn inside a session rollup. */
export interface TurnRollup {
  turnId: string
  startedAt: string
  lastEventAt: string
  completedAt?: string
  promptSubmittedAt?: string
  promptChars: number
  eventCount: number
  toolCallCount: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  durationMs: number
}

/** Everything folded for one DSH session, persisted between Host runs. */
export interface SessionState {
  sessionId: string
  project?: string
  cwd?: string
  startedAt: string
  lastEventAt: string
  /** Last folded event seq; a repeat scan only contributes its tail. */
  cursor: number
  eventCount: number
  promptCount: number
  turnCount: number
  toolCallCount: number
  commandCallCount: number
  tokens: TokenTotals
  timeBuckets: Record<string, TimeBucket>
  modelRollups: Record<string, ModelRollup>
  modelBuckets: Record<string, ModelBucket>
  toolRollups: Record<string, ToolRollup>
  turnRollups: Record<string, TurnRollup>
  /** Payload hash of the last accepted upload. */
  uploadedHash?: string
}

/** Persistent plugin state. */
export interface PluginState {
  version: 1
  sessions: Record<string, SessionState>
  settings: {
    autoUpload: boolean
  }
  lastUploadAt?: number
  lastScanAt?: number
  lastSync?: SyncCounts
  lastError?: string
}

/** The exact body `POST /v3/agent/ingest` accepts for one session. */
export interface WireRollup {
  rollupKey: string
  payloadHash: string
  schemaVersion: 3
  source: 'dsh'
  project?: string
  sessionId: string
  agent: 'dsh'
  startedAt: string
  lastEventAt: string
  eventCount: number
  promptCount: number
  turnCount: number
  toolCallCount: number
  commandCallCount: number
  inputTokens: number
  cachedInputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
  linesAdded: number
  linesRemoved: number
  durationMs: number
  timeBuckets: TimeBucket[]
  modelRollups: ModelRollup[]
  modelBuckets: ModelBucket[]
  toolRollups: ToolRollup[]
  fileRollups: unknown[]
  turnRollups: TurnRollup[]
}

/** One accepted upload batch. */
export interface SyncCounts {
  inserted: number
  skipped: number
  conflicts: number
}

/** Panel state served by `POST /api/codetime`. */
export interface StatusPayload {
  configured: boolean
  maskedToken?: string
  autoUpload: boolean
  machineId: string
  /** Sessions folded locally. */
  sessions: number
  /** Sessions with activity the server has not accepted yet. */
  pending: number
  uploading: boolean
  lastUploadAt?: number
  lastError?: string
  lastSync?: SyncCounts
}

/** Request accepted by `POST /api/codetime`. */
export interface StatusRequest {
  action: 'status' | 'save' | 'clear' | 'sync'
  token?: string
  autoUpload?: boolean
}

/** Error payload shared with the settings page. */
export interface StatusError {
  error: string
}
