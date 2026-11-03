import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-query'
import type { SessionFolder } from './rollups.js'

/** What one history pass folded. */
export interface ScanResult {
  /** Sessions considered inside the window. */
  sessions: number
  /** Events newly folded. */
  events: number
  /** Sessions that could not be read. */
  failed: number
}

/**
 * Fold stored session logs into the accumulator.
 *
 * The persisted cursor makes this idempotent: a session already seen through
 * the live feed contributes only its new tail.
 * @param ctx - plugin context providing the optional query service.
 * @param folder - fold target.
 * @param days - how far back `createdAt` may reach; 0 disables the pass.
 * @returns counts for diagnostics.
 */
export async function scanHistory(
  ctx: Context,
  folder: SessionFolder,
  days: number,
): Promise<ScanResult> {
  const result: ScanResult = { sessions: 0, events: 0, failed: 0 }
  if (days <= 0)
    return result
  const query = ctx.get('sessionQuery')
  if (!query)
    return result
  const records = await query.listSessions()
  const cutoff = Date.now() - days * 86_400_000
  for (const record of records) {
    if (record.header.createdAt < cutoff)
      continue
    result.sessions += 1
    try {
      const log = await query.readSession(record.header.id)
      result.events += folder.ingest({ id: log.session.id, cwd: log.session.cwd }, log.events)
    }
    catch {
      // One unreadable log must not abort the pass; the caller reports the count.
      result.failed += 1
    }
  }
  return result
}
