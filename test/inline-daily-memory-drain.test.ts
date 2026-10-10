import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { drainInlineDailyMemory } from '../src/core/cycle/inline-daily-memory-drain.ts';
import { queueStandaloneSyncDailyMemory } from '../src/core/cycle/daily-memory-followup.ts';
import { DAILY_MEMORY_SOURCE_ID, writeDailyMemoryFromSources } from '../src/core/cycle/daily-memory.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine, version: string | null;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); version = await engine.getConfig('version'); }, 60_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); if (version) await engine.setConfig('version', version); });
const seed = async (day: string) => {
  await engine.putPage(`notes/${day}`, { type: 'note', title: 'Historical fixture', compiled_truth: 'Synthetic fixture', frontmatter: { date: day } });
  await engine.executeRaw("UPDATE pages SET effective_date=$1::date::timestamptz,effective_date_source='date' WHERE source_id='default' AND slug=$2", [day, `notes/${day}`]);
};
const dailyData = (day: string) => ({ daily_memory_only: true, daily_memory_date: day, source_cycle_job_ids: [] });

test('inline consumer settles historical batches and leaves unrelated waiting/delayed jobs untouched', async () => {
  const queue = new MinionQueue(engine);
  const days = Array.from({ length: 10 }, (_, i) => `2026-01-${10+i}`);
  for (const day of days) await seed(day);
  const waiting = await queue.add('extract', { unrelated: true });
  const delayed = await queue.add('embed', { unrelated: true }, { delay: 1 });
  await engine.executeRaw("UPDATE minion_jobs SET delay_until=now()-interval '1 second' WHERE id=$1", [delayed.id]);
  const before = await engine.executeRaw('SELECT * FROM minion_jobs WHERE id=ANY($1::bigint[]) ORDER BY id', [[waiting.id, delayed.id]]);
  await queueStandaloneSyncDailyMemory(engine, { sourceId: 'default', commit: 'synthetic-history', days });
  const processed: string[] = [];
  expect(await drainInlineDailyMemory(engine, { afterWrite: async daily => { processed.push(daily.day); } })).toBeGreaterThan(10);
  expect([...new Set(processed)].sort()).toEqual(days);
  for (const day of days) expect((await engine.getPage(`daily-memory/${day}`, { sourceId: DAILY_MEMORY_SOURCE_ID }))?.compiled_truth).toContain(`[[default:notes/${day}]]`);
  expect(await engine.executeRaw('SELECT * FROM minion_jobs WHERE id=ANY($1::bigint[]) ORDER BY id', [[waiting.id, delayed.id]])).toEqual(before);
  expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE name='autopilot-daily-memory' AND status NOT IN ('completed','delayed')")).toHaveLength(0);
});

test('pending dependency yields a continuation until its existing sibling completes', async () => {
  const queue = new MinionQueue(engine), sibling = await queue.add('autopilot-cycle', {});
  const day = '2026-01-20'; await seed(day);
  await queue.add('autopilot-daily-memory', { ...dailyData(day), source_cycle_job_ids: [sibling.id] });
  expect(await drainInlineDailyMemory(engine, { afterWrite: async () => {} })).toBe(1);
  expect(await engine.getPage(`daily-memory/${day}`, { sourceId: DAILY_MEMORY_SOURCE_ID })).toBeNull();
  const claimed = (await queue.claim('synthetic-sibling', 60_000, 'default', ['autopilot-cycle']))!;
  await queue.completeJob(claimed.id, 'synthetic-sibling', {});
  await engine.executeRaw("UPDATE minion_jobs SET delay_until=now()-interval '1 second' WHERE name='autopilot-daily-memory' AND status='delayed'");
  expect(await drainInlineDailyMemory(engine, { afterWrite: async () => {} })).toBe(1);
  expect(await engine.getPage(`daily-memory/${day}`, { sourceId: DAILY_MEMORY_SOURCE_ID })).not.toBeNull();
});

