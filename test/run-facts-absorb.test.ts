import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { __setChatTransportForTests, type ChatResult } from '../src/core/ai/gateway.ts';
import { _resetLlmHaltCooldownsForTests } from '../src/core/minions/llm-halt-cooldown.ts';
import { factsJobWorstCase, runFactsAbsorb } from '../scripts/run-facts-absorb.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

const KEYLESS = { ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined, OPENROUTER_API_KEY: undefined };
/** A servable chat model that extracts no facts. */
const noFactsChat = async (): Promise<ChatResult> => ({
  text: '{"facts":[]}', blocks: [], stopReason: 'end', model: 'anthropic:claude-sonnet-4-6', providerId: 'anthropic',
  usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
});
let engine: PGLiteEngine, version: string | null;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); version = await engine.getConfig('version'); }, 60_000);
afterAll(async () => { __setChatTransportForTests(null); await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  if (version) await engine.setConfig('version', version);
  _resetLlmHaltCooldownsForTests();
  __setChatTransportForTests(noFactsChat);
});

const page = () => engine.putPage('notes/facts-runner', { type: 'note', title: 'Runner fixture', compiled_truth: 'Synthetic fixture text.' });
const addFacts = (data: Record<string, unknown> = {}) =>
  new MinionQueue(engine).add('facts-absorb', { slug: 'notes/facts-runner', sourceId: 'default', source: 'mcp:put_page', ...data });
const rows = () => engine.executeRaw<{ name: string; status: string; attempts_made: number }>(
  'SELECT name, status, attempts_made FROM minion_jobs ORDER BY id');

test('claims only facts-absorb jobs and leaves other queued work alone', async () => {
  await page();
  await addFacts();
  await new MinionQueue(engine).add('extract', { unrelated: true });
  await withEnv(KEYLESS, async () => {
    const run = await runFactsAbsorb(engine, { maxUsd: 10, pollMs: 50, maxMinutes: 1 });
    expect([run.stopped, run.completed, run.remaining]).toEqual(['queue_empty', 1, 0]);
  });
  expect(await rows()).toEqual([
    { name: 'facts-absorb', status: 'completed', attempts_made: 0 },
    { name: 'extract', status: 'waiting', attempts_made: 0 },
  ]);
}, 60_000);

test('no servable chat model puts jobs back unspent instead of completing them empty', async () => {
  __setChatTransportForTests(null);
  await page();
  await addFacts();
  await addFacts({ n: 2 });
  // Keyless, and also a key without a configured gateway (the 2026-10-10 incident).
  for (const env of [KEYLESS, { ...KEYLESS, ANTHROPIC_API_KEY: 'test-not-a-key' }]) {
    await withEnv(env, async () => {
      const run = await runFactsAbsorb(engine, { maxUsd: 10, pollMs: 50, maxMinutes: 1 });
      expect([run.stopped, run.completed, run.spentUsd, run.remaining]).toEqual(['unavailable', 0, 0, 2]);
    });
    expect((await rows()).map(row => row.attempts_made)).toEqual([0, 0]);
  }
}, 60_000);

test('a cap below one job\'s worst case spends nothing and keeps the attempt', async () => {
  await page();
  await addFacts();
  await withEnv(KEYLESS, async () => {
    const pricing = await factsJobWorstCase(engine);
    const worst = pricing.usd(pricing.defaultModel);
    expect(worst).toBeGreaterThan(0);
    const run = await runFactsAbsorb(engine, { maxUsd: worst! * 0.5, pollMs: 50 });
    expect(run).toEqual({ stopped: 'budget', completed: 0, failed: 0, spentUsd: 0, worstCaseJobUsd: worst, remaining: 1 });
  });
  expect(await rows()).toEqual([{ name: 'facts-absorb', status: 'delayed', attempts_made: 0 }]);
});

test('a handler that fails every job stops the run after a few jobs', async () => {
  const queue = new MinionQueue(engine);
  for (let i = 0; i < 20; i++) {
    await queue.add('facts-absorb', { slug: '', n: i }, { backoff_type: 'fixed', backoff_delay: 60_000, backoff_jitter: 0 });
  }
  await withEnv(KEYLESS, async () => {
    const run = await runFactsAbsorb(engine, { maxUsd: 10, pollMs: 50, maxMinutes: 1 });
    expect(run.stopped).toBe('failing');
    expect(run.completed).toBe(0);
    expect(run.remaining).toBe(20);
  });
}, 60_000);

test('a job naming an unpriced model is put back unspent and stops the run until pricing.overrides prices it', async () => {
  await page();
  const job = await addFacts({ model: 'acme-example:custom-model' });
  await withEnv(KEYLESS, async () => {
    const blocked = await runFactsAbsorb(engine, { maxUsd: 10, pollMs: 50 });
    expect([blocked.stopped, blocked.completed, blocked.spentUsd, blocked.remaining]).toEqual(['unpriced', 0, 0, 1]);
    expect((await new MinionQueue(engine).getJob(job.id))?.attempts_made).toBe(0);
    await engine.setConfig('pricing.overrides', JSON.stringify({ 'acme-example:custom-model': { input: 1, output: 2 } }));
    const priced = await runFactsAbsorb(engine, { maxUsd: 10, pollMs: 50, maxMinutes: 1 });
    expect([priced.stopped, priced.completed, priced.remaining]).toEqual(['queue_empty', 1, 0]);
  });
}, 60_000);

test('a delayed retry that comes due before the deadline is run, not left behind', async () => {
  await page();
  const job = await addFacts();
  await engine.executeRaw("UPDATE minion_jobs SET status='delayed', delay_until=now() + interval '2 seconds' WHERE id=$1", [job.id]);
  await withEnv(KEYLESS, async () => {
    const run = await runFactsAbsorb(engine, { maxUsd: 10, pollMs: 50, maxMinutes: 0.5 });
    expect([run.stopped, run.completed, run.remaining]).toEqual(['queue_empty', 1, 0]);
  });
}, 60_000);

test('a signal that arrives before the run starts claims nothing', async () => {
  await page();
  await addFacts();
  const abort = new AbortController();
  abort.abort();
  await withEnv(KEYLESS, async () => {
    const run = await runFactsAbsorb(engine, { maxUsd: 10, pollMs: 50, signal: abort.signal });
    expect([run.stopped, run.completed, run.remaining]).toEqual(['signal', 0, 1]);
  });
  expect(await rows()).toEqual([{ name: 'facts-absorb', status: 'waiting', attempts_made: 0 }]);
});

test('an unpriced brain default does not block jobs that name a priced model', async () => {
  await page();
  await engine.setConfig('facts.extraction_model', 'acme-example:unpriced-default');
  await addFacts({ model: 'anthropic:claude-sonnet-4-6' });
  await withEnv(KEYLESS, async () => {
    const run = await runFactsAbsorb(engine, { maxUsd: 10, pollMs: 50, maxMinutes: 1 });
    expect([run.stopped, run.completed, run.worstCaseJobUsd, run.remaining]).toEqual(['queue_empty', 1, null, 0]);
  });
}, 60_000);
