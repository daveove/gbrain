import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { runFactsAbsorb, worstCaseFactsJobUsd } from '../scripts/run-facts-absorb.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

const KEYLESS = { ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined, OPENROUTER_API_KEY: undefined };
let engine: PGLiteEngine, version: string | null;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); version = await engine.getConfig('version'); }, 60_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); if (version) await engine.setConfig('version', version); });

const statuses = async () => Object.fromEntries((await engine.executeRaw<{ name: string; status: string }>(
  'SELECT name, status FROM minion_jobs ORDER BY id')).map(row => [row.name, row.status]));

test('claims only facts-absorb jobs and leaves other queued work alone', async () => {
  await engine.putPage('notes/facts-runner', { type: 'note', title: 'Runner fixture', compiled_truth: 'Synthetic fixture text.' });
  const queue = new MinionQueue(engine);
  await queue.add('facts-absorb', { slug: 'notes/facts-runner', sourceId: 'default', source: 'mcp:put_page' });
  await queue.add('extract', { unrelated: true });
  await withEnv(KEYLESS, async () => {
    const run = await runFactsAbsorb(engine, { maxUsd: 10, pollMs: 50, maxMinutes: 1 });
    expect(run.stopped).toBe('queue_empty');
    expect(run.completed).toBe(1);
    expect(run.remainingWaiting).toBe(0);
  });
  expect(await statuses()).toEqual({ 'facts-absorb': 'completed', extract: 'waiting' });
}, 60_000);

test('a cap below one job\'s worst case claims nothing', async () => {
  await engine.putPage('notes/facts-runner', { type: 'note', title: 'Runner fixture', compiled_truth: 'Synthetic fixture text.' });
  await new MinionQueue(engine).add('facts-absorb', { slug: 'notes/facts-runner', sourceId: 'default', source: 'mcp:put_page' });
  await withEnv(KEYLESS, async () => {
    const worst = await worstCaseFactsJobUsd(engine);
    expect(worst).toBeGreaterThan(0);
    const run = await runFactsAbsorb(engine, { maxUsd: worst! * 1.5, pollMs: 50 });
    expect(run).toEqual({ stopped: 'budget', completed: 0, failed: 0, spentUsd: 0, worstCaseJobUsd: worst, remainingWaiting: 1 });
  });
  expect(await statuses()).toEqual({ 'facts-absorb': 'waiting' });
});

test('a setup fault that fails every job stops the run after a few jobs', async () => {
  const body = 'alice-example decided to move the acme-example pilot to Thursday and asked for a revised budget. '.repeat(12);
  await engine.putPage('notes/facts-runner', { type: 'note', title: 'Runner fixture', compiled_truth: body });
  const queue = new MinionQueue(engine);
  for (let i = 0; i < 20; i++) {
    await queue.add('facts-absorb', { slug: 'notes/facts-runner', sourceId: 'default', source: 'mcp:put_page', n: i },
      { backoff_type: 'fixed', backoff_delay: 60_000, backoff_jitter: 0 });
  }
  // A key without a configured gateway fails every extraction, as on 2026-10-10.
  await withEnv({ ...KEYLESS, ANTHROPIC_API_KEY: 'test-not-a-key' }, async () => {
    const run = await runFactsAbsorb(engine, { maxUsd: 10, pollMs: 50, maxMinutes: 1 });
    expect(run.stopped).toBe('failing');
    expect(run.completed).toBe(0);
    expect(run.remainingWaiting).toBeGreaterThanOrEqual(10);
  });
}, 60_000);

test('a queued job naming an unpriced model claims nothing until pricing.overrides prices it', async () => {
  await engine.putPage('notes/facts-runner', { type: 'note', title: 'Runner fixture', compiled_truth: 'Synthetic fixture text.' });
  await new MinionQueue(engine).add('facts-absorb', { slug: 'notes/facts-runner', sourceId: 'default', source: 'mcp:put_page', model: 'acme-example:custom-model' });
  await withEnv(KEYLESS, async () => {
    const blocked = await runFactsAbsorb(engine, { maxUsd: 10, pollMs: 50 });
    expect([blocked.stopped, blocked.worstCaseJobUsd, blocked.spentUsd, blocked.remainingWaiting]).toEqual(['unpriced', null, 0, 1]);
    await engine.setConfig('pricing.overrides', JSON.stringify({ 'acme-example:custom-model': { input: 1, output: 2 } }));
    const priced = await runFactsAbsorb(engine, { maxUsd: 10, pollMs: 50, maxMinutes: 1 });
    expect([priced.stopped, priced.completed, priced.remainingWaiting]).toEqual(['queue_empty', 1, 0]);
  });
});
