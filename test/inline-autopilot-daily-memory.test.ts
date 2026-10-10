import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { CycleReport, CycleStatus } from '../src/core/cycle.ts';
import { runInlineAutopilotCycle } from '../src/core/cycle/inline-autopilot.ts';
import { ensureDailyMemorySource, DAILY_MEMORY_SOURCE_ID } from '../src/core/cycle/daily-memory.ts';
import type { extractStaleFromDB } from '../src/commands/extract.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine, version: string | null;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); version = await engine.getConfig('version'); }, 60_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); if (version) await engine.setConfig('version', version); await engine.setConfig('cycle.timezone', 'Asia/Manila'); });
const extractFixture: typeof extractStaleFromDB = async (...args) => (await import('../src/commands/extract.ts')).extractStaleFromDB(...args);
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
  const result = await runInlineAutopilotCycle(engine, { ...options, signal: controller.signal }, { extract: async (_engine, opts) => { calls.push(opts); return extractFixture(_engine, opts); }, now: () => instant, cycle: async () => {
    await seed(); instant = new Date('2026-09-30T16:01:00Z'); return original;
  } });
  expect(result).toBe(original);
  expect((await page())?.compiled_truth).toContain('[[default:notes/inline-late]]');
  expect(await engine.getPage('daily-memory/2026-10-01', { sourceId: DAILY_MEMORY_SOURCE_ID })).toBeNull();
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    expect(call).toEqual(expect.objectContaining({ dryRun: false, jsonMode: true, quiet: true,
      sourceIdFilter: DAILY_MEMORY_SOURCE_ID, slugs: ['daily-memory/2026-09-30'], catchUp: false, signal: controller.signal }));
    expect(call.timeBudgetMs).toBeGreaterThan(0);
    expect(call.timeBudgetMs).toBeLessThanOrEqual(60_000);
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
    extract: extractFixture,
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
  await runInlineAutopilotCycle(engine, options, { extract: extractFixture, now: () => new Date('2026-09-30T15:59:00Z'), cycle: async () => report('ok') });
  expect((await engine.getPage('daily-memory/2026-09-29', { sourceId: DAILY_MEMORY_SOURCE_ID }))?.compiled_truth).toContain('[[default:notes/previous-inline-day]]');
});

for (const variant of ['failed', 'skipped', 'aborted', 'signal'] as const) test(`inline ${variant} does not write an index`, async () => {
  const controller = new AbortController();
  await runInlineAutopilotCycle(engine, { ...options, signal: controller.signal }, { extract: extractFixture, now: () => new Date('2026-09-30T12:00:00Z'), cycle: async () => {
    await seed(); if (variant === 'signal') controller.abort();
    return report(variant === 'failed' || variant === 'skipped' ? variant : 'partial', variant === 'aborted' ? 'aborted' : undefined);
  } });
  expect(await page()).toBeNull();
  expect(await engine.executeRaw('SELECT id FROM minion_jobs')).toHaveLength(0);
});

