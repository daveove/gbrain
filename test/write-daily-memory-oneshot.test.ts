import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { DAILY_MEMORY_SOURCE_ID, ensureDailyMemorySource, writeDailyMemoryFromSources } from '../src/core/cycle/daily-memory.ts';
import { extractStaleFromDB } from '../src/commands/extract.ts';
import { extractOneShotDailyMemory, runOneShotDailyMemoryWrite } from '../scripts/write-daily-memory.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine, version: string | null;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  version = await engine.getConfig('version');
}, 60_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  if (version) await engine.setConfig('version', version);
  await engine.setConfig('cycle.timezone', 'Asia/Manila');
});

const noExtract: typeof extractStaleFromDB = async () => ({
  linksCreated: 0, timelineCreated: 0, pagesProcessed: 0, staleRemaining: 0,
});

const seed = async (day = '2026-09-30', slug = 'notes/oneshot-day') => {
  await engine.putPage(slug, {
    type: 'note', title: 'One-shot fixture', compiled_truth: 'Synthetic fixture',
    frontmatter: { date: day },
  });
  await engine.executeRaw(
    "UPDATE pages SET effective_date=$1::date::timestamptz,effective_date_source='date' WHERE source_id='default' AND slug=$2",
    [day, slug],
  );
};

test('one-shot writer runs exact-target extract in-process and queues no Minions job', async () => {
  await seed();
  const calls: Array<Parameters<typeof extractStaleFromDB>[1]> = [];
  const controller = new AbortController();
  const result = await runOneShotDailyMemoryWrite(engine, '2026-09-30', {
    signal: controller.signal,
    extract: async (_engine, opts) => { calls.push(opts); return noExtract(_engine, opts); },
  });
  expect(result.written || result.needs_extract).toBe(true);
  expect((await engine.getPage(result.slug, { sourceId: DAILY_MEMORY_SOURCE_ID }))?.compiled_truth)
    .toContain('[[default:notes/oneshot-day]]');
  expect(calls).toHaveLength(1);
  expect(calls[0]).toEqual({
    dryRun: false, jsonMode: true, quiet: true,
    sourceIdFilter: DAILY_MEMORY_SOURCE_ID, slugs: [result.slug], catchUp: false, timeBudgetMs: 60_000,
    signal: controller.signal,
  });
  expect(await engine.executeRaw('SELECT id FROM minion_jobs')).toHaveLength(0);
});

test('one-shot writer skips extract when the day needs no graph work', async () => {
  let called = 0;
  const result = await runOneShotDailyMemoryWrite(engine, '2026-09-30', {
    extract: async () => { called++; return noExtract(engine, {} as never); },
  });
  expect(result.reason).toBe('no_source_activity');
  expect(result.written).toBe(false);
  expect(result.needs_extract).toBeFalsy();
  expect(called).toBe(0);
  expect(await engine.executeRaw('SELECT id FROM minion_jobs')).toHaveLength(0);
});

test('one-shot extract retries when selected daily indexes remain stale', async () => {
  await seed();
  await expect(runOneShotDailyMemoryWrite(engine, '2026-09-30', {
    extract: async () => ({ linksCreated: 0, timelineCreated: 0, pagesProcessed: 0, staleRemaining: 2 }),
  })).rejects.toThrow('Daily memory extraction needs retry: 2 selected daily-index pages remain');
  expect((await engine.getPage('daily-memory/2026-09-30', { sourceId: DAILY_MEMORY_SOURCE_ID }))?.compiled_truth)
    .toContain('[[default:notes/oneshot-day]]');
  expect(await engine.executeRaw('SELECT id FROM minion_jobs')).toHaveLength(0);
});

test('extractOneShotDailyMemory is a no-op without written or needs_extract', async () => {
  let called = 0;
  await extractOneShotDailyMemory(engine, {
    written: false, day: '2026-09-30', slug: 'daily-memory/2026-09-30', pages: 0,
  }, { extract: async () => { called++; return noExtract(engine, {} as never); } });
  expect(called).toBe(0);
});

