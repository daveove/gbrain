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
  const deadline = Date.now() + (opts.timeBudgetMs ?? 60_000);
  let processed = 0;
  // Claim only when the shared window still has enough budget for meaningful
  // work. Jobs lock for 60s; claiming with a few ms left forces a deadline
  // abort that must not burn attempts (see catch path below).
  const minClaimBudgetMs = 1_000;
  while (processed < (opts.maxJobs ?? 20) && Date.now() < deadline) {
    opts.signal?.throwIfAborted();
    if (deadline - Date.now() < minClaimBudgetMs) break;
    await queue.handleStalled(undefined, { registeredNames: names, queue: 'default' });
    await queue.promoteDelayed({ registeredNames: names, queue: 'default' });
    const token = randomUUID(), job = await queue.claim(token, 60_000, 'default', names);
    if (!job) break;
    const abort = new AbortController();
    const forward = () => abort.abort(opts.signal?.reason);
    opts.signal?.addEventListener('abort', forward, { once: true });
    if (opts.signal?.aborted) forward();
    const lease = job.lock_duration_ms ?? 60_000;
    const drainLeft = deadline - Date.now();
    const jobLeft = job.timeout_at ? job.timeout_at.getTime() - Date.now() : 60_000;
    // Only the shared drain window is infrastructure; a job outliving its own
    // timeout fails through failJob like any worker-run timeout.
    const reason = jobLeft < drainLeft ? 'Inline daily memory job timed out' : 'Inline daily memory deadline exceeded';
    const timeout = setTimeout(() => abort.abort(new Error(reason)), Math.max(0, Math.min(jobLeft, drainLeft)));
    let stopped = false, renewal: Promise<void> | undefined;
    const timer = setInterval(() => {
      if (stopped || renewal) return;
      renewal = queue.renewLock(job.id, token, lease, { signal: abort.signal }).then(owned => {
        if (!owned && !stopped) abort.abort(new Error('Inline daily memory lease lost'));
      }, error => {
        // Worker-parity lock-renewal-failed: wrap so the catch path skips failJob.
        if (!stopped) abort.abort(new Error('Inline daily memory lock-renewal-failed', { cause: error }));
      }).finally(() => { renewal = undefined; });
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
      const message = error instanceof Error ? error.message : String(error);
      const abortReason = abort.signal.aborted
        ? (abort.signal.reason instanceof Error ? abort.signal.reason.message : String(abort.signal.reason || 'aborted'))
        : null;
      // Worker-parity: forwarded shutdown and lease-loss are infrastructure /
      // recovery events. failJob would burn attempts and can dead-letter a
      // two-attempt continuation after routine interruptions, losing dates
      // already retired from the originating checkpoint.
      const shutdown = Boolean(opts.signal?.aborted);
      const leaseLost = message === 'Inline daily memory lease lost'
        || abortReason === 'Inline daily memory lease lost';
      const renewalFailed = message === 'Inline daily memory lock-renewal-failed'
        || abortReason === 'Inline daily memory lock-renewal-failed';
      // Shared drain-window abort is infrastructure, not job failure: a late
      // claim can see only a few ms of remaining budget despite a 60s timeout.
      // failJob would burn attempts and can dead-letter a two-attempt
      // continuation that never received its configured runtime.
      const deadlineExceeded = message === 'Inline daily memory deadline exceeded'
        || abortReason === 'Inline daily memory deadline exceeded';
      if (shutdown || leaseLost || renewalFailed || deadlineExceeded) throw error;
      const terminal = job.attempts_made + 1 >= job.max_attempts;
      const failed = await queue.failJob(job.id, token, message,
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
