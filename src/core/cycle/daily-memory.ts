/**
 * One durable daily memory from pages that already live in the brain.
 *
 * The daily maintenance job (`autopilot-global-maintenance`) calls
 * `writeDailyMemoryFromSources` once, before the long mixed phases. Sources
 * that already hold a page whose content date falls on the cycle's calendar
 * day contribute a short label and a wikilink. source_records updated that
 * same day add one summary line per source and a capped set of stable record
 * links. Message bodies stay off the note. No new connector.
 *
 * The scan is brain-wide on purpose: this runs only from the single
 * maintenance job, which is the lane that already walks every source.
 * The note itself is one row in source `default`.
 */

import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { throwIfAborted } from '../abort-check.ts';
import { resolveCycleDate, resolveCycleTimeZone } from './cycle-date.ts';

export const DAILY_MEMORY_SOURCE_ID = 'default';
export const DAILY_MEMORY_SLUG_PREFIX = 'daily-memory';
/** Keep the note a day index. The remaining pages stay on their sources. */
export const DAILY_MEMORY_PAGE_CAP = 40;
/** Per-source link cap so a chat firehose cannot fill the note. */
export const DAILY_MEMORY_RECORD_LINK_CAP = 8;

export interface DailyMemoryWrite {
  written: boolean;
  day: string;
  slug: string;
  pages: number;
  reason?: 'no_source_activity' | 'human_page' | 'error';
}

export function dailyMemorySlug(day: string): string {
  return `${DAILY_MEMORY_SLUG_PREFIX}/${day}`;
}

interface SourcePageRow {
  source_id: string;
  slug: string;
  title: string;
  total: number | string;
}

function oneLine(title: string): string {
  const line = title.replace(/\s+/g, ' ').trim();
  if (!line) return 'untitled';
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
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
      lines.push(`## ${source}`, '');
    }
    lines.push(`- [[${row.slug}]] — ${oneLine(row.title)}`);
  }
  if (input.rows.length) lines.push('');
  if (input.pageTotal > input.rows.length) {
    lines.push(`${input.rows.length} of ${input.pageTotal} pages are linked. The rest stay on their source pages.`, '');
  }

  if (input.records.length) {
    lines.push('## Comms', '');
    for (const group of input.records) {
      const total = Number(group.total) || group.links.length;
      lines.push(`${group.source_type}: ${total} ${total === 1 ? 'record' : 'records'} changed`, '');
      for (const link of group.links) {
        lines.push(`- [[${link.slug}]] — ${oneLine(link.entity_type || group.source_type)}`);
      }
      lines.push('');
      if (total > group.links.length) {
        lines.push(`${group.links.length} of ${total} records are linked.`, '');
      }
    }
  }

  return lines.join('\n');
}

/**
 * Write `daily-memory/YYYY-MM-DD` when any source already has a page for the
 * cycle day. A human-owned page at that slug is left in place, including one
 * that is soft-deleted: `getPage` hides those rows, and `putPage` clears
 * `deleted_at` on conflict, which would resurrect the page. A soft-deleted
 * dream note (`dream_generated: true`) may still refresh. Errors are logged
 * and swallowed so a note failure does not cancel the rest of the maintenance
 * job; an abort still propagates.
 */