test('extract failure retains the historical payload and retryable job before later completion', async () => {
  const queue = new MinionQueue(engine), day = '2026-01-21'; await seed(day);
  const job = await queue.add('autopilot-daily-memory', dailyData(day), { max_attempts: 2, backoff_type: 'fixed', backoff_delay: 0, backoff_jitter: 0 });
  await expect(drainInlineDailyMemory(engine, { afterWrite: async () => { throw new Error('Synthetic inline extraction failure'); } })).rejects.toThrow('Synthetic inline extraction failure');
  const retry = await queue.getJob(job.id);
  expect(retry?.status).toBe('delayed'); expect(retry?.data.daily_memory_date).toBe(day);
  expect(await engine.getPage(`daily-memory/${day}`, { sourceId: DAILY_MEMORY_SOURCE_ID })).not.toBeNull();
  await drainInlineDailyMemory(engine, { afterWrite: async () => {} });
  expect((await queue.getJob(job.id))?.status).toBe('completed');
});

test('consumer bound preserves the remaining accepted jobs and forwards its deadline signal', async () => {
  const queue = new MinionQueue(engine), day = '2026-01-22'; await seed(day);
  await queue.add('autopilot-daily-memory', dailyData(day));
  const next = await queue.add('autopilot-daily-memory', dailyData('2026-01-23'));
  let signal: AbortSignal | undefined;
  expect(await drainInlineDailyMemory(engine, { maxJobs: 1, afterWrite: async (_daily, supplied) => { signal = supplied; } })).toBe(1);
  expect(signal).toBeInstanceOf(AbortSignal);
  expect((await queue.getJob(next.id))?.status).toBe('waiting');
});


test('consumer deadline aborts without burning an attempt', async () => {
  const queue = new MinionQueue(engine), day = '2026-01-24'; await seed(day);
  await writeDailyMemoryFromSources(engine, { date: day });
  const job = await queue.add('autopilot-daily-memory', dailyData(day), { max_attempts: 2 });
  let supplied: AbortSignal | undefined;
  // Budget above the claim floor so the job is claimed, then aborts mid-callback.
  await expect(drainInlineDailyMemory(engine, { timeBudgetMs: 1_200, afterWrite: async (_daily, signal) => {
    supplied = signal;
    signal!.throwIfAborted();
    await new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }));
  } })).rejects.toThrow('Inline daily memory deadline exceeded');
  expect(supplied?.aborted).toBe(true);
  const row = await queue.getJob(job.id);
  expect(row?.status).toBe('active');
  expect(row?.attempts_made).toBe(0);
  expect(row?.data.daily_memory_date).toBe(day);
});

test('a job outliving its own timeout fails through the retry path instead of staying active', async () => {
  const queue = new MinionQueue(engine), day = '2026-01-25'; await seed(day);
  await writeDailyMemoryFromSources(engine, { date: day });
  const job = await queue.add('autopilot-daily-memory', dailyData(day), { max_attempts: 2, timeout_ms: 1_200 });
  await expect(drainInlineDailyMemory(engine, { timeBudgetMs: 60_000, afterWrite: async (_daily, signal) => {
    signal!.throwIfAborted();
    await new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }));
  } })).rejects.toThrow('Inline daily memory job timed out');
  const row = await queue.getJob(job.id);
  expect(row?.status).toBe('delayed');
  expect(row?.attempts_made).toBe(1);
});

test('insufficient shared budget stops claiming without touching waiting work', async () => {
  const queue = new MinionQueue(engine), day = '2026-01-29'; await seed(day);
  const job = await queue.add('autopilot-daily-memory', dailyData(day), { max_attempts: 2 });
  expect(await drainInlineDailyMemory(engine, { timeBudgetMs: 200, afterWrite: async () => {} })).toBe(0);
  const row = await queue.getJob(job.id);
  expect(row?.status).toBe('waiting');
  expect(row?.attempts_made).toBe(0);
  expect(row?.lock_token).toBeNull();
});

