/** A durable daily-only barrier releases its worker while fanout siblings finish. */
import { DATE_INSTANT_PROVENANCE } from '../effective-date.ts';
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { MinionQueue } from '../minions/queue.ts';
import { resolveCycleDate, resolveCycleTimeZone } from './cycle-date.ts';
import { writeDailyMemoryFromSources, queueDailyMemoryExtract, isCalendarEffectiveDate, type SourcePageRow } from './daily-memory.ts';

export type DailyJob = { id: number; data: Record<string, unknown>; signal?: AbortSignal };
const TERMINAL = new Set(['completed', 'failed', 'dead', 'cancelled']);
const PENDING = new Set(['waiting', 'active', 'delayed', 'waiting-children', 'paused']);
function isDay(day: unknown): day is string {
  return typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day)
    && Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0,10) === day;
}

export async function pinDailyMemoryJob(engine: BrainEngine, job: DailyJob): Promise<DailyJob> {
  const day = typeof job.data.daily_memory_date === 'string' ? job.data.daily_memory_date : await resolveCycleDate(engine);
  if (!isDay(day)) {
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
  if ('daily_memory_dates' in job.data) return dispatchDailyDateBatch(engine, job);
  return finishFanoutDailyMemory(engine, await pinDailyMemoryJob(engine, job));
}

/** Calendar days an imported slug set should refresh in the daily index. */
export async function dailyMemoryDaysForSlugs(
  engine: BrainEngine,
  sourceId: string,
  slugs: string[],
): Promise<string[]> {
  if (slugs.length === 0) return [];
  const zone = await resolveCycleTimeZone(engine);
  const days = new Set<string>();
  for (let offset = 0; offset < slugs.length; offset += 100) {
    const rows = await engine.executeRaw<SourcePageRow & { utc_day: string; local_day: string }>(
      `SELECT source_id, slug, title, effective_date, effective_date_source,
         jsonb_build_object(COALESCE(effective_date_source,'date'),frontmatter->COALESCE(effective_date_source,'date'),
           'created',frontmatter->'created','created_at',frontmatter->'created_at',
           'date_created',frontmatter->'date_created','date created',frontmatter->'date created',
           '${DATE_INSTANT_PROVENANCE}',frontmatter->'${DATE_INSTANT_PROVENANCE}') AS frontmatter,
         to_char(effective_date AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS utc_day,
         to_char(COALESCE(effective_date, updated_at) AT TIME ZONE $1, 'YYYY-MM-DD') AS local_day
       FROM pages
       WHERE source_id = $2 AND slug = ANY($3::text[])`,
      [zone, sourceId, slugs.slice(offset, offset + 100)],
    );
    for (const row of rows) {
      days.add(row.effective_date && isCalendarEffectiveDate(row) ? row.utc_day : row.local_day);
    }
  }
  return [...days].sort();
}

async function queueDailyDateBatch(queue: Pick<MinionQueue, 'add'>, days: string[], sourceJobId: number, cursor: number): Promise<number> {
  const hash = createHash('sha256').update(JSON.stringify(days)).digest('hex').slice(0, 20);
  const data = { daily_memory_date: days[cursor], daily_memory_dates: days,
    daily_memory_source_job_id: sourceJobId, daily_memory_cursor: cursor };
  const job = await queue.add('autopilot-daily-memory', data, {
    idempotency_key: `autopilot-daily-batch:${sourceJobId}:${hash}:${cursor}`, max_attempts: 2, timeout_ms: 60_000,
  });
  if (!job || !['waiting','delayed','active','completed'].includes(job.status)
    || !Object.entries(data).every(([key,value]) => JSON.stringify(job.data[key]) === JSON.stringify(value))) {
    throw new Error('Daily memory affected-day handoff was not accepted');
  }
  return job.id;
}

export async function refreshDailyMemoryAfterSourceSync(engine: BrainEngine, job: DailyJob,
  sourceId: string | undefined, report: { status: string; phases: Array<{ phase: string; pagesAffected?: string[] }> }): Promise<void> {
  if (!sourceId) return;
  const saved = job.data.daily_memory_affected_dates ?? [];
  if (!Array.isArray(saved) || !saved.every(isDay)) throw new Error('Invalid saved daily memory dates');
  const slugs = report.status === 'failed' ? [] : report.phases.find(phase => phase.phase === 'sync')?.pagesAffected ?? [];
  const days = [...new Set([...saved, ...await dailyMemoryDaysForSlugs(engine, sourceId, slugs)])].sort();
  job.signal?.throwIfAborted();
  if (!days.length) return;
  if (JSON.stringify(days) !== JSON.stringify(saved)) {
    const written = await engine.executeRaw(`UPDATE minion_jobs SET data=jsonb_set(data,'{daily_memory_affected_dates}',($2::jsonb)->'days')
      WHERE id=$1 AND name='autopilot-cycle' AND status='active' RETURNING id`, [job.id, { days }]);
    if (!written.length) throw new Error('Affected daily memory dates were not persisted');
    job.data.daily_memory_affected_dates = days;
  }
  await queueDailyDateBatch(new MinionQueue(engine), days, job.id, 0);
}

async function dispatchDailyDateBatch(engine: BrainEngine, job: DailyJob) {
  const days = job.data.daily_memory_dates;
  const cursor = job.data.daily_memory_cursor, sourceJobId = job.data.daily_memory_source_job_id;
  if (!Array.isArray(days) || !days.length || !days.every(isDay)
    || !Number.isSafeInteger(cursor) || (cursor as number) < 0 || (cursor as number) >= days.length
    || !Number.isSafeInteger(sourceJobId) || (sourceJobId as number) <= 0) throw new Error('Invalid affected-day continuation');
  const queue = new MinionQueue(engine), start = cursor as number;
  for (const day of days.slice(start, start + 8)) {
    job.signal?.throwIfAborted();
    await queueFanoutDailyMemory(queue, { day, ids: [], key: `source:${sourceJobId}` });
  }
  const next = start + 8 < days.length ? await queueDailyDateBatch(queue, days, sourceJobId as number, start + 8) : null;
  return { daily_memory_days_queued: days.slice(start, start + 8), daily_memory_continuation_id: next };
}
