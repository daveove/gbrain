import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importImageFile, _resetOcrRunBudgetForTests } from '../src/core/import-file.ts';
import { embedStaleImages } from '../src/core/embed-stale-images.ts';
import {
  configureGateway, resetGateway, withBudgetTracker, __setGenerateTextTransportForTests,
  DEFAULT_MAX_OUTPUT_TOKENS,
} from '../src/core/ai/gateway.ts';
import { BudgetExhausted, BudgetTracker } from '../src/core/budget/budget-tracker.ts';
import { usageCostUsd } from '../src/core/budget/reservation-cost.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const SLUGS = ['one.png', 'two.png', 'three.png'];
const VISUAL_MODEL = 'voyage:voyage-multimodal-3';
const OCR_MODEL = 'anthropic:claude-haiku-4-5-20251001';
// The visual reservation is 1600 image tokens; deliberately bill 2000 so
// admission for the next page must use settled provider usage, not the estimate.
const VISUAL_TOKENS = 2000;
const OCR_USAGE = { inputTokens: 2000, outputTokens: DEFAULT_MAX_OUTPUT_TOKENS };
const VISUAL_COST = usageCostUsd(VISUAL_MODEL, VISUAL_TOKENS, 0, 'embed')!;
const OCR_COST = usageCostUsd(OCR_MODEL, OCR_USAGE.inputTokens, OCR_USAGE.outputTokens, 'chat')!;
const EPSILON_USD = 0.00000001;
const OCR_TEXT = 'Synthetic image budget receipt';

let engine: PGLiteEngine;
let dir: string;
let visualCalls = 0;
let ocrCalls = 0;
const origFetch = globalThis.fetch;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => { await engine.disconnect(); }, 60_000);

function configureVisual(model = VISUAL_MODEL, ocrModel = OCR_MODEL): void {
  configureGateway({
    embedding_model: model,
    embedding_multimodal_model: model,
    embedding_dimensions: 1024,
    expansion_model: ocrModel,
    base_urls: { voyage: 'https://image-budget.invalid', litellm: 'https://image-budget.invalid' },
    env: {
      VOYAGE_API_KEY: 'synthetic-image-budget-key',
      ANTHROPIC_API_KEY: 'synthetic-ocr-budget-key',
      LITELLM_API_KEY: 'synthetic-proxy-budget-key',
      LITELLM_BASE_URL: 'https://image-budget.invalid',
    },
  });
}

