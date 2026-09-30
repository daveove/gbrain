/** A durable daily-only barrier releases its worker while fanout siblings finish. */
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { MinionQueue } from '../minions/queue.ts';
import { resolveCycleDate } from './cycle-date.ts';
import { writeDailyMemoryFromSources, queueDailyMemoryExtract } from './daily-memory.ts';

export type DailyJob = { id: number; data: Record<string, unknown>; signal?: AbortSignal };
const TERMINAL = new Set(['completed', 'failed', 'dead', 'cancelled']);
const PENDING = new Set(['waiting', 'active', 'delayed', 'waiting-children', 'paused']);

export async function pinDailyMemoryJob(engine: BrainEngine, job: DailyJob): Promise<DailyJob> {
  const day = typeof job.data.daily_memory_date === 'string' ? job.data.daily_memory_date : await resolveCycleDate(engine);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || new Date(day).toISOString().slice(0, 10) !== day) {
    throw new Error('Invalid daily memory fanout date');
  }
  return { ...job, data: { ...job.data, daily_memory_date: day } };
}

export async function queueFanoutDailyMemory(queue: Pick<MinionQueue, 'add'>,
  opts: { day: string; ids: number[]; key: string; delay?: number }): Promise<number> {
  const data = { daily_memory_only: true, daily_memory_date: opts.day, source_cycle_job_ids: [...new Set(opts.ids)].sort((a,b) => a-b) };
  const dependencies = createHash('sha256').update(JSON.stringify(data.source_cycle_job_ids)).digest('hex').slice(0, 20);
  const job = await queue.add('autopilot-daily-memory', data, {
    idempotency_key: `autopilot-daily:${opts.day}:${opts.key}:${dependencies}`, delay: opts.delay ?? 0,
    max_attempts: 2, timeout_ms: 60_000,
  });
  if (!job || !['waiting', 'delayed', 'active', 'completed'].includes(job.status)
    || job.data.daily_memory_only !== true || job.data.daily_memory_date !== opts.day
    || JSON.stringify(job.data.source_cycle_job_ids) !== JSON.stringify(data.source_cycle_job_ids)) {
    throw new Error('Daily memory completion barrier was not accepted');
  }
  return job.id;
}

export async function finishFanoutDailyMemory(engine: BrainEngine, job: DailyJob) {
  job.signal?.throwIfAborted();
  const day = job.data.daily_memory_date;
  const rawIds = job.data.source_cycle_job_ids ?? [];
  if (typeof day !== 'string' || !Array.isArray(rawIds) || !rawIds.every(id => Number.isSafeInteger(id) && id > 0)) {
    throw new Error('Invalid daily memory completion barrier');
  }
  const ids = [...new Set(rawIds as number[])];
  const rows = ids.length ? await engine.executeRaw<{ id: number; status: string }>(
    'SELECT id,status FROM minion_jobs WHERE id=ANY($1::bigint[])', [ids]) : [];
  if (rows.length !== ids.length || rows.some(row => !TERMINAL.has(row.status) && !PENDING.has(row.status))) {
    throw new Error('Daily memory completion barrier has missing or unknown jobs');
  }
  job.signal?.throwIfAborted();
  if (rows.some(row => PENDING.has(row.status))) {
    const id = await queueFanoutDailyMemory(new MinionQueue(engine), {
      day, ids, key: `after:${job.id}`, delay: 30_000,
    });
    return { daily_memory_pending: true, daily_memory_job_id: id, day };
  }
  const result = await writeDailyMemoryFromSources(engine, { date: day, signal: job.signal });
  if (result.reason === 'error') throw new Error('Daily memory completion write failed');
  await queueDailyMemoryExtract(engine, result);
  return { daily_memory_pending: false, day, daily_memory: result,
    dependency_failures: rows.filter(row => row.status !== 'completed').map(row => ({ id: row.id, status: row.status })) };
}

export async function runDailyMemoryJob(engine: BrainEngine, job: DailyJob) {
  return finishFanoutDailyMemory(engine, await pinDailyMemoryJob(engine, job));
}
