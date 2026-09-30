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
  // Jump to the newest same-pin generation so long-lived pins (e.g. commit:'import')
  // do not exhaust a fixed walk from the base row.
  const [newest] = await engine.executeRaw<{ id: number; status: string; data: Record<string, unknown> }>(
    `SELECT id, status, data FROM minion_jobs
     WHERE name='extract'
       AND (idempotency_key=$1 OR idempotency_key LIKE $2)
     ORDER BY id DESC LIMIT 1`,
    [key, `${key}:after:%`],
  );
  if (newest && newest.id !== job.id) {
    job = { id: newest.id, status: newest.status, data: newest.data };
  }
  // Chain deterministic successors past finished/active rows. Concurrent
  // callers coalesce on after:<predecessorId>; same-pin re-handoffs advance.
  const seen = new Set<number>();
  while (!(isLiveSweep(job) && ['waiting', 'delayed'].includes(job.status))) {
    if (seen.has(job.id)) return isLiveSweep(job) ? job.id : null;
    seen.add(job.id);
    const predecessorId = job.id;
    job = await queue.add('extract', payload, {
      idempotency_key: `${key}:after:${predecessorId}`,
      timeout_ms: timeoutMs,
    });
    if (isLiveSweep(job) && job.status === 'active') {
      return job.id;
    }
    if (job.id === predecessorId) {
      return isLiveSweep(job) ? job.id : null;
    }
  }
  return job.id;
}
