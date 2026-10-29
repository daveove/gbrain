/** A durable daily-only barrier releases its worker while fanout siblings finish. */
import { DATE_INSTANT_PROVENANCE, computeEffectiveDate } from '../effective-date.ts';
import { createHash, randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { appendCompleted } from '../op-checkpoint.ts';
import { MinionQueue } from '../minions/queue.ts';
import { calendarDateInTimeZone, resolveCycleTimeZone, isValidTimeZone, utcDate } from './cycle-date.ts';
import { writeDailyMemoryFromSources, queueDailyMemoryExtract, isCalendarEffectiveDate, DAILY_MEMORY_SOURCE_ID, type SourcePageRow } from './daily-memory.ts';

export type DailyJob = { id: number; data: Record<string, unknown>; signal?: AbortSignal };
const TERMINAL = new Set(['completed', 'failed', 'dead', 'cancelled']);
const PENDING = new Set(['waiting', 'active', 'delayed', 'waiting-children', 'paused']);
// A first write of a busy day is many round trips to a remote database (about
// a minute on a hosted Postgres), so 60 seconds timed out every attempt. A
// rewrite of a heavy historical day took 381 s and later passed 600 s
// (DAV-7404). 20 minutes stays inside the nightly writer's 30-minute drain
// budget, so the job's own timeout still bounds one slow day.
const DAILY_MEMORY_JOB_TIMEOUT_MS = 20 * 60_000;
function isDay(day: unknown): day is string {
  return typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day)
    && Number.isFinite(Date.parse(day)) && utcDate(new Date(day)) === day;
}

function pinnedDailyMemoryTimezone(data: Record<string, unknown>): string | undefined {
  if (!('daily_memory_timezone' in data)) return undefined;
  const zone = data.daily_memory_timezone;
  if (typeof zone !== 'string' || !zone.trim() || !isValidTimeZone(zone.trim())) {
    throw new Error('Invalid daily memory timezone');
  }
  return zone.trim();
}

export async function pinDailyMemoryJob(engine: BrainEngine, job: DailyJob): Promise<DailyJob> {
  const timezone = pinnedDailyMemoryTimezone(job.data) ?? await resolveCycleTimeZone(engine);
  const day = job.data.daily_memory_date ?? calendarDateInTimeZone(new Date(), timezone);
  if (!isDay(day)) throw new Error('Invalid daily memory fanout date');
  const pin = { daily_memory_date: day, daily_memory_timezone: timezone };
  if (job.data.daily_memory_date === day && job.data.daily_memory_timezone === timezone) return job;
  // Legacy active jobs pin durably before the first write or deferred handoff.
  const stored = await engine.executeRaw<{ data: Record<string, unknown>; status: string }>(
    "SELECT data,status FROM minion_jobs WHERE id=$1 AND name IN ('autopilot-daily-memory','autopilot-global-maintenance')", [job.id]);
  if (stored[0]?.status === 'active') {
    if (pinnedDailyMemoryTimezone(stored[0].data) && isDay(stored[0].data.daily_memory_date)) {
      return { ...job, data: stored[0].data };
    }
    const written = await engine.executeRaw<{ data: Record<string, unknown> }>(
      `UPDATE minion_jobs SET data=data || $2::jsonb WHERE id=$1 AND status='active'
        AND name IN ('autopilot-daily-memory','autopilot-global-maintenance') AND data=$3::jsonb RETURNING data`, [job.id, pin, stored[0].data]);
    const canonical = written[0]?.data ?? (await engine.executeRaw<{ data: Record<string, unknown> }>(
      "SELECT data FROM minion_jobs WHERE id=$1 AND status='active' AND name IN ('autopilot-daily-memory','autopilot-global-maintenance')", [job.id]))[0]?.data;
    if (!canonical || !isDay(canonical.daily_memory_date) || !pinnedDailyMemoryTimezone(canonical)) {
      throw new Error('Daily memory pin was not persisted');
    }
    return { ...job, data: canonical };
  }
  return { ...job, data: { ...job.data, ...pin } };
}

