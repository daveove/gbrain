import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { CycleReport, CycleStatus } from '../src/core/cycle.ts';
import { runInlineAutopilotCycle } from '../src/core/cycle/inline-autopilot.ts';
import { DAILY_MEMORY_SOURCE_ID } from '../src/core/cycle/daily-memory.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine, version: string | null;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); version = await engine.getConfig('version'); }, 60_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); if (version) await engine.setConfig('version', version); await engine.setConfig('cycle.timezone', 'Asia/Manila'); });
const report = (status: CycleStatus, reason?: string) => ({ status, reason } as CycleReport);
const seed = async () => {
  await engine.putPage('notes/inline-late', { type: 'note', title: 'Late fixture', compiled_truth: 'Synthetic fixture', frontmatter: { date: '2026-09-30' } });
  await engine.executeRaw("UPDATE pages SET effective_date='2026-09-30T00:00:00Z'::timestamptz,effective_date_source='date' WHERE source_id='default' AND slug='notes/inline-late'");
};
const page = () => engine.getPage('daily-memory/2026-09-30', { sourceId: DAILY_MEMORY_SOURCE_ID });

for (const status of ['ok', 'clean', 'partial'] as const) test(`inline ${status} cycle awaits late-page daily maintenance pinned before midnight`, async () => {
  let instant = new Date('2026-09-30T15:59:00Z');
  const original = report(status);
  const result = await runInlineAutopilotCycle(engine, {}, { now: () => instant, cycle: async () => {
    await seed(); instant = new Date('2026-09-30T16:01:00Z'); return original;
  } });
  expect(result).toBe(original);
  expect((await page())?.compiled_truth).toContain('[[default:notes/inline-late]]');
  expect(await engine.getPage('daily-memory/2026-10-01', { sourceId: DAILY_MEMORY_SOURCE_ID })).toBeNull();
  const extract = await engine.executeRaw<{ data: { deferred_commit: string } }>("SELECT data FROM minion_jobs WHERE name='extract' AND data->>'sourceId'=$1", [DAILY_MEMORY_SOURCE_ID]);
  expect(extract.map(job => job.data.deferred_commit).sort()).toEqual(['daily-memory:2026-09-29', 'daily-memory:2026-09-30']);
});

test('inline maintenance refreshes its pinned previous-day lookback', async () => {
  await engine.putPage('notes/previous-inline-day', { type: 'note', title: 'Previous fixture', compiled_truth: 'Synthetic fixture', frontmatter: { date: '2026-09-29' } });
  await engine.executeRaw("UPDATE pages SET effective_date='2026-09-29T00:00:00Z'::timestamptz,effective_date_source='date' WHERE source_id='default' AND slug='notes/previous-inline-day'");
  await runInlineAutopilotCycle(engine, {}, { now: () => new Date('2026-09-30T15:59:00Z'), cycle: async () => report('ok') });
  expect((await engine.getPage('daily-memory/2026-09-29', { sourceId: DAILY_MEMORY_SOURCE_ID }))?.compiled_truth).toContain('[[default:notes/previous-inline-day]]');
});

for (const variant of ['failed', 'skipped', 'aborted', 'signal'] as const) test(`inline ${variant} does not write an index`, async () => {
  const controller = new AbortController();
  await runInlineAutopilotCycle(engine, { signal: controller.signal }, { now: () => new Date('2026-09-30T12:00:00Z'), cycle: async () => {
    await seed(); if (variant === 'signal') controller.abort();
    return report(variant === 'failed' || variant === 'skipped' ? variant : 'partial', variant === 'aborted' ? 'aborted' : undefined);
  } });
  expect(await page()).toBeNull();
  expect(await engine.executeRaw('SELECT id FROM minion_jobs')).toHaveLength(0);
});

test('inline maintenance preserves a human daily page', async () => {
  await engine.putPage('daily-memory/2026-09-30', { type: 'note', title: 'Human fixture', compiled_truth: 'Preserve this fixture', frontmatter: {} });
  await runInlineAutopilotCycle(engine, {}, { now: () => new Date('2026-09-30T12:00:00Z'), cycle: async () => { await seed(); return report('ok'); } });
  expect((await engine.getPage('daily-memory/2026-09-30'))?.compiled_truth).toBe('Preserve this fixture');
  expect(await engine.executeRaw('SELECT id FROM minion_jobs')).toHaveLength(0);
});

test('inline extraction rejection keeps its durable index and can report maintenance failure without retrying the cycle', async () => {
  await seed();
  const rejected = spyOn(MinionQueue.prototype, 'add').mockImplementation(async () => { throw new Error('Synthetic inline maintenance handoff rejection'); });
  try { await expect(runInlineAutopilotCycle(engine, {}, { now: () => new Date('2026-09-30T12:00:00Z'), cycle: async () => report('ok') })).rejects.toThrow('Synthetic inline maintenance handoff rejection'); }
  finally { rejected.mockRestore(); }
  let observed: unknown;
  const second = spyOn(MinionQueue.prototype, 'add').mockImplementation(async () => { throw new Error('Synthetic maintenance callback rejection'); });
  const original = report('ok');
  try { expect(await runInlineAutopilotCycle(engine, {}, { now: () => new Date('2026-09-30T12:00:00Z'), cycle: async () => original, onMaintenanceError: error => { observed = error; } })).toBe(original); }
  finally { second.mockRestore(); }
  expect(observed).toBeInstanceOf(Error);
  expect((observed as Error).message).toBe('Synthetic maintenance callback rejection');
  expect((await page())?.compiled_truth).toContain('[[default:notes/inline-late]]');
});
