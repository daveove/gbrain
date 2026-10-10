/**
 * One durable daily memory from pages that already live in the brain.
 *
 * The daily maintenance job (`autopilot-global-maintenance`) calls
 * `writeDailyMemoryFromSources` once, after the long mixed phases. Sources
 * that already hold a page whose content date falls on the cycle's calendar
 * day contribute a short label and a wikilink. source_records updated that
 * same day add one summary line per source and a capped set of stable record
 * links. Message bodies stay off the note. No new connector.
 *
 * The scan is brain-wide on purpose: this runs only from the single
 * maintenance job, which is the lane that already walks every source.
 * The note itself is one row in source `dream` (non-federated). Page
 * visibility alone is not enough: remote_private_pages can opt out of
 * private filtering, and mandatory owner-aggregate authorization protects both new dream indexes
 * and historical default copies, independently of that opt-out.
 */

import { createHash } from 'node:crypto';
import { LINK_EXTRACTOR_VERSION_TS } from '../link-extraction.ts';
import { validateSlug } from '../utils.ts';
import type { BrainEngine } from '../engine.ts';
import { PageRevisionConflictError } from '../page-state/types.ts';
import { throwIfAborted } from '../abort-check.ts';
import { calendarDateInTimeZone, isValidTimeZone, resolveCycleTimeZone } from './cycle-date.ts';
import { DATE_INSTANT_PROVENANCE, isCalendarDateSpelling, parseDateLoose } from '../effective-date.ts';

export const DAILY_MEMORY_SOURCE_ID = 'dream';
export const DAILY_MEMORY_SLUG_PREFIX = 'daily-memory';
/** Keep the note a day index. The remaining pages stay on their sources. */
export const DAILY_MEMORY_PAGE_CAP = 40;
/** Per-source link cap so a chat firehose cannot fill the note. */
export const DAILY_MEMORY_RECORD_LINK_CAP = 8;

const DAILY_MEMORY_SOURCE_NAME = 'Dream cycle indexes';

function parseSourceConfig(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as Record<string, unknown>; }
    catch { return null; }
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  return null;
}

/** True when the row is already our system index (current or pre-system_index). */
function isOwnedDailyMemorySource(
  config: Record<string, unknown> | null,
  name: string | null,
): boolean {
  if (config?.system_index === true) return true;
  // Prior builds inserted federated:false under this display name before system_index.
  return config?.federated === false && name === DAILY_MEMORY_SOURCE_NAME;
}

