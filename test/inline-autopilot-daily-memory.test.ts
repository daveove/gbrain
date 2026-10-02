import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { CycleReport, CycleStatus } from '../src/core/cycle.ts';
import { runInlineAutopilotCycle } from '../src/core/cycle/inline-autopilot.ts';
import { DAILY_MEMORY_SOURCE_ID } from '../src/core/cycle/daily-memory.ts';
import type { extractStaleFromDB } from '../src/commands/extract.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine, version: string | null;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); version = await engine.getConfig('version'); }, 60_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); if (version) await engine.setConfig('version', version); await engine.setConfig('cycle.timezone', 'Asia/Manila'); });
const noExtract: typeof extractStaleFromDB = async (eng, opts) => {
  const slugs = opts?.slugs;
  if (slugs?.length) {
    await eng.executeRaw(
      `UPDATE pages SET links_extracted_at = GREATEST(COALESCE(updated_at, now()), $3::timestamptz)
       WHERE source_id=$1 AND slug=ANY($2::text[]) AND deleted_at IS NULL`,
      [opts?.sourceIdFilter ?? DAILY_MEMORY_SOURCE_ID, [...slugs], '1970-01-01T00:00:00Z'],
    );
  }
  return { linksCreated: 0, timelineCreated: 0, pagesProcessed: slugs?.length ?? 0, staleRemaining: 0 };
};
const options = { brainDir: import.meta.dir }; // Injected cycles never read the repository.
const report = (status: CycleStatus, reason?: string) => ({ status, reason } as CycleReport);
const seed = async () => {
  await engine.putPage('notes/inline-late', { type: 'note', title: 'Late fixture', compiled_truth: 'Synthetic fixture', frontmatter: { date: '2026-09-30' } });
  await engine.executeRaw("UPDATE pages SET effective_date='2026-09-30T00:00:00Z'::timestamptz,effective_date_source='date' WHERE source_id='default' AND slug='notes/inline-late'");
};
const page = () => engine.getPage('daily-memory/2026-09-30', { sourceId: DAILY_MEMORY_SOURCE_ID });

for (const status of ['ok', 'clean', 'partial'] as const) test(`inline ${status} cycle awaits late-page daily maintenance pinned before midnight`, async () => {
  let instant = new Date('2026-09-30T15:59:00Z');
  const original = report(status);
  const calls: Array<Parameters<typeof extractStaleFromDB>[1]> = [];
  const controller = new AbortController();
  const result = await runInlineAutopilotCycle(engine, { ...options, signal: controller.signal }, { extract: async (_engine, opts) => { calls.push(opts); return noExtract(_engine, opts); }, now: () => instant, cycle: async () => {
    await seed(); instant = new Date('2026-09-30T16:01:00Z'); return original;
  } });
  expect(result).toBe(original);
  expect((await page())?.compiled_truth).toContain('[[default:notes/inline-late]]');
  expect(await engine.getPage('daily-memory/2026-10-01', { sourceId: DAILY_MEMORY_SOURCE_ID })).toBeNull();
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    expect(call.dryRun).toBe(false);
    expect(call.jsonMode).toBe(true);
    expect(call.quiet).toBe(true);
    expect(call.sourceIdFilter).toBe(DAILY_MEMORY_SOURCE_ID);
    expect(call.catchUp).toBe(false);
    expect(call.signal).toBe(controller.signal);
    expect(typeof call.timeBudgetMs).toBe('number');
    // Exact generated targets only — never a source-wide stale sweep.
    expect(Array.isArray(call.slugs)).toBe(true);
    expect(call.slugs!.length).toBeGreaterThan(0);
    for (const slug of call.slugs!) {
      expect(slug.startsWith('daily-memory/') || slug.startsWith('source-records/')).toBe(true);
    }
  }
  expect(await engine.executeRaw('SELECT id FROM minion_jobs')).toHaveLength(0);
});

