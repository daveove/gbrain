/**
 * Durable follow-up for link/timeline extraction that is too large to drain
 * inline. Sync and import share one size gate and this queue submission so a
 * full or large import does not run the stale sweep inside the caller.
 */

import type { BrainEngine } from './engine.ts';

/** Same ceiling as incremental sync (`totalChanges <= 100`). */
export const INLINE_EXTRACT_CHANGE_LIMIT = 100;

/**
 * Queue a source-scoped `extract` job with `{ stale: true }`.
 * The idempotency key is the consumed commit (or another stable pin). A
 * waiting or delayed row for that pin is reused. Active and finished rows
 * may have already counted the backlog, so they need a durable successor.
 * Returns the live job id, or null when the returned row is not a live sweep.
 */
export async function queueDeferredStaleSweep(
  engine: BrainEngine,
  opts: { sourceId?: string; commit: string; reason: string },
): Promise<number | string | null> {
  const { MinionQueue } = await import('./minions/queue.ts');
  const { STALE_TIME_BUDGET_MS } = await import('../commands/extract.ts');
  const queue = new MinionQueue(engine);
  const payload = {
    stale: true,
    ...(opts.sourceId ? { sourceId: opts.sourceId } : {}),
    reason: opts.reason,
    deferred_commit: opts.commit,
  };
  // The sweep's own wall-clock budget, plus headroom so the job is not
  // killed by the null-default timeout mid-sweep.
  const timeoutMs = STALE_TIME_BUDGET_MS + 5 * 60 * 1000;
  // No maxWaiting: an unscoped coalesce matches ANY waiting extract job and
  // would drop this sweep. The idempotency key is the dedup.
  const key = `extract-stale:${opts.sourceId ?? 'default'}:${opts.commit}`;
  const matchesSweep = (job: { data: Record<string, unknown> }): boolean =>
    job.data?.stale === true && job.data.sourceId === payload.sourceId
    && job.data.deferred_commit === opts.commit;
  let nextKey = key;
  // Follow accepted predecessors, never create a run-unique sibling for each caller.
  // Bound old same-pin history; callers fail closed if it cannot be traversed safely.
  for (let depth = 0; depth < 64; depth++) {
    const job = await queue.add('extract', payload, { idempotency_key: nextKey, timeout_ms: timeoutMs });
    if (!job || !matchesSweep(job) || !Number.isSafeInteger(job.id) || job.id <= 0) return null;
    if (['waiting', 'delayed'].includes(job.status)) return job.id;
    if (!['active', 'completed', 'failed', 'dead', 'cancelled'].includes(job.status)) return null;
    nextKey = `${key}:after:${job.id}`;
  }
  return null;
}
