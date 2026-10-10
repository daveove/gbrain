/**
 * Image OCR through the real import boundary (importImageFile): the
 * GBRAIN_EMBEDDING_IMAGE_OCR opt-in, the hash-unchanged re-import that
 * retries OCR once it is wanted, and the #3973 per-run OCR ceiling
 * (config embedding_image_ocr_max_images / _max_usd with finite defaults;
 * over-cap skips OCR and bumps the `ocr_skipped_budget` counter that
 * doctor's ocr_health check surfaces).
 *
 * Keyless and offline: a synthetic gateway config makes the OCR model
 * available, the generateText transport is stubbed, and the Voyage
 * multimodal embed is a fetch stub. Every case uses unique image bytes.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  importImageFile,
  _resetOcrRunBudgetForTests,
  _getOcrRunBudgetForTests,
} from '../src/core/import-file.ts';
import { configureGateway, resetGateway, generateOcrText, withBudgetTracker, __setGenerateTextTransportForTests } from '../src/core/ai/gateway.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { BudgetExhausted, BudgetTracker } from '../src/core/budget/budget-tracker.ts';
import { withAIInvocationGuard } from '../src/core/ai/invocation-guard.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const OCR_TEXT = 'Synthetic whiteboard text';
const PROVIDER_KEYS = { OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, VOYAGE_API_KEY: undefined, GOOGLE_GENERATIVE_AI_API_KEY: undefined };

let engine: PGLiteEngine;
let dir: string;
let caseNo = 0;
let ocrCalls = 0;
let embedCalls = 0;
const origFetch = globalThis.fetch;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  _resetOcrRunBudgetForTests();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  _resetOcrRunBudgetForTests();
  dir = mkdtempSync(join(tmpdir(), 'gbrain-ocr-'));
  ocrCalls = 0;
  embedCalls = 0;
  configureGateway({
    embedding_model: 'voyage:voyage-multimodal-3',
    embedding_multimodal_model: 'voyage:voyage-multimodal-3',
    embedding_dimensions: 1024,
    expansion_model: 'anthropic:claude-haiku-4-5',
    env: { VOYAGE_API_KEY: 'test-key', ANTHROPIC_API_KEY: 'test-key' },
  });
  __setGenerateTextTransportForTests((async () => {
    ocrCalls++;
    return { text: OCR_TEXT, usage: { inputTokens: 10, outputTokens: 5 } };
  }) as never);
  globalThis.fetch = (async () => {
    embedCalls++;
    return new Response(JSON.stringify({
      data: [{ embedding: Array.from({ length: 1024 }, () => 0.1), index: 0 }], model: 'voyage-multimodal-3',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = origFetch;
  __setGenerateTextTransportForTests(null);
  resetGateway();
  rmSync(dir, { recursive: true, force: true });
});

function writeImage(): { file: string; rel: string; name: string } {
  caseNo++;
  const name = `case-${caseNo}.png`;
  const rel = `photos/${name}`;
  const file = join(dir, name);
  writeFileSync(file, Buffer.concat([PNG, Buffer.from(`unique-${caseNo}-${Date.now()}`)]));
  return { file, rel, name };
}

const importWith = (ocr: string | undefined, img: { file: string; rel: string }) =>
  withEnv({ ...PROVIDER_KEYS, GBRAIN_EMBEDDING_IMAGE_OCR: ocr }, () => importImageFile(engine, img.file, img.rel));

async function stored(slug: string) {
  const page = await engine.getPage(slug, { sourceId: 'default' });
  const [chunk] = await engine.executeRaw<{ chunk_text: string; has_vec: boolean }>(
    `SELECT c.chunk_text, c.embedding_image IS NOT NULL AS has_vec FROM content_chunks c JOIN pages p ON p.id = c.page_id WHERE p.slug = $1`, [slug]);
  return { page, chunk };
}

const counter = (key: string) => engine.getConfig(key);

describe('image OCR opt-in through importImageFile', () => {
  test('opt-in on: OCR runs once, its text becomes the page body and chunk text, and the run budget is charged', async () => {
    const img = writeImage();
    const result = await importWith('true', img);
    expect(result.status).toBe('imported');
    expect(ocrCalls).toBe(1);
    const { page, chunk } = await stored(img.rel);
    expect(page!.compiled_truth).toBe(OCR_TEXT);
    expect((page!.frontmatter as Record<string, unknown>).ocr_status).toBe('done');
    expect(chunk).toEqual({ chunk_text: OCR_TEXT, has_vec: true });
    expect(await counter('ocr_attempted')).toBe('1');
    expect(await counter('ocr_succeeded')).toBe('1');
    expect(_getOcrRunBudgetForTests().images).toBe(1);
  });

  test('opt-in off with the same OCR availability: no OCR attempt, no budget use, filename-only text', async () => {
    for (const value of [undefined, 'false', '1']) {
      const img = writeImage();
      const result = await importWith(value, img);
      expect(result.status).toBe('imported');
      const { page, chunk } = await stored(img.rel);
      expect(page!.compiled_truth).toBe('');
      expect((page!.frontmatter as Record<string, unknown>).ocr_status).toBeUndefined();
      expect(chunk).toEqual({ chunk_text: img.name, has_vec: true });
    }
    expect(ocrCalls).toBe(0);
    expect(embedCalls).toBe(3);
    expect(_getOcrRunBudgetForTests()).toEqual({ images: 0, estUsd: 0, warned: false });
    expect(await counter('ocr_attempted')).toBeFalsy();
  });

  test('unchanged bytes skip while OCR is off, re-import once OCR is wanted, then skip again', async () => {
    const img = writeImage();
    expect((await importWith(undefined, img)).status).toBe('imported');
    expect((await importWith(undefined, img)).status).toBe('skipped');
    expect(ocrCalls).toBe(0);

    expect((await importWith('true', img)).status).toBe('imported');
    expect(ocrCalls).toBe(1);
    expect((await stored(img.rel)).page!.compiled_truth).toBe(OCR_TEXT);

    expect((await importWith('true', img)).status).toBe('skipped');
    expect(ocrCalls).toBe(1);
  });
});

describe('per-run OCR budget gate (#3973)', () => {
  test('over the default image cap: skips OCR, bumps ocr_skipped_budget, never counts an attempt', async () => {
    _resetOcrRunBudgetForTests({ images: 200 });
    const first = writeImage();
    expect((await importWith('true', first)).status).toBe('imported');
    expect((await stored(first.rel)).page!.compiled_truth).toBe('');
    expect(ocrCalls).toBe(0);
    expect(await counter('ocr_skipped_budget')).toBe('1');
    expect(await counter('ocr_attempted')).toBeFalsy();
    expect(_getOcrRunBudgetForTests()).toMatchObject({ images: 200, warned: true });
    await importWith('true', writeImage());
    expect(await counter('ocr_skipped_budget')).toBe('2');
  });

  test('over the default estimated-USD cap trips independently of the image cap', async () => {
    _resetOcrRunBudgetForTests({ images: 1, estUsd: 1.0 });
    await importWith('true', writeImage());
    expect(ocrCalls).toBe(0);
    expect(await counter('ocr_skipped_budget')).toBe('1');
    expect(await counter('ocr_attempted')).toBeFalsy();
  });

  test('config lowers the image cap below the default', async () => {
    await engine.setConfig('embedding_image_ocr_max_images', '5');
    _resetOcrRunBudgetForTests({ images: 5 });
    await importWith('true', writeImage());
    expect(ocrCalls).toBe(0);
    expect(await counter('ocr_skipped_budget')).toBe('1');
  });

  test('config lowers the USD cap below the default', async () => {
    await engine.setConfig('embedding_image_ocr_max_usd', '0.01');
    _resetOcrRunBudgetForTests({ images: 1, estUsd: 0.02 });
    await importWith('true', writeImage());
    expect(ocrCalls).toBe(0);
    expect(await counter('ocr_skipped_budget')).toBe('1');
  });

  test('under the cap: OCR runs, consumes budget, and never bumps the skip counter', async () => {
    _resetOcrRunBudgetForTests({ images: 199, estUsd: 0.5 });
    await importWith('true', writeImage());
    expect(ocrCalls).toBe(1);
    expect(_getOcrRunBudgetForTests().images).toBe(200);
    expect(_getOcrRunBudgetForTests().estUsd).toBeCloseTo(0.502, 9);
    expect(await counter('ocr_skipped_budget')).toBeFalsy();
    expect(await counter('ocr_attempted')).toBe('1');
  });

  test('cap of 0 disables that ceiling (explicit unlimited opt-out)', async () => {
    await engine.setConfig('embedding_image_ocr_max_images', '0');
    await engine.setConfig('embedding_image_ocr_max_usd', '0');
    _resetOcrRunBudgetForTests({ images: 100_000, estUsd: 500 });
    await importWith('true', writeImage());
    expect(ocrCalls).toBe(1);
    expect(await counter('ocr_skipped_budget')).toBeFalsy();
    expect(_getOcrRunBudgetForTests().images).toBe(100_001);
  });
});


describe('OCR ambient spending admission through the gateway', () => {
  test.each([
    { maxCostUsd: 0, reason: 'cost' },
    { maxRuntimeMs: -1, reason: 'runtime' },
  ])('denies $reason before the OCR provider is called', async ({ reason, ...cap }) => {
    const tracker = new BudgetTracker({ label: 'ocr-denied', auditPath: join(dir, 'budget.jsonl'), ...cap });
    const error = await withBudgetTracker(tracker, () => generateOcrText(PNG, 'image/png')).catch(error => error);
    expect(error).toBeInstanceOf(BudgetExhausted);
    expect(error.reason).toBe(reason);
    expect(ocrCalls).toBe(0);
    expect(embedCalls).toBe(0);
    expect(tracker.snapshot().callsRecorded).toBe(0);
  });

  test('an unpriced configured OCR model preserves the refusal and pricing fix', async () => {
    configureGateway({
      embedding_model: 'voyage:voyage-multimodal-3',
      expansion_model: 'anthropic:claude-haiku-4-5',
      embedding_image_ocr_model: 'litellm:synthetic-unknown-ocr',
      env: { LITELLM_API_KEY: 'test-key', LITELLM_BASE_URL: 'http://localhost:4000' },
      base_urls: { litellm: 'http://localhost:4000' },
    });
    const tracker = new BudgetTracker({ label: 'ocr-no-pricing', maxCostUsd: 1, auditPath: join(dir, 'budget.jsonl') });
    const error = await withBudgetTracker(tracker, () => generateOcrText(PNG, 'image/png')).catch(error => error);
    expect(error).toBeInstanceOf(BudgetExhausted);
    expect(error.reason).toBe('no_pricing');
    expect(error.modelId).toBe('litellm:synthetic-unknown-ocr');
    expect(error.fix).toBeDefined();
    expect(error.pricing).toBeDefined();
    expect(ocrCalls).toBe(0);
    expect(embedCalls).toBe(0);
  });

  test('successful measured usage settles each OCR hold rather than leaking the projection', async () => {
    const tracker = new BudgetTracker({ label: 'ocr-settled', maxCostUsd: 0.03, auditPath: join(dir, 'budget.jsonl') });
    await withBudgetTracker(tracker, async () => {
      expect(await generateOcrText(PNG, 'image/png')).toBe(OCR_TEXT);
      expect(await generateOcrText(PNG, 'image/png')).toBe(OCR_TEXT);
    });
    expect(ocrCalls).toBe(2);
    expect(tracker.totalSpent).toBeCloseTo(0.00007, 9);
    expect(tracker.snapshot().models[0]).toMatchObject({
      touchpoint: 'ocr', input_tokens: 20, output_tokens: 10, attempts: 2, failed_calls: 0, cost_basis: 'measured',
    });
  });

  test('cached OCR input remains billed input when admitting the next paid request', async () => {
    __setGenerateTextTransportForTests((async () => {
      ocrCalls++;
      return { text: OCR_TEXT, usage: {
        inputTokens: 1200, outputTokens: 100,
        inputTokenDetails: { noCacheTokens: 200, cacheReadTokens: 700, cacheWriteTokens: 300 },
      } };
    }) as never);
    const tracker = new BudgetTracker({ label: 'ocr-cached', maxCostUsd: 0.023, auditPath: join(dir, 'budget.jsonl') });
    expect(await withBudgetTracker(tracker, () => generateOcrText(PNG, 'image/png'))).toBe(OCR_TEXT);
    expect(tracker.totalSpent).toBeCloseTo(0.0017, 12);
    const error = await withBudgetTracker(tracker, () => generateOcrText(PNG, 'image/png')).catch(error => error);
    expect(error).toMatchObject({ reason: 'cost' });
    expect(ocrCalls).toBe(1);
  });

  test.each([true, false])('failed OCR usage measured=%s settles and blocks later paid work', async (measured) => {
    const failure = Object.assign(new Error('synthetic OCR failure'),
      measured ? { usage: { inputTokens: 2000, outputTokens: 4096 } } : {});
    __setGenerateTextTransportForTests((async () => { ocrCalls++; throw failure; }) as never);
    const tracker = new BudgetTracker({ label: 'ocr-failed', maxCostUsd: 0.03, auditPath: join(dir, 'budget.jsonl') });
    await expect(withBudgetTracker(tracker, () => generateOcrText(PNG, 'image/png'))).rejects.toBe(failure);
    const row = tracker.snapshot().models[0];
    expect(row.touchpoint).toBe('ocr');
    expect(row.failed_calls).toBe(1);
    if (measured) {
      expect(row.input_tokens).toBe(2000);
      expect(row.output_tokens).toBe(4096);
    }
    expect(row.cost_basis).toBe(measured ? 'measured' : 'estimated');
    const error = await withBudgetTracker(tracker, () => generateOcrText(PNG, 'image/png')).catch(error => error);
    expect(error).toBeInstanceOf(BudgetExhausted);
    expect(error.reason).toBe('cost');
    expect(ocrCalls).toBe(1);
  });

  test('the actual SDK transport cannot spend on hidden retries under an ambient cap', async () => {
    __setGenerateTextTransportForTests(null);
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts++;
      return Response.json({ type: 'error', error: { type: 'rate_limit_error', message: 'synthetic throttling' } }, { status: 429 });
    }) as unknown as typeof fetch;
    const tracker = new BudgetTracker({ label: 'ocr-sdk-retry', maxCostUsd: 0.03, auditPath: join(dir, 'budget.jsonl') });
    await expect(withBudgetTracker(tracker, () => generateOcrText(PNG, 'image/png'))).rejects.toThrow();
    expect(attempts).toBe(1);
    expect(tracker.snapshot().models[0]).toMatchObject({ failed_calls: 1, attempts: 1, cost_basis: 'estimated' });
    const error = await withBudgetTracker(tracker, () => generateOcrText(PNG, 'image/png')).catch(error => error);
    expect(error).toBeInstanceOf(BudgetExhausted);
    expect(attempts).toBe(1);
  });
});

describe('OCR reservation cleanup on unpaid refusal', () => {
  test('policy denial preserves its error and releases admission for the next attempt', async () => {
    const tracker = new BudgetTracker({ label: 'ocr-policy', maxCostUsd: 0.03, auditPath: join(dir, 'budget.jsonl') });
    const refusal = new Error('synthetic OCR policy refusal');
    await expect(withBudgetTracker(tracker, () => withAIInvocationGuard(async () => { throw refusal; },
      () => generateOcrText(PNG, 'image/png')))).rejects.toBe(refusal);
    expect(ocrCalls).toBe(0);
    expect(tracker.snapshot().callsRecorded).toBe(0);
    expect(await withBudgetTracker(tracker, () => generateOcrText(PNG, 'image/png'))).toBe(OCR_TEXT);
    expect(ocrCalls).toBe(1);
  });
});
