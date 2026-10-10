import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import {
  previousCalendarDay,
  queueFanoutDailyMemoryWithRecordLookback,
  runDailyMemoryJob,
} from '../src/core/cycle/daily-memory-followup.ts';

describe('daily memory day-batch settle and record lookback', () => {
  let engine: PGLiteEngine;
  let schemaVersion: string | null;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    schemaVersion = await engine.getConfig('version');
  }, 30000);
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => {
    await resetPgliteState(engine);
    if (schemaVersion) await engine.setConfig('version', schemaVersion);
  });

  test('previousCalendarDay walks one UTC calendar day', () => {
    expect(previousCalendarDay('2026-10-01')).toBe('2026-09-30');
    expect(previousCalendarDay('not-a-day')).toBeNull();
  });

  test('current-day fanout also queues one-day record lookback', async () => {
    const queue = new MinionQueue(engine);
    const result = await queueFanoutDailyMemoryWithRecordLookback(queue, {
      day: '2026-10-01', ids: [], key: 'lookback-test',
    });
    expect(result.lookbackDay).toBe('2026-09-30');
    expect(result.lookbackJobId).toBeTruthy();
    const jobs = await engine.executeRaw<{ data: Record<string, unknown> }>(
      "SELECT data FROM minion_jobs WHERE name='autopilot-daily-memory' ORDER BY id",
    );
    const days = jobs.map(j => j.data.daily_memory_date);
    expect(days).toContain('2026-10-01');
    expect(days).toContain('2026-09-30');
  });

  for (const terminal of ['dead', 'cancelled']) test(`affected-day batches cap ${terminal} child replacements at two rounds`, async () => {
    const queue = new MinionQueue(engine), days = ['2026-09-28'];
    const source = await queue.add('autopilot-cycle', {});
    const child = await queue.add('autopilot-daily-memory', {
      daily_memory_date: days[0], daily_memory_only: true, source_cycle_job_ids: [],
    });
    await queue.add('autopilot-daily-memory', {
      daily_memory_date: days[0], daily_memory_dates: days, daily_memory_source_job_id: source.id,
      daily_memory_cursor: 1, daily_memory_day_job_ids: [child.id],
    });
    for (let round = 0; round <= 2; round++) {
      const failedChild = (await queue.claim('child-lock', 60_000, 'default', ['autopilot-daily-memory']))!;
      expect(failedChild.data.daily_memory_only).toBe(true);
      if (terminal === 'cancelled') expect((await queue.cancelJob(failedChild.id))!.status).toBe('cancelled');
      else await queue.failJob(failedChild.id, 'child-lock', 'Synthetic child failure', 'dead');
      const batch = (await queue.claim('batch-lock', 60_000, 'default', ['autopilot-daily-memory']))!;
      expect(batch.data.daily_memory_replay_round ?? 0).toBe(round);
      if (round === 2) {
        const before = await engine.executeRaw('SELECT id FROM minion_jobs');
        await expect(runDailyMemoryJob(engine, batch)).rejects.toThrow('replay exhausted');
        expect(await engine.executeRaw('SELECT id FROM minion_jobs')).toEqual(before);
        await queue.failJob(batch.id, 'batch-lock', 'Replay exhausted', 'dead');
        const [stored] = await engine.executeRaw<{ data: Record<string, unknown>; status: string }>('SELECT data,status FROM minion_jobs WHERE id=$1', [batch.id]);
        expect(stored.status).toBe('dead');
        expect(stored.data.daily_memory_dates).toEqual(days);
        expect(stored.data.daily_memory_day_job_ids).toEqual([failedChild.id]);
      } else {
        const result = await runDailyMemoryJob(engine, batch);
        if (!('daily_memory_replayed' in result)) throw new Error('Expected settlement result');
        expect(result.daily_memory_replayed).toBe(1);
        await queue.completeJob(batch.id, 'batch-lock', result);
        await engine.executeRaw("UPDATE minion_jobs SET delay_until=now()-interval '1 second' WHERE status='delayed'");
        await queue.promoteDelayed();
      }
    }
  });

  test('pending polls preserve the finite replay round and invalid counters fail closed', async () => {
    const queue = new MinionQueue(engine), days = ['2026-09-28'];
    const child = await queue.add('autopilot-daily-memory', { daily_memory_date: days[0] });
    const data = { daily_memory_dates: days, daily_memory_date: days[0], daily_memory_source_job_id: child.id,
      daily_memory_cursor: 1, daily_memory_day_job_ids: [child.id], daily_memory_replay_round: 2 };
    const pending = await runDailyMemoryJob(engine, { id: 100, data });
    if (!('daily_memory_job_id' in pending)) throw new Error('Expected settlement result');
    const [poll] = await engine.executeRaw<{ data: Record<string, unknown> }>('SELECT data FROM minion_jobs WHERE id=$1', [pending.daily_memory_job_id]);
    expect(poll.data.daily_memory_replay_round).toBe(2);
    expect(poll.data.daily_memory_day_job_ids).toEqual([child.id]);
    for (const invalid of [-1, 3, '2']) {
      await expect(runDailyMemoryJob(engine, { id: 101, data: { ...data, daily_memory_replay_round: invalid } })).rejects.toThrow('Invalid affected-day continuation');
    }
  });

  test('wait-only pending poll uses a fresh successor job', async () => {
    const queue = new MinionQueue(engine);
    const source = await queue.add('autopilot-cycle', { daily_memory_affected_dates: ['2026-09-28'] }, {
      max_attempts: 1, timeout_ms: 60_000,
    });
    const dayJob = await queue.add('autopilot-daily-memory', {
      daily_memory_date: '2026-09-28',
      daily_memory_only: true,
      source_cycle_job_ids: [],
    }, { max_attempts: 2, timeout_ms: 60_000 });
    // Leave child pending (waiting). First settle must enqueue a delayed successor, not itself.
    const settleA = await queue.add('autopilot-daily-memory', {
      daily_memory_date: '2026-09-28',
      daily_memory_dates: ['2026-09-28'],
      daily_memory_source_job_id: source.id,
      daily_memory_cursor: 1,
      daily_memory_day_job_ids: [dayJob.id],
    }, { max_attempts: 2, timeout_ms: 60_000 });
    const resultA = await runDailyMemoryJob(engine, {
      id: settleA.id,
      data: settleA.data,
    });
    if (!('daily_memory_job_id' in resultA)) throw new Error('Expected settlement result');
    expect(resultA.daily_memory_pending).toBe(true);
    expect(resultA.daily_memory_job_id).toBeTruthy();
    expect(resultA.daily_memory_job_id).not.toBe(settleA.id);
    const successor = await engine.executeRaw<{ id: number; status: string; idempotency_key: string }>(
      'SELECT id,status,idempotency_key FROM minion_jobs WHERE id=$1', [resultA.daily_memory_job_id],
    );
    expect(successor[0]?.status).toBe('delayed');
    // Second poll from the successor must also get a different delayed job (not the successor itself).
    const resultB = await runDailyMemoryJob(engine, {
      id: successor[0]!.id,
      data: {
        daily_memory_date: '2026-09-28',
        daily_memory_dates: ['2026-09-28'],
        daily_memory_source_job_id: source.id,
        daily_memory_cursor: 1,
        daily_memory_day_job_ids: [dayJob.id],
      },
    });
    if (!('daily_memory_job_id' in resultB)) throw new Error('Expected settlement result');
    expect(resultB.daily_memory_pending).toBe(true);
    expect(resultB.daily_memory_job_id).not.toBe(successor[0]!.id);
    expect(resultB.daily_memory_job_id).not.toBe(settleA.id);
  });

  test('bounds automatic day-job replays', async () => {
    const queue = new MinionQueue(engine);
    const source = await queue.add('autopilot-cycle', { daily_memory_affected_dates: ['2026-09-28'] }, {
      max_attempts: 1, timeout_ms: 60_000,
    });
    const dayJob = await queue.add('autopilot-daily-memory', {
      daily_memory_date: '2026-09-28',
      daily_memory_only: true,
      source_cycle_job_ids: [],
      daily_memory_replay_count: 2,
    }, { max_attempts: 2, timeout_ms: 60_000 });
    await engine.executeRaw("UPDATE minion_jobs SET status='dead', finished_at=now() WHERE id=$1", [dayJob.id]);
    const before = await engine.executeRaw("SELECT id FROM minion_jobs WHERE name='autopilot-daily-memory'");
    await expect(runDailyMemoryJob(engine, {
      id: 0,
      data: {
        daily_memory_date: '2026-09-28',
        daily_memory_dates: ['2026-09-28'],
        daily_memory_source_job_id: source.id,
        daily_memory_cursor: 1,
        daily_memory_day_job_ids: [dayJob.id], daily_memory_replay_round: 2,
      },
    })).rejects.toThrow('replay exhausted');
    const after = await engine.executeRaw("SELECT id FROM minion_jobs WHERE name='autopilot-daily-memory'");
    expect(after.length).toBe(before.length);
  });

  test('settlement replays a cancelled daily-memory child', async () => {
    const queue = new MinionQueue(engine);
    const source = await queue.add('autopilot-cycle', { daily_memory_affected_dates: ['2026-09-26'] }, {
      max_attempts: 1, timeout_ms: 60_000,
    });
    const dayJob = await queue.add('autopilot-daily-memory', {
      daily_memory_date: '2026-09-26',
      daily_memory_only: true,
      source_cycle_job_ids: [],
    }, { max_attempts: 2, timeout_ms: 60_000 });
    await engine.executeRaw("UPDATE minion_jobs SET status='cancelled', finished_at=now() WHERE id=$1", [dayJob.id]);
    const result = await runDailyMemoryJob(engine, {
      id: 0,
      data: {
        daily_memory_date: '2026-09-26',
        daily_memory_dates: ['2026-09-26'],
        daily_memory_source_job_id: source.id,
        daily_memory_cursor: 1,
        daily_memory_day_job_ids: [dayJob.id],
        daily_memory_replay_round: 0,
      },
    });
    if (!('daily_memory_replayed' in result)) throw new Error('Expected settlement result');
    expect(result.daily_memory_replayed).toBe(1);
  });

});