beforeEach(async () => {
  await resetPgliteState(engine);
  _resetOcrRunBudgetForTests();
  dir = mkdtempSync(join(tmpdir(), 'gbrain-image-consent-'));
  visualCalls = 0;
  ocrCalls = 0;
  await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [dir]);
  configureVisual();
  globalThis.fetch = (async (url: string | URL | Request) => {
    const target = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    if (!target.startsWith('https://image-budget.invalid/')) throw new Error(`Unexpected fixture transport: ${target}`);
    visualCalls++;
    return new Response(JSON.stringify({
      data: [{ embedding: Array.from({ length: 1024 }, () => visualCalls / 10), index: 0 }],
      model: 'voyage-multimodal-3',
      usage: { total_tokens: VISUAL_TOKENS },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  __setGenerateTextTransportForTests((async () => {
    ocrCalls++;
    return { text: OCR_TEXT, usage: OCR_USAGE };
  }) as never);
});

afterEach(() => {
  globalThis.fetch = origFetch;
  __setGenerateTextTransportForTests(null);
  resetGateway();
  _resetOcrRunBudgetForTests();
  rmSync(dir, { recursive: true, force: true });
});

async function fixture(ocr: boolean, fn: () => Promise<void>): Promise<void> {
  await withEnv({
    GBRAIN_HOME: join(dir, 'home'),
    GBRAIN_EMBEDDING_MULTIMODAL: 'true',
    GBRAIN_EMBEDDING_IMAGE_OCR: ocr ? 'true' : 'false',
    OPENAI_API_KEY: undefined,
    ANTHROPIC_API_KEY: undefined,
    VOYAGE_API_KEY: undefined,
    GOOGLE_GENERATIVE_AI_API_KEY: undefined,
  }, async () => {
    for (const slug of SLUGS) {
      const file = join(dir, slug);
      writeFileSync(file, PNG);
      expect((await importImageFile(engine, file, slug, { noEmbed: true })).status).toBe('imported');
    }
    await fn();
  });
}

function tracker(maxCostUsd: number, name = 'first'): BudgetTracker {
  return new BudgetTracker({ maxCostUsd, label: 'embed-images-consent', auditPath: join(dir, `${name}.jsonl`) });
}

function audit(name = 'first'): Array<{ event: string; model: string; estimated_input_tokens?: number; cumulative_cost_usd?: number }> {
  return readFileSync(join(dir, `${name}.jsonl`), 'utf8').trim().split('\n').map(line => JSON.parse(line));
}

async function imageState() {
  return engine.executeRaw<{ slug: string; has_vector: boolean; vector: string | null; knowledge_revision: string; text_projection_revision: string; compiled_truth: string }>(
    `SELECT p.slug, c.embedding_image IS NOT NULL AS has_vector, c.embedding_image::text AS vector,
      p.knowledge_revision, p.text_projection_revision, p.compiled_truth
      FROM pages p JOIN content_chunks c ON c.page_id = p.id
      WHERE p.source_id = 'default' AND p.page_kind = 'image' ORDER BY p.id`);
}

const sweep = (budget: BudgetTracker) => withBudgetTracker(budget,
  () => embedStaleImages(engine, { sourceId: 'default', dryRun: false }));
const remaining = () => embedStaleImages(engine, { sourceId: 'default', dryRun: true });

test('image cap preserves the installed vector and separately funded resume embeds exactly the remainder', async () => {
  await fixture(false, async () => {
    const budget = tracker(VISUAL_COST + EPSILON_USD);
    const first = await sweep(budget);
    expect(first).toMatchObject({ candidates: 3, rebuilt: 1, skipped: 0, missingFile: 0, failures: 0, failure_samples: [] });
    expect(first.budget_exhausted).toBeInstanceOf(BudgetExhausted);
    expect(first.budget_exhausted).toMatchObject({ reason: 'cost', cap: VISUAL_COST + EPSILON_USD, modelId: VISUAL_MODEL });
    expect(first.budget_exhausted!.spent).toBeCloseTo(VISUAL_COST, 12);
    expect(budget.snapshot().callsRecorded).toBe(1);
    expect(visualCalls).toBe(1);
    expect(ocrCalls).toBe(0);
    const state = await imageState();
    expect(state.map(row => [row.slug, row.has_vector])).toEqual([
      ['one.png', true], ['two.png', false], ['three.png', false],
    ]);
    expect(state[0].text_projection_revision).toBe(state[0].knowledge_revision);
    expect((await remaining()).candidates).toBe(2);
    const admissions = audit().filter(row => row.event.startsWith('reserve'));
    expect(admissions.map(row => row.event)).toEqual(['reserve', 'reserve_denied']);
    expect(admissions[1].cumulative_cost_usd).toBeCloseTo(VISUAL_COST, 12);

    const resumedBudget = tracker(0.1, 'resume');
    const resumed = await sweep(resumedBudget);
    expect(resumed).toMatchObject({ candidates: 2, rebuilt: 2, failures: 0 });
    expect(resumed.budget_exhausted).toBeUndefined();
    expect(visualCalls).toBe(3);
    expect(resumedBudget.snapshot().callsRecorded).toBe(2);
    expect(resumedBudget.totalSpent).toBeCloseTo(VISUAL_COST * 2, 12);
    const complete = await imageState();
    expect(complete[0]).toEqual(state[0]);
    expect(complete.map(row => row.has_vector)).toEqual([true, true, true]);
    expect((await remaining()).candidates).toBe(0);
  });
}, 60_000);

test('unpriced visual refusal remains a configuration stop and does not fail or revisit every image', async () => {
  await fixture(false, async () => {
    const unpricedModel = 'litellm:synthetic-unpriced-image';
    configureVisual(unpricedModel);
    const budget = tracker(0.1);
    const result = await sweep(budget);
    expect(result).toMatchObject({ candidates: 3, rebuilt: 0, skipped: 0, failures: 0, failure_samples: [] });
    expect(result.budget_exhausted).toMatchObject({ reason: 'no_pricing', modelId: unpricedModel });
    expect(result.budget_exhausted!.pricing).toBeDefined();
    expect(result.budget_exhausted!.fix).toBeDefined();
    expect(audit().filter(row => row.event.startsWith('reserve')).map(row => row.event)).toEqual(['reserve_no_pricing']);
    expect(budget.snapshot().callsRecorded).toBe(0);
    expect(visualCalls).toBe(0);
    expect((await imageState()).map(row => row.has_vector)).toEqual([false, false, false]);
    expect((await remaining()).candidates).toBe(3);

    configureVisual();
    expect(await sweep(tracker(0.1, 'resume'))).toMatchObject({ candidates: 3, rebuilt: 3, failures: 0 });
    expect(visualCalls).toBe(3);
    expect((await remaining()).candidates).toBe(0);
  });
}, 60_000);

test('successful paid OCR can consume the cap before visual transport and leaves every image resumable', async () => {
  await fixture(true, async () => {
    const initialState = await imageState();
    const budget = tracker(OCR_COST + EPSILON_USD);
    const first = await sweep(budget);
    expect(first).toMatchObject({ candidates: 3, rebuilt: 0, skipped: 0, failures: 0, failure_samples: [] });
    expect(first.budget_exhausted).toMatchObject({ reason: 'cost', modelId: VISUAL_MODEL });
    expect(first.budget_exhausted!.spent).toBeCloseTo(OCR_COST, 12);
    expect(budget.totalSpent).toBeCloseTo(OCR_COST, 12);
    expect(budget.snapshot().callsRecorded).toBe(1);
    expect(ocrCalls).toBe(1);
    expect(visualCalls).toBe(0);
    expect(audit().filter(row => row.event.startsWith('reserve')).map(row => [row.event, row.model])).toEqual([
      ['reserve', OCR_MODEL], ['reserve_denied', VISUAL_MODEL],
    ]);
    expect(await imageState()).toEqual(initialState);
    expect((await remaining()).candidates).toBe(3);

    const resumedBudget = tracker(0.1, 'resume');
    const resumed = await sweep(resumedBudget);
    expect(resumed).toMatchObject({ candidates: 3, rebuilt: 3, failures: 0 });
    expect(resumed.budget_exhausted).toBeUndefined();
    expect(ocrCalls).toBe(4);
    expect(visualCalls).toBe(3);
    expect(resumedBudget.snapshot().callsRecorded).toBe(6);
    expect(resumedBudget.totalSpent).toBeCloseTo((OCR_COST + VISUAL_COST) * 3, 12);
    expect((await imageState()).map(row => [row.has_vector, row.compiled_truth])).toEqual([
      [true, OCR_TEXT], [true, OCR_TEXT], [true, OCR_TEXT],
    ]);
    expect((await remaining()).candidates).toBe(0);
  });
}, 60_000);

test('refused OCR admission stops the sweep before either paid transport', async () => {
  await fixture(true, async () => {
    const initialState = await imageState();
    const budget = tracker(VISUAL_COST + EPSILON_USD);
    const result = await sweep(budget);
    expect(result).toMatchObject({ candidates: 3, rebuilt: 0, skipped: 0, failures: 0, failure_samples: [] });
    expect(result.budget_exhausted).toMatchObject({ reason: 'cost', modelId: OCR_MODEL, spent: 0 });
    expect(ocrCalls).toBe(0);
    expect(visualCalls).toBe(0);
    expect(budget.snapshot().callsRecorded).toBe(0);
    expect(audit().filter(row => row.event.startsWith('reserve')).map(row => [row.event, row.model])).toEqual([
      ['reserve_denied', OCR_MODEL],
    ]);
    expect(await imageState()).toEqual(initialState);
    expect((await remaining()).candidates).toBe(3);
  });
}, 60_000);

test('unpriced OCR stops before visual embedding and preserves the original configuration refusal', async () => {
  await fixture(true, async () => {
    const unpricedOcr = 'anthropic:synthetic-unpriced-ocr';
    configureVisual(VISUAL_MODEL, unpricedOcr);
    const initialState = await imageState();
    const budget = tracker(0.1);
    const result = await sweep(budget);
    expect(result).toMatchObject({ candidates: 3, rebuilt: 0, skipped: 0, failures: 0, failure_samples: [] });
    expect(result.budget_exhausted).toMatchObject({ reason: 'no_pricing', modelId: unpricedOcr, spent: 0 });
    expect(result.budget_exhausted!.pricing).toBeDefined();
    expect(result.budget_exhausted!.fix).toBeDefined();
    expect(ocrCalls).toBe(0);
    expect(visualCalls).toBe(0);
    expect(budget.snapshot().callsRecorded).toBe(0);
    expect(audit().filter(row => row.event.startsWith('reserve')).map(row => [row.event, row.model])).toEqual([
      ['reserve_no_pricing', unpricedOcr],
    ]);
    expect(await imageState()).toEqual(initialState);
    expect((await remaining()).candidates).toBe(3);
  });
}, 60_000);