export async function writeDailyMemoryFromSources(
  engine: BrainEngine,
  opts: { signal?: AbortSignal; now?: () => Date; date?: string } = {},
): Promise<DailyMemoryWrite> {
  throwIfAborted(opts.signal, '[dream] daily memory');
  const now = opts.now ?? (() => new Date());
  let day = '';
  let slug = '';
  try {
    const zone = await resolveCycleTimeZone(engine);
    // An explicit day is that calendar day in every zone. Timezone projection
    // applies only when the day is derived from the clock.
    day = await resolveCycleDate(engine, { now, explicitDate: opts.date });
    slug = dailyMemorySlug(day);
    throwIfAborted(opts.signal, '[dream] daily memory');

    const rows = await engine.executeRaw<SourcePageRow>(
      `SELECT source_id, slug, title, (COUNT(*) OVER ())::int AS total
       FROM pages
       WHERE deleted_at IS NULL
         AND COALESCE(frontmatter->>'dream_generated', '') IS DISTINCT FROM 'true'
         AND NOT (source_id = $4 AND slug = $3)
         -- A filename or frontmatter date is stored as UTC midnight. Converting
         -- that instant into a zone west of UTC lands it on the previous local
         -- day. Compare the stored calendar date, and apply the cycle zone
         -- only when the page has no effective_date and we fall back to updated_at.
         AND COALESCE(
           (effective_date AT TIME ZONE 'UTC')::date,
           (updated_at AT TIME ZONE $1)::date
         ) = $2::date
       ORDER BY source_id, slug
       LIMIT $5`,
      [zone, day, slug, DAILY_MEMORY_SOURCE_ID, DAILY_MEMORY_PAGE_CAP],
    );
    const records = await loadSourceRecordGroups(engine, zone, day);
    if (rows.length === 0 && records.length === 0) {
      return { written: false, day, slug, pages: 0, reason: 'no_source_activity' };
    }

    const existing = await engine.getPage(slug, {
      sourceId: DAILY_MEMORY_SOURCE_ID,
      includeDeleted: true,
    });
    if (existing && existing.frontmatter?.dream_generated !== true) {
      return { written: false, day, slug, pages: rows.length, reason: 'human_page' };
    }

    for (const group of records) {
      const available: SourceRecordLink[] = [];
      for (const link of group.links) {
        throwIfAborted(opts.signal, '[dream] daily memory');
        if (await putSourceRecordIndex(engine, group.source_type, link)) available.push(link);
      }
      group.links = available;
    }

    const pageTotal = rows.length ? (Number(rows[0].total) || rows.length) : 0;
    await engine.putPage(slug, {
      type: 'note',
      title: `Daily memory ${day}`,
      compiled_truth: renderNote(day, { rows, pageTotal, records }),
      timeline: '',
      frontmatter: {
        dream_generated: true,
        dream_cycle_date: day,
        dream_created_cycle_date: day,
        raw_trace_exempt: true,
        raw_trace_exempt_reason: 'daily memory index; source pages keep their own traces',
      },
    }, { sourceId: DAILY_MEMORY_SOURCE_ID });

    return { written: true, day, slug, pages: rows.length };
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
      link.slug = `source-records/${encodeURIComponent(group.source_type)}/${hash}`;
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
): Promise<boolean> {
  const existing = await engine.getPage(record.slug, {
    sourceId: DAILY_MEMORY_SOURCE_ID,
    includeDeleted: true,
  });
  if (existing && existing.frontmatter?.dream_generated !== true) return !existing.deleted_at;
  const updatedAt = new Date(record.updated_at).toISOString();
  await engine.putPage(record.slug, {
    type: 'note',
    title: `${oneLine(sourceType)} ${oneLine(record.entity_type)} record`,
    compiled_truth: [
      `Source: ${oneLine(sourceType)}`,
      `Record ID: ${oneLine(record.id)}`,
      `Source reference: ${oneLine(record.source_ref)}`,
      `Entity type: ${oneLine(record.entity_type)}`,
      `Entity ID: ${oneLine(record.entity_id)}`,
      `Updated: ${updatedAt}`,
      '',
    ].join('\n'),
    timeline: '',
    frontmatter: {
      dream_generated: true,
      source_record_id: record.id,
      source_record_type: sourceType,
      source_record_ref: record.source_ref,
      source_record_updated_at: updatedAt,
      raw_trace_exempt: true,
      raw_trace_exempt_reason: 'source record metadata index; payload stays in source_records',
    },
  }, { sourceId: DAILY_MEMORY_SOURCE_ID });
  return true;
}