test('inline maintenance keeps pinned timezone after cycle.timezone flips mid-cycle', async () => {
  // 02:00Z is 2026-09-30 in Asia/Manila and 2026-09-29 in America/Los_Angeles.
  await engine.putPage('notes/inline-tz-pin', {
    type: 'note', title: 'Timezone pin fixture', compiled_truth: 'Synthetic fixture', frontmatter: {},
  });
  await engine.executeRaw(
    "UPDATE pages SET effective_date=NULL, effective_date_source=NULL, updated_at='2026-09-30T02:00:00Z' WHERE slug='notes/inline-tz-pin'");
  await runInlineAutopilotCycle(engine, options, {
    extract: noExtract,
    now: () => new Date('2026-09-30T12:00:00Z'),
    cycle: async () => {
      await engine.setConfig('cycle.timezone', 'America/Los_Angeles');
      return report('ok');
    },
  });
  expect((await engine.getPage('daily-memory/2026-09-30', { sourceId: DAILY_MEMORY_SOURCE_ID }))?.compiled_truth)
    .toContain('[[default:notes/inline-tz-pin]]');
  expect(await engine.getPage('daily-memory/2026-09-29', { sourceId: DAILY_MEMORY_SOURCE_ID })).toBeNull();
});

test('inline maintenance refreshes its pinned previous-day lookback', async () => {
  await engine.putPage('notes/previous-inline-day', { type: 'note', title: 'Previous fixture', compiled_truth: 'Synthetic fixture', frontmatter: { date: '2026-09-29' } });
  await engine.executeRaw("UPDATE pages SET effective_date='2026-09-29T00:00:00Z'::timestamptz,effective_date_source='date' WHERE source_id='default' AND slug='notes/previous-inline-day'");
  await runInlineAutopilotCycle(engine, options, { extract: noExtract, now: () => new Date('2026-09-30T15:59:00Z'), cycle: async () => report('ok') });
  expect((await engine.getPage('daily-memory/2026-09-29', { sourceId: DAILY_MEMORY_SOURCE_ID }))?.compiled_truth).toContain('[[default:notes/previous-inline-day]]');
});

for (const variant of ['failed', 'skipped', 'aborted', 'signal'] as const) test(`inline ${variant} does not write an index`, async () => {
  const controller = new AbortController();
  await runInlineAutopilotCycle(engine, { ...options, signal: controller.signal }, { extract: noExtract, now: () => new Date('2026-09-30T12:00:00Z'), cycle: async () => {
    await seed(); if (variant === 'signal') controller.abort();
    return report(variant === 'failed' || variant === 'skipped' ? variant : 'partial', variant === 'aborted' ? 'aborted' : undefined);
  } });
  expect(await page()).toBeNull();
  expect(await engine.executeRaw('SELECT id FROM minion_jobs')).toHaveLength(0);
});

test('inline maintenance preserves a human daily page', async () => {
  await engine.putPage('daily-memory/2026-09-30', { type: 'note', title: 'Human fixture', compiled_truth: 'Preserve this fixture', frontmatter: {} });
  await runInlineAutopilotCycle(engine, options, { extract: noExtract, now: () => new Date('2026-09-30T12:00:00Z'), cycle: async () => { await seed(); return report('ok'); } });
  expect((await engine.getPage('daily-memory/2026-09-30'))?.compiled_truth).toBe('Preserve this fixture');
  expect(await engine.executeRaw('SELECT id FROM minion_jobs')).toHaveLength(0);
});

test('inline extraction rejection keeps its durable index and can report maintenance failure without retrying the cycle', async () => {
  await seed();
  await expect(runInlineAutopilotCycle(engine, options, { extract: async () => { throw new Error('Synthetic inline extraction rejection'); }, now: () => new Date('2026-09-30T12:00:00Z'), cycle: async () => report('ok') })).rejects.toThrow('Synthetic inline extraction rejection');
  let observed: unknown;
  const original = report('ok');
  expect(await runInlineAutopilotCycle(engine, options, {
    extract: async () => { throw new Error('Synthetic maintenance callback rejection'); },
    now: () => new Date('2026-09-30T12:00:00Z'), cycle: async () => original,
    onMaintenanceError: error => { observed = error; },
  })).toBe(original);
  expect(observed).toBeInstanceOf(Error);
  expect((observed as Error).message).toBe('Synthetic maintenance callback rejection');
  expect((await page())?.compiled_truth).toContain('[[default:notes/inline-late]]');
});


