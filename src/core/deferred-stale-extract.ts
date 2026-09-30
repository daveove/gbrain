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
  const isLiveSweep = (job: { status: string; data: Record<string, unknown> }): boolean =>
    job.data?.stale === true && job.data.sourceId === payload.sourceId
    && job.data.deferred_commit === opts.commit && ['waiting', 'delayed', 'active'].includes(job.status);
  let job = await queue.add('extract', payload, { idempotency_key: key, timeout_ms: timeoutMs });
  if (!isLiveSweep(job) || !['waiting', 'delayed'].includes(job.status)) {
    // Deterministic successor keyed to the existing row: many concurrent
    // pending-target probes must not mint a UUID flood behind one active sweep.
    job = await queue.add('extract', payload, {
      idempotency_key: `${key}:after:${job.id}`,
      timeout_ms: timeoutMs,
    });
  }
  return isLiveSweep(job) ? job.id : null;
}