export async function queueFanoutDailyMemory(queue: Pick<MinionQueue, 'add'>,
  opts: { day: string; ids: number[]; key: string; delay?: number; timezone?: string }): Promise<number> {
  const data: Record<string, unknown> = {
    daily_memory_only: true, daily_memory_date: opts.day,
    source_cycle_job_ids: [...new Set(opts.ids)].sort((a,b) => a-b),
  };
  if (opts.timezone !== undefined) data.daily_memory_timezone = pinnedDailyMemoryTimezone({ daily_memory_timezone: opts.timezone });
  const dependencies = createHash('sha256').update(JSON.stringify([data.source_cycle_job_ids, data.daily_memory_timezone ?? null])).digest('hex').slice(0, 20);
  const job = await queue.add('autopilot-daily-memory', data, {
    idempotency_key: `autopilot-daily:${opts.day}:${opts.key}:${dependencies}`, delay: opts.delay ?? 0,
    max_attempts: 2, timeout_ms: DAILY_MEMORY_JOB_TIMEOUT_MS,
  });
  if (!job || !['waiting', 'delayed', 'active', 'completed'].includes(job.status)
    || !Object.entries(data).every(([key, value]) => JSON.stringify(job.data[key]) === JSON.stringify(value))) {
    throw new Error('Daily memory completion barrier was not accepted');
  }
  return job.id;
}

/** Prior calendar day for a YYYY-MM-DD value, or null when invalid. */
export function previousCalendarDay(day: string): string | null {
  if (!isDay(day)) return null;
  const dt = new Date(`${day}T00:00:00.000Z`);
  dt.setUTCDate(dt.getUTCDate() - 1);
  const prev = utcDate(dt);
  return isDay(prev) ? prev : null;
}

/** Current-day fanout plus a one-day lookback so late source_records still land. */
export async function queueFanoutDailyMemoryWithRecordLookback(
  queue: Pick<MinionQueue, 'add'>,
  opts: { day: string; ids: number[]; key: string; delay?: number; timezone?: string },
): Promise<{ dayJobId: number; lookbackJobId: number | null; lookbackDay: string | null }> {
  const dayJobId = await queueFanoutDailyMemory(queue, opts);
  const lookbackDay = previousCalendarDay(opts.day);
  if (!lookbackDay) return { dayJobId, lookbackJobId: null, lookbackDay: null };
  const lookbackJobId = await queueFanoutDailyMemory(queue, {
    day: lookbackDay, ids: opts.ids, key: `${opts.key}:lookback1`, delay: opts.delay, timezone: opts.timezone,
  });
  return { dayJobId, lookbackJobId, lookbackDay };
}


export type DailyMemoryAfterWrite = (result: import('./daily-memory.ts').DailyMemoryWrite, signal?: AbortSignal) => Promise<void>;

export async function finishFanoutDailyMemory(engine: BrainEngine, job: DailyJob, afterWrite?: DailyMemoryAfterWrite) {
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
      timezone: pinnedDailyMemoryTimezone(job.data),
    });
    return { daily_memory_pending: true, daily_memory_job_id: id, day };
  }
  const result = await writeDailyMemoryFromSources(engine, {
    date: day, timezone: pinnedDailyMemoryTimezone(job.data), signal: job.signal,
  });
  if (result.reason === 'error') throw new Error('Daily memory completion write failed');
  if (afterWrite) await afterWrite(result, job.signal);
  else await queueDailyMemoryExtract(engine, result);
  return { daily_memory_pending: false, day, daily_memory: result,
    dependency_failures: rows.filter(row => row.status !== 'completed').map(row => ({ id: row.id, status: row.status })) };
}

export async function runDailyMemoryJob(engine: BrainEngine, job: DailyJob, afterWrite?: DailyMemoryAfterWrite) {
  const pinned = await pinDailyMemoryJob(engine, job);
  if ('daily_memory_dates' in pinned.data) return dispatchDailyDateBatch(engine, pinned);
  return finishFanoutDailyMemory(engine, pinned, afterWrite);
}

