import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { DAILY_MEMORY_SOURCE_ID, writeDailyMemoryFromSources } from '../src/core/cycle/daily-memory.ts';
import type { extractStaleFromDB } from '../src/commands/extract.ts';
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

test('one-shot writer runs dream-scoped extract in-process and queues no Minions job', async () => {
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
    sourceIdFilter: DAILY_MEMORY_SOURCE_ID, catchUp: false, timeBudgetMs: 60_000,
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

test('one-shot extract retries when dream-source pages remain stale', async () => {
  await seed();
  await expect(runOneShotDailyMemoryWrite(engine, '2026-09-30', {
    extract: async () => ({ linksCreated: 0, timelineCreated: 0, pagesProcessed: 0, staleRemaining: 2 }),
  })).rejects.toThrow('Daily memory extraction needs retry: 2 dream-source pages remain');
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

