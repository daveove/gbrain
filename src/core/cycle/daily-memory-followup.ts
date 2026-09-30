/** A durable daily-only barrier releases its worker while fanout siblings finish. */
import { DATE_INSTANT_PROVENANCE, computeEffectiveDate } from '../effective-date.ts';
import { createHash, randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { MinionQueue } from '../minions/queue.ts';
import { calendarDateInTimeZone, resolveCycleDate, resolveCycleTimeZone, utcDate } from './cycle-date.ts';
import { writeDailyMemoryFromSources, queueDailyMemoryExtract, isCalendarEffectiveDate, DAILY_MEMORY_SOURCE_ID, type SourcePageRow } from './daily-memory.ts';

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

/** Prior calendar day for a YYYY-MM-DD value, or null when invalid. */
export function previousCalendarDay(day: string): string | null {
  if (!isDay(day)) return null;
  const dt = new Date(`${day}T00:00:00.000Z`);
  dt.setUTCDate(dt.getUTCDate() - 1);
  const prev = dt.toISOString().slice(0, 10);
  return isDay(prev) ? prev : null;
}

/** Current-day fanout plus a one-day lookback so late source_records still land. */
export async function queueFanoutDailyMemoryWithRecordLookback(
  queue: Pick<MinionQueue, 'add'>,
  opts: { day: string; ids: number[]; key: string; delay?: number },
): Promise<{ dayJobId: number; lookbackJobId: number | null; lookbackDay: string | null }> {
  const dayJobId = await queueFanoutDailyMemory(queue, opts);
  const lookbackDay = previousCalendarDay(opts.day);
  if (!lookbackDay) return { dayJobId, lookbackJobId: null, lookbackDay: null };
  const lookbackJobId = await queueFanoutDailyMemory(queue, {
    day: lookbackDay, ids: opts.ids, key: `${opts.key}:lookback1`, delay: opts.delay,
  });
  return { dayJobId, lookbackJobId, lookbackDay };
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
  opts: { signal?: AbortSignal } = {},
): Promise<string[]> {
  if (slugs.length === 0) return [];
  const zone = await resolveCycleTimeZone(engine);
  const days = new Set<string>();
  for (let offset = 0; offset < slugs.length; offset += 100) {
    opts.signal?.throwIfAborted();
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
    // Date edits can remove the old date from the target row before this refresh.
    // Exact rendered links also cover indexes whose graph extraction is still pending.
    let cursor = '';
    for (;;) {
      opts.signal?.throwIfAborted();
      const prior = await engine.executeRaw<{ slug: string }>(
        `SELECT p.slug FROM pages p JOIN sources s ON s.id=p.source_id
         WHERE (s.config @> '{"system_index":true}'::jsonb
           OR (s.name='Dream cycle indexes' AND s.config @> '{"federated":false}'::jsonb)) AND p.source_id=$1 AND p.deleted_at IS NULL
           AND p.frontmatter @> '{"dream_generated":true}'::jsonb
           AND p.slug ~ '^daily-memory/[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND p.slug>$4
           AND (EXISTS (SELECT 1 FROM links l JOIN pages t ON t.id=l.to_page_id
             WHERE l.from_page_id=p.id AND t.source_id=$2 AND t.slug=ANY($3::text[]))
             OR EXISTS (SELECT 1 FROM unnest($3::text[]) AS wanted(slug)
               WHERE strpos(COALESCE(p.compiled_truth,''),'[[' || $2 || ':' || wanted.slug || ']]')>0
                 OR ($2='default' AND strpos(COALESCE(p.compiled_truth,''),'[[' || wanted.slug || ']]')>0)))
         ORDER BY p.slug LIMIT 100`,
        [DAILY_MEMORY_SOURCE_ID, sourceId, slugs.slice(offset, offset + 100), cursor],
      );
      for (const row of prior) {
        const day = row.slug.slice('daily-memory/'.length);
        if (isDay(day)) days.add(day);
      }
      if (prior.length < 100) break;
      cursor = prior[prior.length - 1].slug;
    }
    // page_versions keep prior effective days when links were never extracted.
    let versionCursor = 0;
    for (;;) {
      opts.signal?.throwIfAborted();
      const versions = await engine.executeRaw<{
        id: number;
        slug: string;
        frontmatter: Record<string, unknown>;
        created_at: Date | string;
        updated_at: Date | string;
        import_filename: string | null;
        snapshot_at: Date | string;
      }>(
        `SELECT pv.id, p.slug,
           jsonb_build_object('event_date',pv.frontmatter->'event_date','date',pv.frontmatter->'date',
             'published',pv.frontmatter->'published','created',pv.frontmatter->'created',
             'created_at',pv.frontmatter->'created_at','date_created',pv.frontmatter->'date_created',
             'date created',pv.frontmatter->'date created',
             '${DATE_INSTANT_PROVENANCE}',pv.frontmatter->'${DATE_INSTANT_PROVENANCE}') AS frontmatter,
           p.created_at, p.updated_at, p.import_filename, pv.snapshot_at
         FROM page_versions pv
         JOIN pages p ON p.id = pv.page_id
         WHERE p.source_id = $1 AND p.slug = ANY($2::text[]) AND pv.id>$3
         ORDER BY pv.id LIMIT 100`,
        [sourceId, slugs.slice(offset, offset + 100), versionCursor],
      );
      for (const ver of versions) {
        const frontmatter = ver.frontmatter ?? {};
        const computed = computeEffectiveDate({
          slug: ver.slug,
          frontmatter,
          filename: ver.import_filename,
          createdAt: new Date(ver.created_at),
          updatedAt: new Date(ver.snapshot_at ?? ver.updated_at),
        });
        // Content-date keys only; page fallback timestamps are not prior index days.
        if (!computed.date || !computed.source || computed.source === 'fallback') continue;
        const row: SourcePageRow = {
          source_id: sourceId,
          slug: ver.slug,
          title: '',
          effective_date: computed.date,
          effective_date_source: computed.source,
          frontmatter,
        };
        const day = isCalendarEffectiveDate(row)
          ? utcDate(computed.date)
          : calendarDateInTimeZone(computed.date, zone);
        if (isDay(day)) days.add(day);
      }
      if (versions.length < 100) break;
      versionCursor = versions[versions.length - 1].id;
    }
  }
  return [...days].sort();
}

async function queueDailyDateBatch(queue: Pick<MinionQueue, 'add'>, days: string[], sourceJobId: number,
  cursor: number, childIds: number[] = [], delay = 0, pollFromJobId = 0, replayRound = 0): Promise<number> {
  const hash = createHash('sha256').update(JSON.stringify({ days, childIds, cursor, pollFromJobId, replayRound })).digest('hex').slice(0, 20);
  const day = days[Math.min(Math.max(cursor, 0), Math.max(days.length - 1, 0))] ?? days[0];
  const data = { daily_memory_date: day, daily_memory_dates: days,
    daily_memory_source_job_id: sourceJobId, daily_memory_cursor: cursor,
    daily_memory_day_job_ids: childIds, daily_memory_replay_round: replayRound };
  const job = await queue.add('autopilot-daily-memory', data, {
    idempotency_key: `autopilot-daily-batch:${sourceJobId}:${hash}:${cursor}`,
    max_attempts: 2, timeout_ms: 60_000, delay,
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
  const days = [...new Set([...saved, ...await dailyMemoryDaysForSlugs(engine, sourceId, slugs, { signal: job.signal })])].sort();
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


/** After archive/restore, refresh every day that source still owns or used to own. */
export async function refreshDailyMemoryAfterSourceArchiveChange(
  engine: BrainEngine,
  sourceId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<string[]> {
  if (!sourceId || sourceId === DAILY_MEMORY_SOURCE_ID) return [];
  const affectedDays = new Set<string>();
  let cursor = '';
  for (;;) {
    opts.signal?.throwIfAborted();
    const rows = await engine.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages WHERE source_id=$1 AND slug>$2 ORDER BY slug LIMIT 500`,
      [sourceId, cursor],
    );
    for (const day of await dailyMemoryDaysForSlugs(engine, sourceId, rows.map(row => row.slug), opts)) {
      affectedDays.add(day);
    }
    if (rows.length < 500) break;
    cursor = rows[rows.length - 1]!.slug;
  }
  const days = [...affectedDays].sort();
  if (!days.length) return [];
  const queue = new MinionQueue(engine);
  // Each invocation follows a committed lifecycle transition, independent of prior completed refreshes.
  const transitionKey = `archive:${sourceId}:${randomUUID()}`;
  opts.signal?.throwIfAborted();
  const firstChild = await queueFanoutDailyMemory(queue, { day: days[0], ids: [], key: transitionKey });
  await queueDailyDateBatch(queue, days, firstChild, 1, [firstChild]);
  return days;
}

/** Accept a complete standalone-sync day handoff before its checkpoint advances. */
export async function queueStandaloneSyncDailyMemory(
  engine: BrainEngine,
  opts: { sourceId: string; commit: string; days: string[] },
): Promise<number | null> {
  if (!opts.sourceId || !opts.commit || !Array.isArray(opts.days) || !opts.days.every(isDay)) {
    throw new Error('Invalid standalone sync daily memory handoff');
  }
  const days = [...new Set(opts.days)].sort();
  if (!days.length) return null;
  const hash = createHash('sha256').update(JSON.stringify(days)).digest('hex').slice(0, 20);
  // A checkpoint retry may duplicate an index write, but never reuse a finished refresh.
  const key = `sync:${opts.sourceId}:${opts.commit}:${hash}:${randomUUID()}`;
  const queue = new MinionQueue(engine);
  const firstChild = await queueFanoutDailyMemory(queue, { day: days[0], ids: [], key });
  return queueDailyDateBatch(queue, days, firstChild, 1, [firstChild]);
}

async function settleDailyDateChildren(
  engine: BrainEngine,
  job: DailyJob,
  days: string[],
  sourceJobId: number,
  childIds: number[],
  replayRound: number,
) {
  const queue = new MinionQueue(engine);
  const rows = childIds.length ? await engine.executeRaw<{ id: number; status: string; data: Record<string, unknown> }>(
    'SELECT id,status,data FROM minion_jobs WHERE id=ANY($1::bigint[])', [childIds]) : [];
  if (rows.length !== childIds.length || rows.some(row => !TERMINAL.has(row.status) && !PENDING.has(row.status))) {
    throw new Error('Daily memory day jobs missing or unknown');
  }
  job.signal?.throwIfAborted();
  if (rows.some(row => PENDING.has(row.status))) {
    const id = await queueDailyDateBatch(queue, days, sourceJobId, days.length, childIds, 30_000, job.id, replayRound);
    return { daily_memory_pending: true, daily_memory_job_id: id, daily_memory_days_queued: days };
  }
  const failed = rows.filter(row => row.status === 'dead' || row.status === 'failed');
  if (failed.length && replayRound >= 2) {
    throw new Error(`Daily memory child replay exhausted after ${replayRound} rounds; jobs=${failed.map(row => row.id).join(',')}; days=${days.join(',')}`);
  }
  const replayed: number[] = [];
  for (const row of failed) {
    const day = row.data.daily_memory_date;
    if (!isDay(day)) throw new Error('Invalid failed daily memory child date');
    job.signal?.throwIfAborted();
    replayed.push(await queueFanoutDailyMemory(queue, {
      day, ids: [], key: `source:${sourceJobId}:replay:${row.id}`,
    }));
  }
  if (replayed.length) {
    const id = await queueDailyDateBatch(queue, days, sourceJobId, days.length, replayed, 30_000, job.id, replayRound + 1);
    return { daily_memory_pending: true, daily_memory_job_id: id, daily_memory_replayed: replayed.length };
  }
  return {
    daily_memory_pending: false,
    daily_memory_days_queued: days,
    dependency_failures: rows.filter(row => row.status !== 'completed').map(row => ({ id: row.id, status: row.status })),
  };
}

async function dispatchDailyDateBatch(engine: BrainEngine, job: DailyJob) {
  const days = job.data.daily_memory_dates;
  const cursor = job.data.daily_memory_cursor, sourceJobId = job.data.daily_memory_source_job_id;
  const rawChildren = job.data.daily_memory_day_job_ids ?? [];
  const replayRound = job.data.daily_memory_replay_round ?? 0;
  if (!Array.isArray(days) || !days.length || !days.every(isDay)
    || !Number.isSafeInteger(cursor) || (cursor as number) < 0
    || !Number.isSafeInteger(sourceJobId) || (sourceJobId as number) <= 0
    || !Number.isSafeInteger(replayRound) || (replayRound as number) < 0 || (replayRound as number) > 2
    || !Array.isArray(rawChildren) || !rawChildren.every(id => Number.isSafeInteger(id) && id > 0)) {
    throw new Error('Invalid affected-day continuation');
  }
  const queue = new MinionQueue(engine);
  const start = cursor as number;
  let childIds = [...rawChildren as number[]];
  // Cursor past the end means we are only waiting on / replaying children.
  if (start >= days.length) {
    if (!childIds.length) throw new Error('Invalid affected-day continuation');
    return settleDailyDateChildren(engine, job, days, sourceJobId as number, childIds, replayRound as number);
  }
  for (const day of days.slice(start, start + 8)) {
    job.signal?.throwIfAborted();
    childIds.push(await queueFanoutDailyMemory(queue, { day, ids: [], key: `source:${sourceJobId}` }));
  }
  const nextCursor = start + 8;
  if (nextCursor < days.length) {
    const next = await queueDailyDateBatch(queue, days, sourceJobId as number, nextCursor, childIds, 0, 0, replayRound as number);
    return { daily_memory_days_queued: days.slice(start, nextCursor), daily_memory_continuation_id: next };
  }
  return settleDailyDateChildren(engine, job, days, sourceJobId as number, childIds, replayRound as number);
}