test('bounded inline extraction reports remaining work and a later cycle retries the durable index', async () => {
  await seed();
  const original = report('ok');
  let observed: unknown;
  expect(await runInlineAutopilotCycle(engine, options, {
    now: () => new Date('2026-09-30T12:00:00Z'), cycle: async () => original,
    extract: async () => ({ linksCreated: 0, timelineCreated: 0, pagesProcessed: 0, staleRemaining: 1 }),
    onMaintenanceError: error => { observed = error; },
  })).toBe(original);
  expect((observed as Error).message).toBe('Daily memory extraction needs retry: 1 selected daily-index pages remain');
  expect((await page())?.compiled_truth).toContain('[[default:notes/inline-late]]');
  let retries = 0;
  observed = undefined;
  expect(await runInlineAutopilotCycle(engine, options, {
    now: () => new Date('2026-09-30T12:00:00Z'), cycle: async () => original,
    extract: async (_engine, opts) => { retries++; return noExtract(_engine, opts); },
    onMaintenanceError: error => { observed = error; },
  })).toBe(original);
  expect(retries).toBeGreaterThan(0);
  expect(observed).toBeUndefined();
  expect(await engine.executeRaw('SELECT id FROM minion_jobs')).toHaveLength(0);
});

test('failed cycle still drains queued historical daily-memory jobs', async () => {
  const { MinionQueue } = await import('../src/core/minions/queue.ts');
  await engine.putPage('notes/queued-historical', {
    type: 'note', title: 'Queued fixture', compiled_truth: 'Synthetic fixture',
    frontmatter: { date: '2026-09-28' },
  });
  await engine.executeRaw(
    "UPDATE pages SET effective_date='2026-09-28T00:00:00Z'::timestamptz,effective_date_source='date' WHERE source_id='default' AND slug='notes/queued-historical'",
  );
  const queue = new MinionQueue(engine);
  const job = await queue.add('autopilot-daily-memory', {
    daily_memory_only: true, daily_memory_date: '2026-09-28', source_cycle_job_ids: [],
  });
  await seed();
  await runInlineAutopilotCycle(engine, options, {
    extract: noExtract,
    now: () => new Date('2026-09-30T12:00:00Z'),
    cycle: async () => report('failed'),
  });
  expect(await page()).toBeNull();
  expect((await engine.getPage('daily-memory/2026-09-28', { sourceId: DAILY_MEMORY_SOURCE_ID }))?.compiled_truth)
    .toContain('[[default:notes/queued-historical]]');
  expect((await queue.getJob(job.id))?.status).toBe('completed');
});


test('inline cycle preserves the timezone captured with its day when config changes during the cycle', async () => {
  await engine.putPage('notes/inline-zone', { type: 'note', title: 'Synthetic zone', compiled_truth: 'Synthetic fixture' });
  await engine.executeRaw("UPDATE pages SET effective_date=NULL,effective_date_source=NULL,updated_at='2026-09-30T02:00:00Z' WHERE slug='notes/inline-zone'");
  await runInlineAutopilotCycle(engine, options, {
    now: () => new Date('2026-09-30T02:00:00Z'), extract: noExtract,
    cycle: async () => { await engine.setConfig('cycle.timezone', 'America/Los_Angeles'); return report('clean'); },
  });
  expect((await engine.getPage('daily-memory/2026-09-30', { sourceId: DAILY_MEMORY_SOURCE_ID }))!.compiled_truth)
    .toContain('[[default:notes/inline-zone]]');
});

test('inline extract targets only owned generated indexes', async () => {
  // Seed a written daily index plus a stale human page on the dream source.
  await seed();
  await runInlineAutopilotCycle(engine, options, {
    extract: noExtract, now: () => new Date('2026-09-30T12:00:00Z'),
    cycle: async () => report('ok'),
  });
  const daily = await page();
  expect(daily).not.toBeNull();
  await engine.putPage('notes/human-on-dream', {
    type: 'note', title: 'Human dream page', compiled_truth: 'Human authored',
    frontmatter: { date: '2026-09-30' },
  }, { sourceId: DAILY_MEMORY_SOURCE_ID, force: true });
  // Force both pages stale for extraction.
  await engine.executeRaw(
    "UPDATE pages SET links_extracted_at=NULL WHERE source_id=$1",
    [DAILY_MEMORY_SOURCE_ID],
  );
  const calls: Array<Parameters<typeof extractStaleFromDB>[1]> = [];
  await runInlineAutopilotCycle(engine, options, {
    now: () => new Date('2026-09-30T12:00:00Z'),
    extract: async (_engine, opts) => { calls.push(opts); return noExtract(_engine, opts); },
    cycle: async () => report('ok'),
  });
  expect(calls.length).toBeGreaterThan(0);
  const targeted = calls.flatMap(call => call.slugs ?? []);
  expect(targeted.length).toBeGreaterThan(0);
  expect(targeted.every(slug => slug.startsWith('daily-memory/') || slug.startsWith('source-records/'))).toBe(true);
  expect(targeted).not.toContain('notes/human-on-dream');
});