test('inline maintenance preserves a human daily page', async () => {
  await engine.putPage('daily-memory/2026-09-30', { type: 'note', title: 'Human fixture', compiled_truth: 'Preserve this fixture', frontmatter: {} });
  await runInlineAutopilotCycle(engine, options, { extract: extractFixture, now: () => new Date('2026-09-30T12:00:00Z'), cycle: async () => { await seed(); return report('ok'); } });
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
  expect((observed as Error).message).toBe('Daily memory extraction needs retry: 1 generated daily-index pages remain');
  expect((await page())?.compiled_truth).toContain('[[default:notes/inline-late]]');
  let retries = 0;
  observed = undefined;
  expect(await runInlineAutopilotCycle(engine, options, {
    now: () => new Date('2026-09-30T12:00:00Z'), cycle: async () => original,
    extract: async (_engine, opts) => { retries++; return extractFixture(_engine, opts); },
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
    extract: extractFixture,
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
    now: () => new Date('2026-09-30T02:00:00Z'), extract: extractFixture,
    cycle: async () => { await engine.setConfig('cycle.timezone', 'America/Los_Angeles'); return report('clean'); },
  });
  expect((await engine.getPage('daily-memory/2026-09-30', { sourceId: DAILY_MEMORY_SOURCE_ID }))!.compiled_truth)
    .toContain('[[default:notes/inline-zone]]');
});

async function humanGraphFixture() {
  await ensureDailyMemorySource(engine);
  for (const slug of ['notes/human-target', 'notes/generated-target']) {
    await engine.putPage(slug, { type: 'note', title: 'Synthetic target', compiled_truth: 'Synthetic fixture' });
  }
  await engine.executeRaw("UPDATE pages SET effective_date='2026-01-20T00:00:00Z',effective_date_source='date',frontmatter=frontmatter || '{\"date\":\"2026-01-20\"}'::jsonb WHERE source_id='default' AND slug='notes/generated-target'");
  const generated = 'daily-memory/2026-01-20';
  await engine.putPage(generated, { type: 'note', title: 'Generated fixture',
    compiled_truth: '[[default:notes/generated-target]]', frontmatter: { dream_generated: true } },
    { sourceId: DAILY_MEMORY_SOURCE_ID });
  const humans = ['daily-memory/2026-09-30', 'source-records/human-reference'];
  for (const slug of humans) await engine.putPage(slug, { type: 'note', title: 'Human fixture',
    compiled_truth: '[[default:notes/human-target]]', frontmatter: {} }, { sourceId: DAILY_MEMORY_SOURCE_ID });
  const snapshot = () => Promise.all(humans.map(async slug => ({
    page: await engine.readPageSnapshot(slug, { sourceId: DAILY_MEMORY_SOURCE_ID }),
    graph: await engine.getLinks(slug, { sourceId: DAILY_MEMORY_SOURCE_ID }),
    watermark: await engine.executeRaw('SELECT links_extracted_at FROM pages WHERE source_id=$1 AND slug=$2', [DAILY_MEMORY_SOURCE_ID, slug]),
  })));
  return { generated, snapshot, before: await snapshot() };
}

for (const historical of [false, true]) test(`inline ${historical ? 'queued historical drain' : 'direct maintenance'} preserves same-source human graph and watermark`, async () => {
  const fixture = await humanGraphFixture();
  if (historical) await new MinionQueue(engine).add('autopilot-daily-memory', {
    daily_memory_only: true, daily_memory_date: '2026-01-20', source_cycle_job_ids: [],
  });
  await runInlineAutopilotCycle(engine, options, {
    now: () => new Date('2026-09-30T12:00:00Z'),
    cycle: async () => report(historical ? 'failed' : 'ok'),
  });
  expect((await engine.getLinks(fixture.generated, { sourceId: DAILY_MEMORY_SOURCE_ID }))
    .some(link => link.to_slug === 'notes/generated-target' && link.to_source_id === 'default')).toBe(true);
  expect(await fixture.snapshot()).toEqual(fixture.before);
  expect(await engine.countStalePagesForExtraction({ sourceId: DAILY_MEMORY_SOURCE_ID })).toBe(2);
  if (historical) expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE name='autopilot-daily-memory' AND status<>'completed'")).toHaveLength(0);
});

test('queued daily extraction preserves same-source human graph and watermark', async () => {
  const fixture = await humanGraphFixture();
  const handlers = new Map<string, (job: any) => Promise<any>>();
  await registerBuiltinHandlers({ register(name: string, handler: (job: any) => Promise<any>) { handlers.set(name, handler); } } as never, engine);
  const queue = new MinionQueue(engine);
  const job = await queue.add('extract', { stale: true, sourceId: DAILY_MEMORY_SOURCE_ID, reason: 'daily_memory_write', deferred_commit: 'daily-memory:2026-01-20' });
  const claimed = (await queue.claim('synthetic-daily-worker', 60_000, 'default', ['extract']))!;
  expect(claimed.id).toBe(job.id);
  await handlers.get('extract')!({ ...claimed, signal: new AbortController().signal });
  await queue.completeJob(claimed.id, 'synthetic-daily-worker', {});
  expect((await engine.getLinks(fixture.generated, { sourceId: DAILY_MEMORY_SOURCE_ID }))
    .some(link => link.to_slug === 'notes/generated-target' && link.to_source_id === 'default')).toBe(true);
  expect(await fixture.snapshot()).toEqual(fixture.before);
  expect(await engine.countStalePagesForExtraction({ sourceId: DAILY_MEMORY_SOURCE_ID })).toBe(2);
  expect((await queue.getJob(job.id))?.status).toBe('completed');
});

test('managed transcript deletion refuses before changing the page or atomic daily debt', async () => {
  const { createTranscriptIngestDailyMemory } = await import('../src/core/transcripts/ingest-daily-memory.ts');
  const slug = 'notes/managed-delete-fixture';
  await engine.putPage(slug, { type: 'note', title: 'Managed fixture', compiled_truth: 'Preserve synthetic content', frontmatter: { date: '2026-01-20' } });
  const daily = (await createTranscriptIngestDailyMemory(engine, { sourceId: 'default', runKey: 'synthetic-managed-delete' }))!;
  await daily.before([slug]);
  const pageBefore = await engine.readPageSnapshot(slug, { sourceId: 'default' });
  const debt = () => Promise.all([engine.executeRaw('SELECT * FROM op_checkpoints ORDER BY op,fingerprint'),
    engine.executeRaw('SELECT * FROM op_checkpoint_paths ORDER BY op,fingerprint,path')]);
  const debtBefore = await debt();
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  try {
    await expect(daily.deleteStalePart(slug)).rejects.toThrow('writer_coordinator_required');
    expect(await engine.readPageSnapshot(slug, { sourceId: 'default' })).toEqual(pageBefore);
    expect(await debt()).toEqual(debtBefore);
  } finally {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await daily.release();
  }
});

test('inline extract targets only owned generated indexes', async () => {
  // Seed a written daily index plus a stale human page on the dream source.
  await seed();
  await runInlineAutopilotCycle(engine, options, {
    extract: extractFixture, now: () => new Date('2026-09-30T12:00:00Z'),
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
    extract: async (_engine, opts) => { calls.push(opts); return extractFixture(_engine, opts); },
    cycle: async () => report('ok'),
  });
  expect(calls.length).toBeGreaterThan(0);
  const targeted = calls.flatMap(call => call.slugs ?? []);
  expect(targeted.length).toBeGreaterThan(0);
  expect(targeted.every(slug => slug.startsWith('daily-memory/') || slug.startsWith('source-records/'))).toBe(true);
  expect(targeted).not.toContain('notes/human-on-dream');
});