/** Non-federated system source for brain-wide indexes. Survives visibility opt-outs. */
export async function ensureDailyMemorySource(engine: BrainEngine): Promise<void> {
  const config = JSON.stringify({ federated: false, system_index: true });
  const existing = await engine.executeRaw<{ config: unknown; name: string | null; archived: boolean }>(
    `SELECT config, name, archived FROM sources WHERE id = $1`,
    [DAILY_MEMORY_SOURCE_ID],
  );
  if (existing.length === 0) {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ($1, $2, $3::text::jsonb)`,
      [DAILY_MEMORY_SOURCE_ID, DAILY_MEMORY_SOURCE_NAME, config],
    );
    return;
  }
  const row = existing[0]!;
  const parsed = parseSourceConfig(row.config);
  if (isOwnedDailyMemorySource(parsed, row.name)) {
    if (row.archived) throw new Error(`System index '${DAILY_MEMORY_SOURCE_ID}' is archived; restore it before daily memory can write.`);
    if (parsed?.system_index === true && parsed.federated === false && row.name === DAILY_MEMORY_SOURCE_NAME) return;
    // Keep trusted-index markers sticky for our owned dream index.
    await engine.executeRaw(
      `UPDATE sources
       SET name = $2,
           config = COALESCE(config, '{}'::jsonb) || $3::text::jsonb
       WHERE id = $1`,
      [DAILY_MEMORY_SOURCE_ID, DAILY_MEMORY_SOURCE_NAME, config],
    );
    return;
  }
  throw new Error(
    `source '${DAILY_MEMORY_SOURCE_ID}' already exists and is not a GBrain system index; ` +
    `rename or remove it before daily memory can write`,
  );
}

export interface DailyMemoryWrite {
  written: boolean;
  day: string;
  slug: string;
  source_id?: string;
  needs_extract?: boolean;
  /** Exact generated day/reference targets owned by this write. */
  extract_slugs?: string[];
  pages: number;
  reason?: 'no_source_activity' | 'human_page' | 'unchanged' | 'error';
}

/** A durable note survives queue rejection; maintenance retries the failed handoff. */
export async function queueDailyMemoryExtract(engine: BrainEngine, result: DailyMemoryWrite): Promise<void> {
  if (!result.written && !result.needs_extract) return;
  const { queueDeferredStaleSweep } = await import('../deferred-stale-extract.ts');
  // Dream indexes own extraction; a human default day still wakes this source.
  const jobId = await queueDeferredStaleSweep(engine, {
    sourceId: DAILY_MEMORY_SOURCE_ID,
    commit: `daily-memory:${result.day}`,
    reason: 'daily_memory_write',
  });
  if (jobId === null) throw new Error('Daily memory extraction handoff was not accepted.');
}

export function dailyMemorySlug(day: string): string {
  return `${DAILY_MEMORY_SLUG_PREFIX}/${day}`;
}

/** True when slug+frontmatter still match an owned generated daily/source-record index. */
export function isOwnedGeneratedDailyIndex(
  slug: string,
  frontmatter: Record<string, unknown> | null | undefined,
): boolean {
  if (frontmatter?.dream_generated !== true) return false;
  if (/^daily-memory\/[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(slug)) return true;
  if (!slug.startsWith('source-records/')) return false;
  return (
    Object.hasOwn(frontmatter, 'source_record_id')
    && Object.hasOwn(frontmatter, 'source_record_type')
    && Object.hasOwn(frontmatter, 'source_record_ref')
  );
}

export interface SourcePageRow {
  source_id: string;
  slug: string;
  title: string;
  effective_date: Date | string | null;
  effective_date_source: string | null;
  frontmatter: Record<string, unknown>;
}

export function isCalendarEffectiveDate(row: SourcePageRow): boolean {
  if (row.effective_date_source === 'filename') return true;
  if (row.effective_date_source === 'fallback') return false;
  const date = new Date(row.effective_date!);
  // Old rows without provenance used UTC midnight for calendar dates.
  if (!row.effective_date_source) return date.toISOString().endsWith('T00:00:00.000Z');
  const keys = row.effective_date_source === 'created'
    ? ['created', 'created_at', 'date_created', 'date created']
    : [row.effective_date_source];
  for (const key of keys) {
    const value = row.frontmatter[key];
    if (parseDateLoose(value)?.getTime() !== date.getTime()) continue;
    if (typeof value !== 'string') return false;
    if (isCalendarDateSpelling(value)) return true;
    const instants = row.frontmatter[DATE_INSTANT_PROVENANCE];
    if (instants && typeof instants === 'object' && !Array.isArray(instants)
      && (instants as Record<string, unknown>)[key] === date.toISOString()) return false;
    // Old YAML calendar scalars were serialized as ISO UTC-midnight Dates.
    // Their original spelling is lost. Retain calendar compatibility; fresh
    // explicitly timestamped input carries the marker checked above.
    if (value === date.toISOString() && value.endsWith('T00:00:00.000Z')) return true;
    // The parser's date-only shapes. Datetimes, including UTC midnight,
    // are instants and must use the cycle timezone.
    return false;
  }
  return false;
}

function oneLine(title: string): string {
  const line = title.replace(/\s+/g, ' ').trim();
  if (!line) return 'untitled';
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

/** Keep generated index Markdown from interpreting metadata as markup/links. */
function escapeMdMeta(text: string): string {
  return oneLine(String(text ?? ''))
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

/** Preserve stored identity; targets containing wiki delimiters cannot render safely. */
function wikiLinkTarget(sourceId: string, slug: string): string | null {

  if (/[\[\]|#^]/.test(sourceId + slug)) return null;
  try { validateSlug(slug); } catch { return null; }
  return `${sourceId}:${slug}`;
}

interface SourceRecordGroup {
  source_type: string;
  total: number | string;
}

interface SourceRecordLink {
  id: string;
  source_ref: string;
  entity_id: string;
  updated_at: Date | string;
  entity_type: string;
  slug: string;
}

interface RenderInput {
  rows: SourcePageRow[];
  pageTotal: number;
  records: Array<SourceRecordGroup & { links: SourceRecordLink[] }>;
}

function renderNote(day: string, input: RenderInput): string {
  const lines: string[] = [
    `# Daily memory ${day}`,
    '',
    'Labels and links for pages already stored in the brain on this day.',
    '',
  ];
  let source = '';
  for (const row of input.rows) {
    if (row.source_id !== source) {
      source = row.source_id;
      lines.push(`## ${escapeMdMeta(source)}`, '');
    }
    // Qualify every target: this index now lives outside the default source.
    const target = wikiLinkTarget(row.source_id, row.slug);
    if (target === null) continue;
    lines.push(`- [[${target}]] — ${escapeMdMeta(row.title)}`);
  }
  if (input.rows.length) lines.push('');
  if (input.pageTotal > input.rows.length) {
    lines.push(`${input.rows.length} of ${input.pageTotal} pages are linked. The rest stay on their source pages.`, '');
  }

  if (input.pageTotal === 0 && input.records.length === 0) lines.push('No stored page or source record activity remains for this day.', '');

  if (input.records.length) {
    lines.push('## Comms', '');
    for (const group of input.records) {
      const total = Number(group.total) || group.links.length;
      lines.push(`${escapeMdMeta(group.source_type)}: ${total} ${total === 1 ? 'record' : 'records'} changed`, '');
      for (const link of group.links) {
        lines.push(`- [[${DAILY_MEMORY_SOURCE_ID}:${link.slug}]] — ${escapeMdMeta(link.entity_type || group.source_type)}`);
      }
      lines.push('');
      if (total > group.links.length) {
        lines.push(`${group.links.length} of ${total} records are linked.`, '');
      }
    }
  }

  return lines.join('\n');
}

