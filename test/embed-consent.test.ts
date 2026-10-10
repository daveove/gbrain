import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { run as runEmbedCli } from '../src/cli/commands/embed.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import * as cliForceExit from '../src/core/cli-force-exit.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { withEnv } from './helpers/with-env.ts';
import type { CliDispatchContext } from '../src/cli/command-table.ts';
import type { BrainEngine } from '../src/core/engine.ts';

interface EmbedBudgetDocument {
  embedded: number;
  budget: { cumulativeCostUsd: number };
  budget_exhausted?: { reason: string; cap_usd: number; spent_usd: number };
  code?: string;
  why?: string;
  fix?: { argv: string[]; inputs: Array<{ name: string }> };
}

const FIXTURE_GATEWAY = { embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-fake-embed-consent' } };
let testHome: string;
let engine: PGLiteEngine;
let providerCalls = 0;
const ctx: CliDispatchContext = {
  connectEngine: async () => engine,
  dbMarkerBrainId: () => undefined,
  SELECTED_CONFIG_BY_ENGINE: new WeakMap(),
  cliModuleUrl: new URL('../src/cli.ts', import.meta.url).href,
};

beforeAll(async () => {
  testHome = mkdtempSync(join(tmpdir(), 'gbrain-embed-consent-'));
  configureGateway(FIXTURE_GATEWAY);
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine.disconnect(); rmSync(testHome, { recursive: true, force: true }); });
beforeEach(async () => {
  await resetPgliteState(engine);
  cliForceExit._resetCliExitVerdictForTests();
  providerCalls = 0;
  configureGateway(FIXTURE_GATEWAY);
  __setEmbedTransportForTests((async (args: { values: string[] }) => {
    providerCalls++;
    return { embeddings: args.values.map(() => Array.from({ length: 1536 }, () => 0.01)), usage: { tokens: 400 } };
  }) as never);
  for (const slug of ['notes/one', 'notes/two', 'notes/three']) {
    const text = `A sample passage about ${slug} and project decisions.`;
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: text });
    await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: text, chunk_source: 'compiled_truth' }]);
  }
});
afterEach(() => {
  __setEmbedTransportForTests(null);
  resetGateway();
});

async function runWithCap(cap: string, target: BrainEngine = engine): Promise<EmbedBudgetDocument> {
  const error = process.stderr.write;
  let stdout = '';
  const final = spyOn(cliForceExit, 'writeStdoutFinal').mockImplementation(async (value: string) => { stdout += value; });
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    await withEnv({ GBRAIN_HOME: testHome, GBRAIN_EMBED_CONCURRENCY: '1' }, () => runEmbedCli(target, ['--stale', '--catch-up', '--max-usd', cap, '--json'], ctx));
    return JSON.parse(stdout);
  } finally {
    final.mockRestore();
    process.stderr.write = error;
  }
}

test('the approved cap denies the next paid request and preserves resumable progress', async () => {
  const result = await runWithCap('0.00005201');
  expect(cliForceExit.currentExitCode()).toBe(1);
  expect(providerCalls).toBe(1);
  expect(result.budget_exhausted?.cap_usd).toBe(0.00005201);
  expect(result.budget_exhausted?.spent_usd).toBeCloseTo(0.000052, 12);
  expect(result.embedded).toBe(1);
  expect(await engine.countStaleChunks()).toBe(2);
  const stored = await engine.executeRaw<{ slug: string }>(`SELECT p.slug FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE c.embedding IS NOT NULL`);
  expect(stored.map(row => row.slug)).toEqual(['notes/one']);

  cliForceExit._resetCliExitVerdictForTests();
  const resumed = await runWithCap('0.01');
  expect(cliForceExit.currentExitCode()).toBe(0);
  expect(providerCalls).toBe(3);
  expect(resumed.embedded).toBe(2);
  expect(await engine.countStaleChunks()).toBe(0);
  expect(resumed.budget.cumulativeCostUsd).toBeCloseTo(0.000104, 12);
}, 60_000);

test('an unpriced model returns its pricing remedy without spending or losing pending work', async () => {
  configureGateway({
    embedding_model: 'litellm:budget-unpriced-model', embedding_dimensions: 1536,
    env: { LITELLM_BASE_URL: 'http://unused.invalid/v1' },
  });
  const result = await runWithCap('1');
  expect(cliForceExit.currentExitCode()).toBe(1);
  expect(providerCalls).toBe(0);
  expect(result.code).toBe('no_pricing');
  expect(result.budget_exhausted?.reason).toBe('no_pricing');
  expect(result.why).toContain('litellm:budget-unpriced-model');
  expect(result.fix?.argv.slice(0, 3)).toEqual(['gbrain', 'pricing', 'set']);
  expect(result.fix?.inputs.map(input => input.name)).toContain('usd-per-1M-tokens');
  expect(result.budget.cumulativeCostUsd).toBe(0);
  expect(await engine.countStaleChunks()).toBe(3);
}, 60_000);

test('a capped partial drain repairs stale planner statistics through the Postgres path', async () => {
  await engine.executeRaw("UPDATE content_chunks SET model='legacy-unembedded'");
  await engine.executeRaw('ANALYZE content_chunks(model)');
  await engine.executeRaw("UPDATE content_chunks SET model='openai:text-embedding-3-large'");
  const models = async () => (await engine.executeRaw<{ models: string }>(
    "SELECT most_common_vals::text AS models FROM pg_stats WHERE schemaname=current_schema() AND tablename='content_chunks' AND attname='model'",
  ))[0]?.models ?? '';
  expect(await models()).not.toContain('openai:text-embedding-3-large');
  const postgresPath = new Proxy(engine, {
    get(target, key) {
      if (key === 'kind') return 'postgres';
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const result = await runWithCap('0.00005201', postgresPath);
  expect(result.embedded).toBe(1);
  expect(providerCalls).toBe(1);
  expect(await engine.countStaleChunks()).toBe(2);
  expect(await models()).toContain('openai:text-embedding-3-large');
}, 60_000);
