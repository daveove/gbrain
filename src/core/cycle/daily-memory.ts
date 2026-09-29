/**
 * One durable daily memory from pages that already live in the brain.
 *
 * The daily maintenance job (`autopilot-global-maintenance`) calls
 * `writeDailyMemoryFromSources` once, before the long mixed phases. Sources
 * that already hold a page whose content date falls on the cycle's calendar
 * day contribute a short label and a wikilink. No new connector, no transcript
 * body, no phase-scope change.
 *
 * The scan is brain-wide on purpose: this runs only from the single
 * maintenance job, which is the lane that already walks every source.
 * The note itself is one row in source `default`.
 */

import type { BrainEngine } from '../engine.ts';
import { throwIfAborted } from '../abort-check.ts';
import { resolveCycleDate, resolveCycleTimeZone } from './cycle-date.ts';

export const DAILY_MEMORY_SOURCE_ID = 'default';
export const DAILY_MEMORY_SLUG_PREFIX = 'daily-memory';
/** Keep the note a day index. The remaining pages stay on their sources. */
export const DAILY_MEMORY_PAGE_CAP = 40;

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

function renderNote(day: string, rows: SourcePageRow[], total: number): string {
  const lines: string[] = [
    `# Daily memory ${day}`,
    '',
    'Labels and links for pages already stored in the brain on this day.',
    '',
  ];
  let source = '';
  for (const row of rows) {
    if (row.source_id !== source) {
      source = row.source_id;
      lines.push(`## ${source}`, '');
    }
    lines.push(`- [[${row.slug}]] — ${oneLine(row.title)}`);
  }
  lines.push('');
  if (total > rows.length) {
    lines.push(`${rows.length} of ${total} pages are linked. The rest stay on their source pages.`, '');
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
  opts: { signal?: AbortSignal; now?: () => Date } = {},
): Promise<DailyMemoryWrite> {
  throwIfAborted(opts.signal, '[dream] daily memory');
  const now = opts.now ?? (() => new Date());
  let day = '';
  let slug = '';
  try {
    const zone = await resolveCycleTimeZone(engine);
    day = await resolveCycleDate(engine, { now });
    slug = dailyMemorySlug(day);
    throwIfAborted(opts.signal, '[dream] daily memory');

    const rows = await engine.executeRaw<SourcePageRow>(
      `SELECT source_id, slug, title, (COUNT(*) OVER ())::int AS total
       FROM pages
       WHERE deleted_at IS NULL
         AND COALESCE(frontmatter->>'dream_generated', '') IS DISTINCT FROM 'true'
         AND NOT (source_id = $4 AND slug = $3)
         AND (COALESCE(effective_date, updated_at) AT TIME ZONE $1)::date = $2::date
       ORDER BY source_id, slug
       LIMIT $5`,
      [zone, day, slug, DAILY_MEMORY_SOURCE_ID, DAILY_MEMORY_PAGE_CAP],
    );
    if (rows.length === 0) {
      return { written: false, day, slug, pages: 0, reason: 'no_source_activity' };
    }

    const existing = await engine.getPage(slug, {
      sourceId: DAILY_MEMORY_SOURCE_ID,
      includeDeleted: true,
    });
    if (existing && existing.frontmatter?.dream_generated !== true) {
      return { written: false, day, slug, pages: rows.length, reason: 'human_page' };
    }

    const total = Number(rows[0].total) || rows.length;
    await engine.putPage(slug, {
      type: 'note',
      title: `Daily memory ${day}`,
      compiled_truth: renderNote(day, rows, total),
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
