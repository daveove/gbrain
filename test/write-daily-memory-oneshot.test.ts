import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { DAILY_MEMORY_SOURCE_ID } from '../src/core/cycle/daily-memory.ts';
import type { extractStaleFromDB } from '../src/commands/extract.ts';
import { extractOneShotDailyMemory, runOneShotDailyMemoryWrite } from '../scripts/write-daily-memory.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

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

const seed = async () => {
  await engine.putPage('notes/oneshot-day', {
    type: 'note', title: 'One-shot fixture', compiled_truth: 'Synthetic fixture',
    frontmatter: { date: '2026-09-30' },
  });
  await engine.executeRaw(
    "UPDATE pages SET effective_date='2026-09-30T00:00:00Z'::timestamptz,effective_date_source='date' WHERE source_id='default' AND slug='notes/oneshot-day'",
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