test('one-shot writer drains queued non-current autopilot-daily-memory jobs', async () => {
  await seed('2026-09-30', 'notes/oneshot-current');
  await seed('2026-09-28', 'notes/oneshot-historical');
  const queue = new MinionQueue(engine);
  const queued = await queue.add('autopilot-daily-memory', {
    daily_memory_only: true,
    daily_memory_date: '2026-09-28',
    source_cycle_job_ids: [],
  });
  const extractedDays: string[] = [];
  const result = await runOneShotDailyMemoryWrite(engine, '2026-09-30', {
    extract: async (_engine, opts) => {
      // Capture which daily-memory page extract saw by reading latest dream page state after writes.
      extractedDays.push('extract');
      return noExtract(_engine, opts);
    },
  });
  expect(result.day).toBe('2026-09-30');
  expect((await engine.getPage('daily-memory/2026-09-30', { sourceId: DAILY_MEMORY_SOURCE_ID }))?.compiled_truth)
    .toContain('[[default:notes/oneshot-current]]');
  expect((await engine.getPage('daily-memory/2026-09-28', { sourceId: DAILY_MEMORY_SOURCE_ID }))?.compiled_truth)
    .toContain('[[default:notes/oneshot-historical]]');
  expect((await queue.getJob(queued.id))?.status).toBe('completed');
  expect(await engine.executeRaw(
    "SELECT id FROM minion_jobs WHERE name='autopilot-daily-memory' AND status NOT IN ('completed','delayed')",
  )).toHaveLength(0);
  // Current-day write + drained historical day each extract when written.
  expect(extractedDays.length).toBeGreaterThanOrEqual(2);
});

test('one-shot writer uses GBRAIN_DAILY_MEMORY_ZONE for instant page filters', async () => {
  await engine.setConfig('cycle.timezone', 'UTC');
  // 06:00Z on 2026-09-30 is still 2026-09-29 evening in America/Los_Angeles.
  await engine.putPage('notes/boundary', {
    type: 'note', title: 'Boundary fixture', compiled_truth: 'Synthetic boundary',
    frontmatter: { created: '2026-09-30T06:00:00.000Z' },
  });
  await engine.executeRaw(
    "UPDATE pages SET effective_date='2026-09-30T06:00:00Z'::timestamptz,effective_date_source='created' WHERE source_id='default' AND slug='notes/boundary'",
  );
  await withEnv({ GBRAIN_DAILY_MEMORY_ZONE: 'America/Los_Angeles' }, async () => {
    const result = await runOneShotDailyMemoryWrite(engine, '2026-09-29', { extract: noExtract });
    expect(result.written).toBe(true);
    expect((await engine.getPage(result.slug!, { sourceId: DAILY_MEMORY_SOURCE_ID }))?.compiled_truth)
      .toContain('[[default:notes/boundary]]');
  });
});

test('implicit day uses timezone override not cycle.timezone', async () => {
  await engine.setConfig('cycle.timezone', 'UTC');
  // 16:00Z is still 2026-09-30 UTC, but already 2026-10-01 in Asia/Manila.
  const result = await writeDailyMemoryFromSources(engine, {
    timezone: 'Asia/Manila',
    now: () => new Date('2026-09-30T16:00:00.000Z'),
  });
  expect(result.day).toBe('2026-10-01');
  expect(result.slug).toBe('daily-memory/2026-10-01');
});


test('today extracts only its targets despite 83 unrelated stale dream pages', async () => {
  await ensureDailyMemorySource(engine);
  for (let i = 0; i < 83; i++) {
    const oldDay = new Date(Date.UTC(2026, 8, 29 - i)).toISOString().slice(0, 10);
    await engine.putPage(`daily-memory/${oldDay}`, {
      type: 'note', title: 'Old generated index', compiled_truth: '',
      frontmatter: { dream_generated: true },
    }, { sourceId: DAILY_MEMORY_SOURCE_ID });
  }
  await seed();
  const result = await runOneShotDailyMemoryWrite(engine, '2026-09-30');
  expect(result.extract_slugs).toEqual([result.slug]);
  expect(await engine.countStalePagesForExtraction({ sourceId: DAILY_MEMORY_SOURCE_ID })).toBe(83);
  const [target] = await engine.executeRaw<{ stamp: unknown }>(
    'SELECT links_extracted_at AS stamp FROM pages WHERE source_id=$1 AND slug=$2',
    [DAILY_MEMORY_SOURCE_ID, result.slug],
  );
  expect(target?.stamp).not.toBeNull();
  expect(await engine.executeRaw('SELECT id FROM minion_jobs')).toHaveLength(0);
});

