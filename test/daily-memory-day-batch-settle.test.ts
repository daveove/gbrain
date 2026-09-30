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

  test('affected-day batch waits for children and replays dead ones', async () => {
    const queue = new MinionQueue(engine);
    // Create a fake source cycle job row the batch can reference.
    const source = await queue.add('autopilot-cycle', { daily_memory_affected_dates: ['2026-09-28'] }, {
      max_attempts: 1, timeout_ms: 60_000,
    });
    const dayJob = await queue.add('autopilot-daily-memory', {
      daily_memory_date: '2026-09-28',
      daily_memory_only: true,
      source_cycle_job_ids: [],
    }, { max_attempts: 2, timeout_ms: 60_000 });
    await engine.executeRaw(
      "UPDATE minion_jobs SET status='dead', finished_at=now() WHERE id=$1",
      [dayJob.id],
    );
    const result = await runDailyMemoryJob(engine, {
      id: 0,
      data: {
        daily_memory_date: '2026-09-28',
        daily_memory_dates: ['2026-09-28'],
        daily_memory_source_job_id: source.id,
        daily_memory_cursor: 1, // past end => settle/replay only
        daily_memory_day_job_ids: [dayJob.id],
      },
    });
    expect(result.daily_memory_pending).toBe(true);
    expect(result.daily_memory_replayed).toBe(1);
    const jobs = await engine.executeRaw<{ status: string; data: Record<string, unknown>; idempotency_key: string }>(
      "SELECT status,data,idempotency_key FROM minion_jobs WHERE name='autopilot-daily-memory' ORDER BY id",
    );
    expect(jobs.some(j => String(j.idempotency_key).includes('replay') && j.data.daily_memory_date === '2026-09-28')).toBe(true);
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
    const result = await runDailyMemoryJob(engine, {
      id: 0,
      data: {
        daily_memory_date: '2026-09-28',
        daily_memory_dates: ['2026-09-28'],
        daily_memory_source_job_id: source.id,
        daily_memory_cursor: 1,
        daily_memory_day_job_ids: [dayJob.id],
      },
    });
    expect(result.daily_memory_pending).toBe(false);
    expect(result.daily_memory_replayed ?? 0).toBe(0);
    const after = await engine.executeRaw("SELECT id FROM minion_jobs WHERE name='autopilot-daily-memory'");
    expect(after.length).toBe(before.length);
  });
});
