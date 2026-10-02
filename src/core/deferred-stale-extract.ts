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
  opts: { sourceId?: string; commit: string; reason: string; pendingAfter?: string },
): Promise<number | string | null> {
  const { MinionQueue } = await import('./minions/queue.ts');
  const { STALE_TIME_BUDGET_MS } = await import('../commands/extract.ts');
  const queue = new MinionQueue(engine);
  const payload = {
    stale: true,
    ...(opts.sourceId ? { sourceId: opts.sourceId } : {}),
    reason: opts.reason,
    deferred_commit: opts.commit,
    ...(opts.pendingAfter !== undefined ? { pending_after: opts.pendingAfter } : {}),
  };
  // The sweep's own wall-clock budget, plus headroom so the job is not
  // killed by the null-default timeout mid-sweep.
  const timeoutMs = STALE_TIME_BUDGET_MS + 5 * 60 * 1000;
  // No maxWaiting: an unscoped coalesce matches ANY waiting extract job and
  // would drop this sweep. The idempotency key is the dedup.
  const key = `extract-stale:${opts.sourceId ?? 'default'}:${opts.commit}`;
  const matchesSweep = (job: { data: Record<string, unknown> }): boolean =>
    job.data?.stale === true && job.data.sourceId === payload.sourceId
    && job.data.deferred_commit === opts.commit && job.data.pending_after === opts.pendingAfter;
  let nextKey = key;
  // Locate the retained tip once instead of replaying a lifetime-limited chain.
  // Same-pin callers still converge on after:<tipId> under queue idempotency.
  let locatedTip = false;
  const visited = new Set<number>();
  // This budget bounds concurrent claim races, never the number of prior generations.
  for (let races = 0; races < 8; races++) {
    const job = await queue.add('extract', payload, { idempotency_key: nextKey, timeout_ms: timeoutMs });
    if (!job || !matchesSweep(job) || !Number.isSafeInteger(job.id) || job.id <= 0) return null;
    if (['waiting', 'delayed'].includes(job.status)) return job.id;
    if (!['active', 'completed', 'failed', 'dead', 'cancelled'].includes(job.status)) return null;
    if (visited.has(job.id)) return null;
    visited.add(job.id);
    if (!locatedTip) {
      locatedTip = true;
      const prefix = `${key}:after:`;
      const [tip] = await engine.executeRaw<{ id: number; status: string; data: Record<string, unknown>; idempotency_key: string }>(
        `SELECT id,status,data,idempotency_key FROM minion_jobs WHERE name='extract'
          AND (idempotency_key=$1 OR (starts_with(idempotency_key,$2)
            AND substring(idempotency_key FROM length($2)+1) ~ '^[1-9][0-9]*$'))
          ORDER BY id DESC LIMIT 1`, [key, prefix]);
      if (!tip || !matchesSweep(tip) || !Number.isSafeInteger(tip.id) || tip.id < job.id) return null;
      if (['waiting', 'delayed'].includes(tip.status)) {
        nextKey = tip.idempotency_key;
        continue;
      }
      if (!['active', 'completed', 'failed', 'dead', 'cancelled'].includes(tip.status)) return null;
      nextKey = `${key}:after:${tip.id}`;
    } else nextKey = `${key}:after:${job.id}`;
  }
  return null;
}