test('selected extraction honors empty targets, missing targets and source identity', async () => {
  await ensureDailyMemorySource(engine);
  for (const sourceId of ['default', DAILY_MEMORY_SOURCE_ID]) {
    await engine.putPage('notes/same-slug', {
      type: 'note', title: 'Selected fixture', compiled_truth: '',
    }, { sourceId });
  }
  const opts = { dryRun: false, jsonMode: true, quiet: true, catchUp: false, sourceIdFilter: DAILY_MEMORY_SOURCE_ID };
  expect((await extractStaleFromDB(engine, { ...opts, slugs: [] })).pagesProcessed).toBe(0);
  expect((await extractStaleFromDB(engine, { ...opts, slugs: ['notes/missing'] })).pagesProcessed).toBe(0);
  const result = await extractStaleFromDB(engine, { ...opts, slugs: ['notes/same-slug'] });
  expect(result.pagesProcessed).toBe(1);
  expect(result.staleRemaining).toBe(0);
  expect(await engine.countStalePagesForExtraction({ sourceId: 'default' })).toBe(1);
  expect(await engine.countStalePagesForExtraction({ sourceId: DAILY_MEMORY_SOURCE_ID })).toBe(0);
});

test('human day with needs_extract retries only stale generated historical targets', async () => {
  await ensureDailyMemorySource(engine);
  await engine.putPage('daily-memory/2026-09-28', {
    type: 'note', title: 'Old index', compiled_truth: '', frontmatter: { dream_generated: true },
  }, { sourceId: DAILY_MEMORY_SOURCE_ID });
  await engine.putPage('daily-memory/2026-09-30', {
    type: 'note', title: 'Human day', compiled_truth: 'Preserve this note',
  });
  let called = 0;
  let sawSlugs: readonly string[] | undefined;
  const result = await runOneShotDailyMemoryWrite(engine, '2026-09-30', {
    extract: async (_engine, opts) => {
      called++;
      sawSlugs = opts.slugs;
      return extractStaleFromDB(_engine, opts);
    },
  });
  expect(result.reason).toBe('human_page');
  expect(result.needs_extract).toBe(true);
  expect(result.extract_slugs?.length ?? 0).toBe(0);
  expect(called).toBe(1);
  expect(sawSlugs).toEqual(['daily-memory/2026-09-28']);
  expect(await engine.countStalePagesForExtraction({ sourceId: DAILY_MEMORY_SOURCE_ID })).toBe(0);
});

test('today includes its capped record indexes but leaves a human reference untouched', async () => {
  await engine.executeRaw(`CREATE TABLE source_records (
    id text PRIMARY KEY, source_type text, source_ref text, entity_type text,
    entity_id text, payload_json jsonb, updated_at timestamptz
  )`);
  await engine.executeRaw(
    "INSERT INTO source_records VALUES ('fixture-record','fixture','fixture-ref','message','fixture-entity','{}'::jsonb,'2026-09-30T06:00:00Z')",
  );
  const first = await runOneShotDailyMemoryWrite(engine, '2026-09-30', { extract: noExtract });
  expect(first.extract_slugs).toHaveLength(2);
  const reference = first.extract_slugs!.find(slug => slug.startsWith('source-records/'))!;
  expect(reference).toBeDefined();
  await engine.putPage(reference, { type: 'note', title: 'Human reference', compiled_truth: 'Human-owned fixture' }, { sourceId: DAILY_MEMORY_SOURCE_ID });
  const second = await runOneShotDailyMemoryWrite(engine, '2026-09-30');
  expect(second.extract_slugs).toEqual([second.slug]);
  const [human] = await engine.executeRaw<{ stamp: unknown }>(
    'SELECT links_extracted_at AS stamp FROM pages WHERE source_id=$1 AND slug=$2',
    [DAILY_MEMORY_SOURCE_ID, reference],
  );
  expect(human?.stamp).toBeNull();
  expect((await engine.getPage(reference, { sourceId: DAILY_MEMORY_SOURCE_ID }))?.title).toBe('Human reference');
});


