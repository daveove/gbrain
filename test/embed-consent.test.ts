import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { run as runEmbedCli } from '../src/cli/commands/embed.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import * as cliForceExit from '../src/core/cli-force-exit.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { withEnv } from './helpers/with-env.ts';
import type { CliDispatchContext } from '../src/cli/command-table.ts';

interface EmbedBudgetDocument {
  embedded: number;
  budget: { cumulativeCostUsd: number };
  budget_exhausted?: { cap_usd: number; spent_usd: number };
}

let engine: PGLiteEngine;
let providerCalls = 0;
const ctx: CliDispatchContext = {
  connectEngine: async () => engine,
  dbMarkerBrainId: () => undefined,
  SELECTED_CONFIG_BY_ENGINE: new WeakMap(),
  cliModuleUrl: new URL('../src/cli.ts', import.meta.url).href,
};

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  cliForceExit._resetCliExitVerdictForTests();
  providerCalls = 0;
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-fake-embed-consent' } });
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

async function runWithCap(cap: string): Promise<EmbedBudgetDocument> {
  const error = process.stderr.write;
  let stdout = '';
  const final = spyOn(cliForceExit, 'writeStdoutFinal').mockImplementation(async (value: string) => { stdout += value; });
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    await withEnv({ GBRAIN_EMBED_CONCURRENCY: '1' }, () => runEmbedCli(engine, ['--stale', '--catch-up', '--max-usd', cap, '--json'], ctx));
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