/** Calendar days an imported slug set should refresh in the daily index. */
export async function dailyMemoryDaysForSlugs(
  engine: BrainEngine,
  sourceId: string,
  slugs: string[],
  opts: { signal?: AbortSignal; timezone?: string; recoverHistory?: boolean } = {},
): Promise<string[]> {
  if (slugs.length === 0) return [];
  const zone = opts.timezone === undefined ? await resolveCycleTimeZone(engine)
    : pinnedDailyMemoryTimezone({ daily_memory_timezone: opts.timezone })!;
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
    // Ordinary publications already capture their preimage under page guards.
    // Only recovery callers need to rediscover unbounded historical versions.
    if (opts.recoverHistory === false) continue;
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
          timeZone: zone,
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
  cursor: number, childIds: number[] = [], delay = 0, pollFromJobId = 0, replayRound = 0,
  handoffGeneration = '', timezone?: string): Promise<number> {
  // Handoff generations (refresh path) mint a fresh batch so a completed prior
  // batch for the same parent+days cannot satisfy newly banked retry work.
  const hash = createHash('sha256').update(JSON.stringify({ days, childIds, cursor, pollFromJobId, replayRound, handoffGeneration, timezone })).digest('hex').slice(0, 20);
  const day = days[Math.min(Math.max(cursor, 0), Math.max(days.length - 1, 0))] ?? days[0];
  const data: Record<string, unknown> = { daily_memory_date: day, daily_memory_dates: days,
    daily_memory_source_job_id: sourceJobId, daily_memory_cursor: cursor,
    daily_memory_day_job_ids: childIds, daily_memory_replay_round: replayRound };
  if (handoffGeneration) data.daily_memory_handoff_generation = handoffGeneration;
  if (timezone !== undefined) data.daily_memory_timezone = pinnedDailyMemoryTimezone({ daily_memory_timezone: timezone });
  const job = await queue.add('autopilot-daily-memory', data, {
    idempotency_key: `autopilot-daily-batch:${sourceJobId}:${hash}:${cursor}`,
    max_attempts: 2, timeout_ms: DAILY_MEMORY_JOB_TIMEOUT_MS, delay,
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
  const timezone = pinnedDailyMemoryTimezone(job.data) ?? await resolveCycleTimeZone(engine);
  const saved = job.data.daily_memory_affected_dates ?? [];
  if (!Array.isArray(saved) || !saved.every(isDay)) throw new Error('Invalid saved daily memory dates');
  const slugs = report.status === 'failed' ? [] : report.phases.find(phase => phase.phase === 'sync')?.pagesAffected ?? [];
  const key = { op: 'autopilot-sync-daily-memory', fingerprint: createHash('sha256').update(sourceId).digest('hex').slice(0, 16) };
  const entries = [...new Set(saved)].map(day => JSON.stringify({ jobId: job.id, day }));
  entries.push(...[...new Set(slugs)].map(slug => JSON.stringify({ jobId: job.id, slug })));
  if (entries.length && !await appendCompleted(engine, key, entries)) throw new Error('Source daily memory debt was not persisted');
  const debt: Array<{ path: string }> = [];
  let cursor = '';
  for (;;) {
    job.signal?.throwIfAborted();
    const rows = await engine.executeRaw<{ path: string }>(
      'SELECT path FROM op_checkpoint_paths WHERE op=$1 AND fingerprint=$2 AND path>$3 ORDER BY path LIMIT 100',
      [key.op, key.fingerprint, cursor]);
    debt.push(...rows);
    if (rows.length < 100) break;
    cursor = rows[rows.length - 1]!.path;
  }
  const savedDays = new Set<string>(), savedSlugs = new Set<string>();
  for (const { path } of debt) {
    if (path.startsWith('day:') && isDay(path.slice(4))) { savedDays.add(path.slice(4)); continue; }
    const entry = JSON.parse(path);
    if (!entry || !Number.isSafeInteger(entry.jobId) || entry.jobId <= 0
      || !(isDay(entry.day) || typeof entry.slug === 'string' && entry.slug.length > 0)) throw new Error('Invalid source daily memory debt');
    if (isDay(entry.day)) savedDays.add(entry.day);
    else savedSlugs.add(entry.slug);
  }
  const days = [...new Set([...savedDays, ...await dailyMemoryDaysForSlugs(engine, sourceId, [...savedSlugs], { signal: job.signal, timezone })])].sort();
  const dateEntries = days.map(day => JSON.stringify({ jobId: job.id, day }));
  if (dateEntries.length && !await appendCompleted(engine, key, dateEntries)) throw new Error('Source daily memory dates were not persisted');
  debt.push(...dateEntries.map(path => ({ path })));
  job.signal?.throwIfAborted();
  // Retire only discovered/accepted entries; a concurrent origin's bank remains durable.
  const retireSnapshot = async () => {
    for (let start = 0; start < debt.length; start += 100) {
      await engine.executeRawDirect('DELETE FROM op_checkpoint_paths WHERE op=$1 AND fingerprint=$2 AND path=ANY($3::text[])',
        [key.op, key.fingerprint, debt.slice(start, start + 100).map(row => row.path)]);
    }
  };
  if (!days.length) { await retireSnapshot(); return; }
  if (JSON.stringify(days) !== JSON.stringify(saved)) {
    const written = await engine.executeRaw(`UPDATE minion_jobs SET data=jsonb_set(data,'{daily_memory_affected_dates}',($2::jsonb)->'days')
      WHERE id=$1 AND name='autopilot-cycle' AND status='active' RETURNING id`, [job.id, { days }]);
    if (!written.length) throw new Error('Affected daily memory dates were not persisted');
    job.data.daily_memory_affected_dates = days;
  }
  await queueDailyDateBatch(new MinionQueue(engine), days, job.id, 0, [], 0, 0, 0, randomUUID(), timezone);
  await retireSnapshot();
}


export interface PageMutationDailyMemory {
  sourceId: string; slug: string; operation: string; priorDays?: string[]; timezone?: string;
}

/** Accept historical index work inside the page publication transaction. */
export async function refreshDailyMemoryAfterPageMutation(
  engine: BrainEngine,
  opts: PageMutationDailyMemory,
): Promise<string[]> {
  return (await refreshDailyMemoryAfterPageMutations(engine, [opts]))[0]!;
}

/** Lock day jobs in one global order, not each group member's individual order. */
export async function refreshDailyMemoryAfterPageMutations(
  engine: BrainEngine,
  mutations: PageMutationDailyMemory[],
): Promise<string[][]> {
  const affected: string[][] = [];
  const pending = new Map<string, { day: string; timezone: string }>();
  for (const opts of mutations) {
    if (!opts.sourceId || !opts.slug || opts.sourceId === DAILY_MEMORY_SOURCE_ID ||
      !['put_page', 'edit_page', 'delete_page', 'restore_page', 'capture', 'revert_version'].includes(opts.operation)) {
      affected.push([]); continue;
    }
    if (opts.priorDays !== undefined && (!Array.isArray(opts.priorDays) || !opts.priorDays.every(isDay))) {
      throw new Error('Invalid prior daily memory dates');
    }
    // Prefer the timezone captured with priorDays so a mid-handoff cycle.timezone
    // flip cannot rewrite old-zone days with new-zone filters.
    const timezone = opts.timezone === undefined ? await resolveCycleTimeZone(engine)
      : pinnedDailyMemoryTimezone({ daily_memory_timezone: opts.timezone })!;
    const days = [...new Set([...(opts.priorDays ?? []),
      ...await dailyMemoryDaysForSlugs(engine, opts.sourceId, [opts.slug], { timezone, recoverHistory: false })])].sort();
    affected.push(days);
    for (const day of days) pending.set(`${day}:${timezone}`, { day, timezone });
  }
  if (pending.size) await engine.transaction(async tx => {
    for (const key of [...pending.keys()].sort()) {
      const { day, timezone } = pending.get(key)!;
      await queuePendingDailyMemory(tx, day, timezone);
    }
  });
  return affected;
}

/** Reuse unclaimed day work; claimed/finished renders need a durable successor. */
async function queuePendingDailyMemory(engine: BrainEngine, day: string, timezone: string): Promise<number> {
  const queue = new MinionQueue(engine);
  const data = { daily_memory_only: true, daily_memory_date: day, source_cycle_job_ids: [],
    daily_memory_timezone: timezone };
  const key = `autopilot-daily:${day}:${timezone}:pending`;
  let nextKey = key, locatedTip = false;
  const visited = new Set<number>();
  // Bound concurrent claim races, not the lifetime number of prior renders.
  for (let races = 0; races < 8; races++) {
    const accepted = await queue.add('autopilot-daily-memory', data, {
      idempotency_key: nextKey, max_attempts: 2, timeout_ms: DAILY_MEMORY_JOB_TIMEOUT_MS,
    });
    if (!accepted || !Number.isSafeInteger(accepted.id) || accepted.id <= 0) break;
    // Hold the pending row until publication commits. A worker that claimed
    // between admission and this lock must receive a successor, not stale work.
    const [job] = await engine.executeRaw<{ id: number; status: string; data: Record<string, unknown> }>(
      'SELECT id,status,data FROM minion_jobs WHERE id=$1 FOR UPDATE', [accepted.id]);
    if (!job || !Object.entries(data).every(([field, value]) => JSON.stringify(job.data[field]) === JSON.stringify(value))
      || !Number.isSafeInteger(job.id) || job.id <= 0) break;
    if (['waiting', 'delayed'].includes(job.status)) return job.id;
    if ((!TERMINAL.has(job.status) && job.status !== 'active') || visited.has(job.id)) break;
    visited.add(job.id);
    if (!locatedTip) {
      locatedTip = true;
      const prefix = `${key}:after:`;
      const [tip] = await engine.executeRaw<{ id: number; status: string; data: Record<string, unknown>; idempotency_key: string }>(
        `SELECT id,status,data,idempotency_key FROM minion_jobs WHERE name='autopilot-daily-memory'
          AND (idempotency_key=$1 OR (starts_with(idempotency_key,$2)
            AND substring(idempotency_key FROM length($2)+1) ~ '^[1-9][0-9]*$'))
          ORDER BY id DESC LIMIT 1`, [key, prefix]);
      if (!tip || !Object.entries(data).every(([field, value]) => JSON.stringify(tip.data[field]) === JSON.stringify(value))
        || !Number.isSafeInteger(tip.id) || tip.id < job.id) break;
      if (['waiting', 'delayed'].includes(tip.status)) { nextKey = tip.idempotency_key; continue; }
      if (!TERMINAL.has(tip.status) && tip.status !== 'active') break;
      nextKey = `${key}:after:${tip.id}`;
    } else nextKey = `${key}:after:${job.id}`;
  }
  throw new Error('Daily memory publication handoff was not accepted');
}

/** After archive/restore, refresh every day that source still owns or used to own. */
export async function refreshDailyMemoryAfterSourceArchiveChange(
  engine: BrainEngine,
  sourceId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<string[]> {
  if (!sourceId || sourceId === DAILY_MEMORY_SOURCE_ID) return [];
  const timezone = await resolveCycleTimeZone(engine);
  const affectedDays = new Set<string>();
  let cursor = '';
  for (;;) {
    opts.signal?.throwIfAborted();
    const rows = await engine.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages WHERE source_id=$1 AND slug>$2 ORDER BY slug LIMIT 500`,
      [sourceId, cursor],
    );
    for (const day of await dailyMemoryDaysForSlugs(engine, sourceId, rows.map(row => row.slug), { ...opts, timezone })) {
      affectedDays.add(day);
    }
    if (rows.length < 500) break;
    cursor = rows[rows.length - 1]!.slug;
  }
  const days = [...affectedDays].sort();
  if (!days.length) return [];
  const queue = new MinionQueue(engine);
  // The lifecycle caller owns the transaction boundary; separate transitions need fresh refreshes.
  const transitionKey = `archive:${sourceId}:${randomUUID()}`;
  opts.signal?.throwIfAborted();
  const firstChild = await queueFanoutDailyMemory(queue, { day: days[0], ids: [], key: transitionKey, timezone });
  await queueDailyDateBatch(queue, days, firstChild, 1, [firstChild], 0, 0, 0, '', timezone);
  return days;
}

/** Accept a complete standalone-sync day handoff before its checkpoint advances. */
export async function queueStandaloneSyncDailyMemory(
  engine: BrainEngine,
  opts: { sourceId: string; commit: string; days: string[]; timezone?: string },
): Promise<number | null> {
  if (!opts.sourceId || !opts.commit || !Array.isArray(opts.days) || !opts.days.every(isDay)) {
    throw new Error('Invalid standalone sync daily memory handoff');
  }
  const timezone = opts.timezone === undefined ? await resolveCycleTimeZone(engine)
    : pinnedDailyMemoryTimezone({ daily_memory_timezone: opts.timezone })!;
  const days = [...new Set(opts.days)].sort();
  if (!days.length) return null;
  const hash = createHash('sha256').update(JSON.stringify(days)).digest('hex').slice(0, 20);
  // A checkpoint retry may duplicate an index write, but never reuse a finished refresh.
  const key = `sync:${opts.sourceId}:${opts.commit}:${hash}:${randomUUID()}`;
  const queue = new MinionQueue(engine);
  const firstChild = await queueFanoutDailyMemory(queue, { day: days[0], ids: [], key, timezone });
  return queueDailyDateBatch(queue, days, firstChild, 1, [firstChild], 0, 0, 0, '', timezone);
}

async function settleDailyDateChildren(
  engine: BrainEngine,
  job: DailyJob,
  days: string[],
  sourceJobId: number,
  childIds: number[],
  replayRound: number,
  handoffGeneration = '',
) {
  const queue = new MinionQueue(engine);
  const rows = childIds.length ? await engine.executeRaw<{ id: number; status: string; data: Record<string, unknown> }>(
    'SELECT id,status,data FROM minion_jobs WHERE id=ANY($1::bigint[])', [childIds]) : [];
  if (rows.length !== childIds.length || rows.some(row => !TERMINAL.has(row.status) && !PENDING.has(row.status))) {
    throw new Error('Daily memory day jobs missing or unknown');
  }
  job.signal?.throwIfAborted();
  if (rows.some(row => PENDING.has(row.status))) {
    const id = await queueDailyDateBatch(queue, days, sourceJobId, days.length, childIds, 30_000, job.id, replayRound, handoffGeneration, pinnedDailyMemoryTimezone(job.data));
    return { daily_memory_pending: true, daily_memory_job_id: id, daily_memory_days_queued: days };
  }
  const failed = rows.filter(row => row.status === 'dead' || row.status === 'failed' || row.status === 'cancelled');
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
      timezone: pinnedDailyMemoryTimezone(job.data),
    }));
  }
  if (replayed.length) {
    const id = await queueDailyDateBatch(queue, days, sourceJobId, days.length, replayed, 30_000, job.id, replayRound + 1, handoffGeneration, pinnedDailyMemoryTimezone(job.data));
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
  const handoffGeneration = typeof job.data.daily_memory_handoff_generation === 'string'
    ? job.data.daily_memory_handoff_generation : '';
  if (!Array.isArray(days) || !days.length || !days.every(isDay)
    || !Number.isSafeInteger(cursor) || (cursor as number) < 0
    || !Number.isSafeInteger(sourceJobId) || (sourceJobId as number) <= 0
    || !Number.isSafeInteger(replayRound) || (replayRound as number) < 0 || (replayRound as number) > 2
    || (handoffGeneration !== '' && (handoffGeneration.length < 8 || handoffGeneration.length > 80))
    || !Array.isArray(rawChildren) || !rawChildren.every(id => Number.isSafeInteger(id) && id > 0)) {
    throw new Error('Invalid affected-day continuation');
  }
  const queue = new MinionQueue(engine);
  const start = cursor as number;
  let childIds = [...rawChildren as number[]];
  const fanoutKey = handoffGeneration
    ? `source:${sourceJobId}:${handoffGeneration}`
    : `source:${sourceJobId}`;
  // Cursor past the end means we are only waiting on / replaying children.
  if (start >= days.length) {
    if (!childIds.length) throw new Error('Invalid affected-day continuation');
    return settleDailyDateChildren(engine, job, days, sourceJobId as number, childIds, replayRound as number, handoffGeneration);
  }
  const timezone = pinnedDailyMemoryTimezone(job.data);
  for (const day of days.slice(start, start + 8)) {
    job.signal?.throwIfAborted();
    childIds.push(await queueFanoutDailyMemory(queue, { day, ids: [], key: fanoutKey, timezone }));
  }
  const nextCursor = start + 8;
  if (nextCursor < days.length) {
    const next = await queueDailyDateBatch(queue, days, sourceJobId as number, nextCursor, childIds, 0, 0, replayRound as number, handoffGeneration, timezone);
    return { daily_memory_days_queued: days.slice(start, nextCursor), daily_memory_continuation_id: next };
  }
  return settleDailyDateChildren(engine, job, days, sourceJobId as number, childIds, replayRound as number, handoffGeneration);
}