test('historical one-shot recovery preserves same-source human graph and watermark', async () => {
  await ensureDailyMemorySource(engine);
  for (const slug of ['notes/human-target', 'notes/historical-target']) {
    await engine.putPage(slug, { type: 'note', title: 'Synthetic target', compiled_truth: 'Synthetic fixture' });
  }
  const historical = 'daily-memory/2026-09-28';
  await engine.putPage(historical, { type: 'note', title: 'Generated historical index',
    compiled_truth: '[[default:notes/historical-target]]', frontmatter: { dream_generated: true } },
    { sourceId: DAILY_MEMORY_SOURCE_ID });
  const humanSlugs = ['daily-memory/2026-09-30', 'source-records/human-reference'];
  for (const slug of humanSlugs) await engine.putPage(slug, {
    type: 'note', title: 'Human-owned fixture', compiled_truth: '[[default:notes/human-target]]', frontmatter: {},
  }, { sourceId: DAILY_MEMORY_SOURCE_ID });
  const humanState = async () => Promise.all(humanSlugs.map(async slug => ({
    snapshot: await engine.readPageSnapshot(slug, { sourceId: DAILY_MEMORY_SOURCE_ID }),
    graph: await engine.getLinks(slug, { sourceId: DAILY_MEMORY_SOURCE_ID }),
    watermark: await engine.executeRaw('SELECT links_extracted_at FROM pages WHERE source_id=$1 AND slug=$2',
      [DAILY_MEMORY_SOURCE_ID, slug]),
  })));
  const before = await humanState();
  const result = await runOneShotDailyMemoryWrite(engine, '2026-09-30');
  expect(result.reason).toBe('human_page');
  expect(result.extract_slugs).toBeUndefined();
  expect((await engine.getLinks(historical, { sourceId: DAILY_MEMORY_SOURCE_ID })).some(link =>
    link.to_slug === 'notes/historical-target' && link.to_source_id === 'default')).toBe(true);
  expect(await humanState()).toEqual(before);
  // Remaining human watermarks neither become extraction targets nor fail the owned retry.
  expect(await engine.countStalePagesForExtraction({ sourceId: DAILY_MEMORY_SOURCE_ID })).toBe(2);
  expect(await engine.executeRaw('SELECT id FROM minion_jobs')).toHaveLength(0);
});

test('historical one-shot exhausted budget reports retained generated debt without touching human pages', async () => {
  await ensureDailyMemorySource(engine);
  await engine.putPage('daily-memory/2026-09-28', {
    type: 'note', title: 'Historical fixture', compiled_truth: '', frontmatter: { dream_generated: true },
  }, { sourceId: DAILY_MEMORY_SOURCE_ID });
  await engine.putPage('daily-memory/2026-09-30', {
    type: 'note', title: 'Human-owned fixture', compiled_truth: 'Preserve synthetic human fixture', frontmatter: {},
  }, { sourceId: DAILY_MEMORY_SOURCE_ID });
  const before = await engine.executeRaw('SELECT slug,knowledge_revision,updated_at,links_extracted_at FROM pages WHERE source_id=$1 ORDER BY slug',
    [DAILY_MEMORY_SOURCE_ID]);
  await expect(runOneShotDailyMemoryWrite(engine, '2026-09-30', { timeBudgetMs: 0 }))
    .rejects.toThrow('Daily memory extraction needs retry: 1 generated daily-index pages remain');
  expect(await engine.executeRaw('SELECT slug,knowledge_revision,updated_at,links_extracted_at FROM pages WHERE source_id=$1 ORDER BY slug',
    [DAILY_MEMORY_SOURCE_ID])).toEqual(before);
  expect(await engine.executeRaw('SELECT id FROM minion_jobs')).toHaveLength(0);
});
