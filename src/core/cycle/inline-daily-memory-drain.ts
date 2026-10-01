/** A bounded consumer for accepted daily indexes when inline autopilot has no worker. */
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { MinionQueue } from '../minions/queue.ts';
import { calculateBackoff } from '../minions/backoff.ts';
import { runDailyMemoryJob, type DailyMemoryAfterWrite } from './daily-memory-followup.ts';

export async function drainInlineDailyMemory(engine: BrainEngine, opts: {
  signal?: AbortSignal; afterWrite: DailyMemoryAfterWrite; maxJobs?: number; timeBudgetMs?: number;
}): Promise<number> {
  const queue = new MinionQueue(engine), names = ['autopilot-daily-memory'];
  const deadline = Date.now() + Math.min(opts.timeBudgetMs ?? 60_000, 60_000);
  let processed = 0;
  while (processed < Math.min(opts.maxJobs ?? 20, 20) && Date.now() < deadline) {
    opts.signal?.throwIfAborted();
    await queue.handleStalled(undefined, { registeredNames: names, queue: 'default' });
    await queue.promoteDelayed({ registeredNames: names, queue: 'default' });
    const token = randomUUID(), job = await queue.claim(token, 60_000, 'default', names);
    if (!job) break;
    const abort = new AbortController();
    const forward = () => abort.abort(opts.signal?.reason);
    opts.signal?.addEventListener('abort', forward, { once: true });
    if (opts.signal?.aborted) forward();
    const lease = job.lock_duration_ms ?? 60_000;
    const remaining = Math.min(deadline - Date.now(), job.timeout_at ? job.timeout_at.getTime() - Date.now() : 60_000);
    const timeout = setTimeout(() => abort.abort(new Error('Inline daily memory deadline exceeded')), Math.max(0, remaining));
    let stopped = false, renewal: Promise<void> | undefined;
    const timer = setInterval(() => {
      if (stopped || renewal) return;
      renewal = queue.renewLock(job.id, token, lease, { signal: abort.signal }).then(owned => {
        if (!owned && !stopped) abort.abort(new Error('Inline daily memory lease lost'));
      }, error => { if (!stopped) abort.abort(error); }).finally(() => { renewal = undefined; });
    }, Math.max(250, Math.floor(lease / 3)));
    try {
      abort.signal.throwIfAborted();
      const result = await runDailyMemoryJob(engine, { id: job.id, data: job.data, signal: abort.signal }, async daily => {
        abort.signal.throwIfAborted();
        await opts.afterWrite(daily, abort.signal);
        abort.signal.throwIfAborted();
      });
      stopped = true; clearInterval(timer); await renewal;
      abort.signal.throwIfAborted();
      if (!await queue.completeJob(job.id, token, result as Record<string, unknown>)) throw new Error('Inline daily memory completion fence lost');
      processed++;
    } catch (error) {
      stopped = true; clearInterval(timer); await renewal;
      const terminal = job.attempts_made + 1 >= job.max_attempts;
      const failed = await queue.failJob(job.id, token, error instanceof Error ? error.message : String(error),
        terminal ? 'dead' : 'delayed', terminal ? 0 : calculateBackoff({ ...job, attempts_made: job.attempts_made + 1 }));
      if (!failed) throw new Error('Inline daily memory failure fence lost', { cause: error });
      throw error;
    } finally {
      stopped = true;
      clearInterval(timer); clearTimeout(timeout);
      opts.signal?.removeEventListener('abort', forward);
      await renewal;
    }
  }
  return processed;
}