test('scoped stalled recovery resumes an expired daily claim without changing unrelated expired claims', async () => {
  const queue = new MinionQueue(engine), day = '2026-01-25'; await seed(day);
  const daily = await queue.add('autopilot-daily-memory', dailyData(day), { max_stalled: 2 });
  const unrelated = await queue.add('extract', { unrelated: true }, { max_stalled: 2 });
  await queue.claim('abandoned-daily', 60_000, 'default', ['autopilot-daily-memory']);
  await queue.claim('unrelated-owner', 60_000, 'default', ['extract']);
  await engine.executeRaw("UPDATE minion_jobs SET lock_until=now()-interval '10 minutes' WHERE id=ANY($1::bigint[])", [[daily.id, unrelated.id]]);
  const before = await queue.getJob(unrelated.id);
  expect(await drainInlineDailyMemory(engine, { afterWrite: async () => {} })).toBe(1);
  expect((await queue.getJob(daily.id))?.status).toBe('completed');
  expect(await queue.getJob(unrelated.id)).toEqual(before);
  expect(await engine.getPage(`daily-memory/${day}`, { sourceId: DAILY_MEMORY_SOURCE_ID })).not.toBeNull();
});

test('forwarded shutdown aborts without burning an attempt or failing the job', async () => {
  const queue = new MinionQueue(engine), day = '2026-01-26'; await seed(day);
  await writeDailyMemoryFromSources(engine, { date: day });
  const job = await queue.add('autopilot-daily-memory', dailyData(day), { max_attempts: 2 });
  const shutdown = new AbortController();
  await expect(drainInlineDailyMemory(engine, {
    signal: shutdown.signal,
    afterWrite: async (_daily, signal) => {
      const wait = new Promise<void>((_resolve, reject) => {
        if (signal!.aborted) { reject(signal!.reason instanceof Error ? signal!.reason : new Error(String(signal!.reason || 'aborted'))); return; }
        signal!.addEventListener('abort', () => {
          reject(signal!.reason instanceof Error ? signal!.reason : new Error(String(signal!.reason || 'aborted')));
        }, { once: true });
      });
      shutdown.abort(new Error('shutdown'));
      await wait;
    },
  })).rejects.toThrow('shutdown');
  const row = await queue.getJob(job.id);
  expect(row?.status).toBe('active');
  expect(row?.attempts_made).toBe(0);
  expect(row?.data.daily_memory_date).toBe(day);
});

test('lease-loss abort preserves the job without burning an attempt', async () => {
  const queue = new MinionQueue(engine), day = '2026-01-27'; await seed(day);
  await writeDailyMemoryFromSources(engine, { date: day });
  const job = await queue.add('autopilot-daily-memory', dailyData(day), { max_attempts: 2 });
  await expect(drainInlineDailyMemory(engine, {
    afterWrite: async () => { throw new Error('Inline daily memory lease lost'); },
  })).rejects.toThrow('Inline daily memory lease lost');
  const row = await queue.getJob(job.id);
  expect(row?.status).toBe('active');
  expect(row?.attempts_made).toBe(0);
  expect(row?.data.daily_memory_date).toBe(day);
});

test('lock-renewal failure aborts without burning an attempt', async () => {
  const queue = new MinionQueue(engine), day = '2026-01-28'; await seed(day);
  await writeDailyMemoryFromSources(engine, { date: day });
  const job = await queue.add('autopilot-daily-memory', dailyData(day), { max_attempts: 2 });
  await expect(drainInlineDailyMemory(engine, {
    afterWrite: async () => { throw new Error('Inline daily memory lock-renewal-failed'); },
  })).rejects.toThrow('Inline daily memory lock-renewal-failed');
  const row = await queue.getJob(job.id);
  expect(row?.status).toBe('active');
  expect(row?.attempts_made).toBe(0);
  expect(row?.data.daily_memory_date).toBe(day);
});
