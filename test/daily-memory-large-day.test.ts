/**
 * DAV-7111: a day with tens of thousands of pages must not scale the daily
 * memory job's round trips with the page count. The day 2026-09-03 held 81 792
 * pages (one Notion export source); the writer paged the whole day 40 rows at a
 * time, about 2 000 queries at 1.2 s each, and the 20-minute job timeout fired
 * on every attempt.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, spyOn } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  dailyMemorySlug, DAILY_MEMORY_PAGE_CAP, DAILY_MEMORY_SOURCE_ID, ensureDailyMemorySource, writeDailyMemoryFromSources,
} from '../src/core/cycle/daily-memory.ts';

const DAY = '2026-09-03';
const ZONE = 'Asia/Manila';
const BULK_PAGES = 600;
// Zone day 2026-09-03 (Manila): 17:30Z on the 2nd is 01:30 on the 3rd.
const INSTANTS_IN_DAY = ['2026-09-02T17:30:00Z', '2026-09-02T18:00:00Z', '2026-09-02T23:59:00Z'];
// 17:30Z on the 3rd is 01:30 on the 4th: UTC day matches, zone day does not.
const INSTANTS_OUT_OF_DAY = ['2026-09-03T17:30:00Z', '2026-09-03T20:00:00Z'];

describe('daily memory on a day with many pages', () => {
  let engine: PGLiteEngine;
  let schemaVersion: string | null;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); schemaVersion = await engine.getConfig('version'); }, 180_000);
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => { await resetPgliteState(engine); if (schemaVersion) await engine.setConfig('version', schemaVersion); await ensureDailyMemorySource(engine); }, 120_000);

  async function seedBigDay(): Promise<void> {
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('notion', 'notion')`);
    // One import source dates every page to the calendar day, as the Notion export did.
    await engine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title, compiled_truth, effective_date, effective_date_source)
       SELECT 'notion', 'export/page-' || lpad(g::text, 5, '0'), 'note', 'Export page ' || g, 'body',
         '${DAY}T00:00:00Z'::timestamptz, 'filename'
       FROM generate_series(1, ${BULK_PAGES}) g`,
    );
    for (const [group, instants] of [['in', INSTANTS_IN_DAY], ['out', INSTANTS_OUT_OF_DAY]] as const) {
      for (const [i, iso] of instants.entries()) {
        await engine.putPage(`instants/${group}-${i}`, {
          type: 'note', title: `Instant ${group} ${i}`, compiled_truth: 'body', frontmatter: { date: iso },
          effective_date: new Date(iso), effective_date_source: 'date',
        }, { sourceId: 'notion' });
      }
    }
  }

  test('round trips stay constant while the page total stays exact', async () => {
    await seedBigDay();
    const spy = spyOn(engine, 'executeRaw');
    const result = await writeDailyMemoryFromSources(engine, { date: DAY, timezone: ZONE });
    // Candidate-page queries are the ones that carry the day-range predicate.
    const pageQueries = spy.mock.calls.filter(([sql]) => String(sql).includes('$2::date - 2')).length;
    spy.mockRestore();

    expect(result.reason).toBeUndefined();
    expect(result.written).toBe(true);
    expect(result.pages).toBe(DAILY_MEMORY_PAGE_CAP);
    // Before the fix: one query per 40 pages, so 16 for these 605 pages.
    expect(pageQueries).toBeLessThanOrEqual(4);

    const note = await engine.getPage(dailyMemorySlug(DAY), { sourceId: DAILY_MEMORY_SOURCE_ID });
    const members = BULK_PAGES + INSTANTS_IN_DAY.length;
    expect(note!.compiled_truth).toContain(`${DAILY_MEMORY_PAGE_CAP} of ${members} pages are linked.`);
    // The list keeps source/slug order: export pages sort before instants and fill it.
    expect(note!.compiled_truth).toContain('[[notion:export/page-00001]]');
    expect(note!.compiled_truth).toContain(`[[notion:export/page-${String(DAILY_MEMORY_PAGE_CAP).padStart(5, '0')}]]`);
    expect(note!.compiled_truth).not.toContain('instants/out-0');
  }, 60_000);

  test('a day under the cap lists every page with no overflow line', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('notion', 'notion')`);
    for (const [i, iso] of INSTANTS_IN_DAY.entries()) {
      await engine.putPage(`instants/in-${i}`, {
        type: 'note', title: `Instant ${i}`, compiled_truth: 'body', frontmatter: { date: iso },
        effective_date: new Date(iso), effective_date_source: 'date',
      }, { sourceId: 'notion' });
    }
    await engine.putPage('instants/out-0', {
      type: 'note', title: 'Instant out', compiled_truth: 'body', frontmatter: { date: INSTANTS_OUT_OF_DAY[0] },
      effective_date: new Date(INSTANTS_OUT_OF_DAY[0]!), effective_date_source: 'date',
    }, { sourceId: 'notion' });
    const result = await writeDailyMemoryFromSources(engine, { date: DAY, timezone: ZONE });
    expect(result.pages).toBe(INSTANTS_IN_DAY.length);
    const note = await engine.getPage(dailyMemorySlug(DAY), { sourceId: DAILY_MEMORY_SOURCE_ID });
    expect(note!.compiled_truth).not.toContain('pages are linked');
    expect(note!.compiled_truth).not.toContain('instants/out-0');
  }, 60_000);
});