// Shared ownership and staleness contract for historical one-shot retries.
const GENERATED_STALE_INDEXES = `FROM pages JOIN sources s ON s.id=pages.source_id
  WHERE source_id=$1 AND s.archived IS NOT TRUE AND deleted_at IS NULL
  AND (s.config @> '{"system_index":true}'::jsonb
    OR (s.name='Dream cycle indexes' AND s.config @> '{"federated":false}'::jsonb))
  AND frontmatter @> '{"dream_generated":true}'::jsonb
  AND (slug ~ '^daily-memory/[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR (slug LIKE 'source-records/%'
    AND frontmatter ?& ARRAY['source_record_id','source_record_type','source_record_ref']))
  AND (links_extracted_at IS NULL OR links_extracted_at < $2::timestamptz
    OR updated_at > links_extracted_at)`;

async function dreamIndexesNeedExtract(engine: BrainEngine): Promise<boolean> {
  const [historical] = await engine.executeRaw<{ needed: boolean }>(
    `SELECT EXISTS (SELECT 1 ${GENERATED_STALE_INDEXES}) AS needed`,
    [DAILY_MEMORY_SOURCE_ID, LINK_EXTRACTOR_VERSION_TS]);
  return historical.needed;
}

/** Metadata-only list of stale generated indexes, excluding human pages. */
export async function dailyMemoryExtractTargets(engine: BrainEngine): Promise<string[]> {
  const rows = await engine.executeRaw<{ slug: string }>(
    `SELECT slug ${GENERATED_STALE_INDEXES} ORDER BY slug`,
    [DAILY_MEMORY_SOURCE_ID, LINK_EXTRACTOR_VERSION_TS]);
  return rows.map(row => row.slug);
}

/**
 * Write `daily-memory/YYYY-MM-DD` when any source already has a page for the
 * cycle day. A human-owned page at that slug is left in place, including one
 * that is soft-deleted: `getPage` hides those rows, and `putPage` clears
 * `deleted_at` on conflict, which would resurrect the page. A soft-deleted
 * dream note (`dream_generated: true`) may still refresh. Concurrent writers
 * for the same day capture the note revision before scanning and CAS the
 * put; a conflict rescans so a stale snapshot cannot overwrite a newer index.
 * Errors are logged and swallowed so a note failure does not cancel the rest
 * of the maintenance job; an abort still propagates.
 */
export async function writeDailyMemoryFromSources(
  engine: BrainEngine,
  opts: { signal?: AbortSignal; now?: () => Date; date?: string; timezone?: string } = {},
): Promise<DailyMemoryWrite> {
  throwIfAborted(opts.signal, '[dream] daily memory');
  const now = opts.now ?? (() => new Date());
  let day = '';
  let slug = '';
  try {
    // Launcher may pass the same zone used for day selection (GBRAIN_DAILY_MEMORY_TZ).
    const override = opts.timezone?.trim();
    if (override && !isValidTimeZone(override)) {
      throw new Error(`invalid timezone "${override}"`);
    }
    const zone = override || await resolveCycleTimeZone(engine);
    // An explicit day is that calendar day in every zone. Implicit day must use
    // the same zone as page filters (override or resolved), not a second reload.
    day = opts.date || calendarDateInTimeZone(now(), zone);
    slug = dailyMemorySlug(day);
    throwIfAborted(opts.signal, '[dream] daily memory');
    // A pre-existing human default index remains authoritative, even when deleted.
    const legacy = await engine.getPage(slug, { sourceId: 'default', includeDeleted: true });
    if (legacy && legacy.frontmatter.dream_generated !== true) {
      // Keep the human default index; still wake stale dream extraction work.
      return { written: false, day, slug, source_id: 'default', pages: 0, reason: 'human_page',
        needs_extract: await dreamIndexesNeedExtract(engine) };
    }
    await ensureDailyMemorySource(engine);

    const maxAttempts = 8;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      throwIfAborted(opts.signal, '[dream] daily memory');
      // Bound the write to the revision observed before the source scan so a
      // concurrent same-day writer that commits first forces a rescan.
      const snapshot = await engine.readPageSnapshot(slug, {
        sourceId: DAILY_MEMORY_SOURCE_ID,
        includeDeleted: true,
      });
      const existing = snapshot?.page ?? null;
      if (existing && existing.frontmatter?.dream_generated !== true) {
        return { written: false, day, slug, source_id: DAILY_MEMORY_SOURCE_ID, pages: 0, reason: 'human_page',
          needs_extract: await dreamIndexesNeedExtract(engine) };
      }

      const rows: SourcePageRow[] = [];
      let pageTotal = 0;
      let afterSource = '';
      let afterSlug = '';
      for (;;) {
        throwIfAborted(opts.signal, '[dream] daily memory');
        const candidates = await engine.executeRaw<SourcePageRow & { utc_day: string; local_day: string }>(
          `SELECT source_id, slug, title, effective_date, effective_date_source,
             jsonb_build_object(
               COALESCE(effective_date_source, 'date'), frontmatter->COALESCE(effective_date_source, 'date'),
               'created', frontmatter->'created', 'created_at', frontmatter->'created_at',
               'date_created', frontmatter->'date_created', 'date created', frontmatter->'date created',
               '${DATE_INSTANT_PROVENANCE}', jsonb_build_object(
                 COALESCE(effective_date_source, 'date'), frontmatter->'${DATE_INSTANT_PROVENANCE}'->COALESCE(effective_date_source, 'date'),
                 'created', frontmatter->'${DATE_INSTANT_PROVENANCE}'->'created',
                 'created_at', frontmatter->'${DATE_INSTANT_PROVENANCE}'->'created_at',
                 'date_created', frontmatter->'${DATE_INSTANT_PROVENANCE}'->'date_created',
                 'date created', frontmatter->'${DATE_INSTANT_PROVENANCE}'->'date created')) AS frontmatter,
             to_char(effective_date AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS utc_day,
             to_char(COALESCE(effective_date, updated_at) AT TIME ZONE $1, 'YYYY-MM-DD') AS local_day
           FROM pages JOIN sources s ON s.id=pages.source_id AND s.archived IS NOT TRUE
           WHERE deleted_at IS NULL
             AND COALESCE(frontmatter->>'dream_generated', '') IS DISTINCT FROM 'true'
             AND NOT (source_id = $4 AND slug = $3)
             -- Index range (pages_coalesce_date_idx) wide enough for any zone;
             -- the exact day test below still decides membership.
             AND COALESCE(effective_date, updated_at) >= $2::date - 2
             AND COALESCE(effective_date, updated_at) < $2::date + 3
             AND ((effective_date AT TIME ZONE 'UTC')::date = $2::date
               OR (COALESCE(effective_date, updated_at) AT TIME ZONE $1)::date = $2::date)
             AND (source_id, slug) > ($5, $6)
           ORDER BY source_id, slug LIMIT $7`,
          [zone, day, slug, DAILY_MEMORY_SOURCE_ID, afterSource, afterSlug, DAILY_MEMORY_PAGE_CAP],
        );
        // Count every matching calendar/instant day without retaining a whole-day snapshot.
        for (const row of candidates) {
          if ((row.effective_date && isCalendarEffectiveDate(row) ? row.utc_day : row.local_day) !== day) continue;
          pageTotal++;
          if (rows.length < DAILY_MEMORY_PAGE_CAP && wikiLinkTarget(row.source_id, row.slug) !== null) rows.push(row);
        }
        if (candidates.length < DAILY_MEMORY_PAGE_CAP) break;
        const last = candidates[candidates.length - 1];
        afterSource = last.source_id;
        afterSlug = last.slug;
      }
      const records = await loadSourceRecordGroups(engine, zone, day);

      if (pageTotal === 0 && records.length === 0 && (!existing || existing.deleted_at)) {
        return { written: false, day, slug, source_id: DAILY_MEMORY_SOURCE_ID,
          needs_extract: await dreamIndexesNeedExtract(engine), pages: 0, reason: 'no_source_activity' };
      }

      let recordsWrote = false;
      for (const group of records) {
        const available: SourceRecordLink[] = [];
        for (const link of group.links) {
          throwIfAborted(opts.signal, '[dream] daily memory');
          const put = await putSourceRecordIndex(engine, group.source_type, link);
          if (put.available) available.push(link);
          if (put.wrote) recordsWrote = true;
        }
        group.links = available;
      }

      const title = `Daily memory ${day}`;
      const compiled_truth = renderNote(day, { rows, pageTotal, records });
      const dailyUnchanged = Boolean(
        existing
        && !existing.deleted_at
        && existing.frontmatter?.dream_generated === true
        && existing.title === title
        && existing.compiled_truth === compiled_truth
        && existing.frontmatter?.dream_cycle_date === day
        && existing.frontmatter?.visibility === 'private',
      );
      if (!dailyUnchanged) {
        const writeOpts = snapshot
          ? { sourceId: DAILY_MEMORY_SOURCE_ID, expectedRevision: snapshot.revision }
          : { sourceId: DAILY_MEMORY_SOURCE_ID, force: false as const };
        try {
          await engine.putPage(slug, {
            type: 'note',
            title,
            compiled_truth,
            timeline: '',
            frontmatter: {
              dream_generated: true,
              visibility: 'private',
              dream_cycle_date: day,
              dream_created_cycle_date: day,
              raw_trace_exempt: true,
              raw_trace_exempt_reason: 'daily memory index; source pages keep their own traces',
            },
          }, writeOpts);
        } catch (err) {
          if (err instanceof PageRevisionConflictError && attempt + 1 < maxAttempts) continue;
          throw err;
        }
      }

      const targets = [slug, ...records.flatMap(group => group.links.map(link => link.slug))];
      const [readiness] = await engine.executeRaw<{ needed: boolean; extract_slugs: string[] }>(
        `SELECT COALESCE(bool_or(links_extracted_at IS NULL OR links_extracted_at < $3::timestamptz
            OR updated_at > links_extracted_at), false) AS needed,
            COALESCE(array_agg(slug ORDER BY slug), '{}'::text[]) AS extract_slugs
          FROM pages WHERE source_id=$1 AND slug=ANY($2::text[]) AND deleted_at IS NULL
            AND frontmatter @> '{"dream_generated":true}'::jsonb`,
        [DAILY_MEMORY_SOURCE_ID, targets, LINK_EXTRACTOR_VERSION_TS],
      );
      const needs_extract = readiness.needed;

      if (dailyUnchanged && !recordsWrote) {
        return { written: false, day, slug, source_id: DAILY_MEMORY_SOURCE_ID, needs_extract, extract_slugs: readiness.extract_slugs, pages: rows.length, reason: 'unchanged' };
      }
      return { written: true, day, slug, source_id: DAILY_MEMORY_SOURCE_ID, needs_extract, extract_slugs: readiness.extract_slugs, pages: rows.length };
    }
    throw new Error('Daily memory write exhausted revision retries');
  } catch (err) {
    throwIfAborted(opts.signal, '[dream] daily memory');
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[autopilot-global-maintenance] daily memory skipped: ${message}`);
    return { written: false, day, slug, pages: 0, reason: 'error' };
  }
}


async function loadSourceRecordGroups(
  engine: BrainEngine,
  zone: string,
  day: string,
): Promise<Array<SourceRecordGroup & { links: SourceRecordLink[] }>> {
  const present = await engine.executeRaw<{ ready: boolean | null }>(
    `SELECT to_regclass('public.source_records') IS NOT NULL AS ready`,
    [],
  );
  if (!present[0]?.ready) return [];
  const groups = await engine.executeRaw<SourceRecordGroup>(
    `SELECT source_type, COUNT(*)::int AS total
     FROM source_records
     WHERE updated_at >= ($2::date::timestamp AT TIME ZONE $1)
       AND updated_at < (($2::date + 1)::timestamp AT TIME ZONE $1)
     GROUP BY source_type
     ORDER BY COUNT(*) DESC, source_type`,
    [zone, day],
  );
  const linked: Array<SourceRecordGroup & { links: SourceRecordLink[] }> = [];
  for (const group of groups) {
    const links = await engine.executeRaw<SourceRecordLink>(
      `SELECT id, source_ref, entity_type, entity_id, updated_at
       FROM public.source_records
       WHERE source_type = $1
         AND updated_at >= ($3::date::timestamp AT TIME ZONE $2)
         AND updated_at < (($3::date + 1)::timestamp AT TIME ZONE $2)
       ORDER BY updated_at DESC, source_ref
       LIMIT $4`,
      [group.source_type, zone, day, DAILY_MEMORY_RECORD_LINK_CAP],
    );
    for (const link of links) {
      const hash = createHash('sha256').update(`${group.source_type}\0${link.source_ref}`).digest('hex');
      const type = encodeURIComponent(group.source_type);
      try { link.slug = validateSlug(`source-records/${type}/${hash}`); }
      catch {
        const typeHash = createHash('sha256').update(group.source_type).digest('hex');
        link.slug = validateSlug(`source-records/type-${typeHash}/${hash}`);
      }
    }
    linked.push({ ...group, links });
  }
  return linked;
}

/** Materialize only record identity so every daily wikilink can be opened. */
async function putSourceRecordIndex(
  engine: BrainEngine,
  sourceType: string,
  record: SourceRecordLink,
): Promise<{ available: boolean; wrote: boolean }> {
  const updatedAt = new Date(record.updated_at).toISOString();
  const title = `${escapeMdMeta(sourceType)} ${escapeMdMeta(record.entity_type)} record`;
  const compiled_truth = [
    `Source: ${escapeMdMeta(sourceType)}`,
    `Record ID: ${escapeMdMeta(record.id)}`,
    `Source reference: ${escapeMdMeta(record.source_ref)}`,
    `Entity type: ${escapeMdMeta(record.entity_type)}`,
    `Entity ID: ${escapeMdMeta(record.entity_id)}`,
    `Updated: ${updatedAt}`,
    '',
  ].join('\n');
  const maxAttempts = 8;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Bound the write to the revision observed before put so a concurrent
    // same-slug writer that commits first forces a retry instead of a stale overwrite.
    const snapshot = await engine.readPageSnapshot(record.slug, {
      sourceId: DAILY_MEMORY_SOURCE_ID,
      includeDeleted: true,
    });
    const existing = snapshot?.page ?? null;
    if (existing && existing.frontmatter?.dream_generated !== true) {
      return { available: !existing.deleted_at, wrote: false };
    }
    const existingUpdated = existing?.frontmatter?.source_record_updated_at;
    if (
      existing
      && !existing.deleted_at
      && existing.frontmatter?.dream_generated === true
      && existing.frontmatter?.source_record_type === sourceType
      && existing.frontmatter?.source_record_ref === record.source_ref
      && typeof existingUpdated === 'string'
      && existingUpdated > updatedAt
    ) {
      // Prefer newer metadata on this stable slug/ref even when the mutable
      // source_record_id was replaced by a concurrent writer.
      return { available: true, wrote: false };
    }
    if (
      existing
      && !existing.deleted_at
      && existing.title === title
      && existing.compiled_truth === compiled_truth
      && existing.frontmatter?.dream_generated === true
      && existing.frontmatter?.visibility === 'private'
      && existing.frontmatter?.source_record_type === sourceType
      && existing.frontmatter?.source_record_ref === record.source_ref
      && existing.frontmatter?.source_record_id === record.id
      && existing.frontmatter?.source_record_updated_at === updatedAt
    ) {
      return { available: true, wrote: false };
    }
    const writeOpts = snapshot
      ? { sourceId: DAILY_MEMORY_SOURCE_ID, expectedRevision: snapshot.revision }
      : { sourceId: DAILY_MEMORY_SOURCE_ID, force: false as const };
    try {
      await engine.putPage(record.slug, {
        type: 'note',
        title,
        compiled_truth,
        timeline: '',
        frontmatter: {
          dream_generated: true,
          visibility: 'private',
          source_record_id: record.id,
          source_record_type: sourceType,
          source_record_ref: record.source_ref,
          source_record_updated_at: updatedAt,
          raw_trace_exempt: true,
          raw_trace_exempt_reason: 'source record metadata index; payload stays in source_records',
        },
      }, writeOpts);
      return { available: true, wrote: true };
    } catch (err) {
      if (err instanceof PageRevisionConflictError && attempt + 1 < maxAttempts) continue;
      throw err;
    }
  }
  throw new Error('Source record index write exhausted revision retries');
}
