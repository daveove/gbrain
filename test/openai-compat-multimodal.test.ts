// v0.34.1 (#875): multimodal embedding for openai-compatible recipes via
// LiteLLM (or any other openai-compatible proxy). Sibling to
// voyage-multimodal.test.ts; covers the new embedMultimodalOpenAICompat
// path including D12 dim validation.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { configureGateway, embedMultimodal, embedMultimodalSafe, resetGateway, withBudgetTracker } from '../src/core/ai/gateway.ts';
import { AIConfigError, AITransientError } from '../src/core/ai/errors.ts';
import { BudgetExhausted, BudgetTracker } from '../src/core/budget/budget-tracker.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type FetchHandler = (url: string, init: RequestInit) => Promise<Response>;
let fetchHandler: FetchHandler | null = null;
const origFetch = globalThis.fetch;
let auditDir: string;

beforeEach(() => {
  auditDir = mkdtempSync(join(tmpdir(), 'gbrain-compat-budget-'));
  fetchHandler = null;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!fetchHandler) {
      throw new Error('fetch called but no handler installed');
    }
    return fetchHandler(typeof url === 'string' ? url : url.toString(), init ?? {});
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = origFetch;
  resetGateway();
  rmSync(auditDir, { recursive: true, force: true });
});

function configureLitellm(env: Record<string, string | undefined> = {}, dims = 1024) {
  configureGateway({
    embedding_model: 'litellm:gpt-4o-multimodal',
    embedding_dimensions: dims,
    env: {
      LITELLM_API_KEY: 'test-litellm-key',
      LITELLM_BASE_URL: 'http://localhost:4000',
      ...env,
    },
    base_urls: { litellm: 'http://localhost:4000' },
  });
}

function okResponse(dims: number, count: number = 1): Response {
  const vec = Array(dims).fill(0).map((_, i) => 0.001 * i);
  return new Response(
    JSON.stringify({ data: Array.from({ length: count }, () => ({ embedding: vec })) }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('embedMultimodal — openai-compat routing (#875)', () => {
  test('LiteLLM recipe accepts a single image input and returns one embedding', async () => {
    configureLitellm();
    let capturedUrl = '';
    let capturedBody: any = null;
    let capturedAuth = '';
    fetchHandler = async (url, init) => {
      capturedUrl = url;
      capturedAuth = (init.headers as Record<string, string>).Authorization ?? '';
      capturedBody = JSON.parse(init.body as string);
      return okResponse(1024, 1);
    };

    const result = await embedMultimodal([
      { kind: 'image_base64', data: 'fake-base64-bytes', mime: 'image/png' },
    ]);

    expect(result.length).toBe(1);
    expect(result[0].length).toBe(1024);
    expect(capturedUrl).toBe('http://localhost:4000/embeddings');
    expect(capturedAuth).toBe('Bearer test-litellm-key');
    expect(capturedBody.model).toBe('gpt-4o-multimodal');
    expect(capturedBody.input[0].type).toBe('image_url');
    expect(capturedBody.input[0].image_url.url).toBe('data:image/png;base64,fake-base64-bytes');
  });

  test('multiple inputs trigger sequential /embeddings calls', async () => {
    configureLitellm();
    let calls = 0;
    fetchHandler = async () => {
      calls += 1;
      return okResponse(1024, 1);
    };

    const result = await embedMultimodal([
      { kind: 'image_base64', data: 'img1', mime: 'image/jpeg' },
      { kind: 'image_base64', data: 'img2', mime: 'image/png' },
      { kind: 'image_base64', data: 'img3', mime: 'image/webp' },
    ]);

    expect(calls).toBe(3);
    expect(result.length).toBe(3);
  });

  test('LiteLLM without LITELLM_API_KEY still works (proxy may run unauthenticated)', async () => {
    configureGateway({
      embedding_model: 'litellm:multimodal-foo',
      embedding_dimensions: 768,
      env: { LITELLM_BASE_URL: 'http://localhost:4000' }, // no API key
      base_urls: { litellm: 'http://localhost:4000' },
    });
    let capturedAuth: string | null | undefined;
    fetchHandler = async (_url, init) => {
      capturedAuth = (init.headers as Record<string, string>).Authorization;
      return okResponse(768, 1);
    };
    const result = await embedMultimodal([{ kind: 'image_base64', data: 'x', mime: 'image/png' }]);
    expect(result.length).toBe(1);
    // defaultResolveAuth sends 'Bearer unauthenticated' when no api key is
    // configured — servers like Ollama / llama-server ignore the value but
    // the SDK contract still requires SOME Authorization header.
    expect(capturedAuth).toBe('Bearer unauthenticated');
  });

  test('D12 — provider returns wrong-dim vector throws AIConfigError', async () => {
    // Brain configured for 1024; provider returns 768. D12 catches the
    // mismatch BEFORE the vector lands in the DB column.
    configureLitellm({}, 1024);
    fetchHandler = async () => okResponse(768, 1);

    let caught: unknown;
    try {
      await embedMultimodal([{ kind: 'image_base64', data: 'x', mime: 'image/png' }]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AIConfigError);
    expect((caught as Error).message).toContain('768-dim vector');
    expect((caught as Error).message).toContain('expected 1024');
    expect((caught as Error).message).toContain('gpt-4o-multimodal');
  });

  test('D12 — default embedding_dimensions (1280 as of v0.36.0.0) applies when not explicitly set', async () => {
    // configureGateway normalizes embedding_dimensions to DEFAULT_EMBEDDING_DIMENSIONS
    // when unset. v0.36.0.0 flipped the default from 1536 (OpenAI) to 1280
    // (custom Matryoshka step). LiteLLM recipe's default_dims=0 so we fall back
    // to the brain's configured value. This test pins the "always validate
    // via the configured/default dim" contract — there is no skip-when-unset
    // path in practice because configureGateway always populates it.
    configureGateway({
      embedding_model: 'litellm:any-model',
      // intentionally NO embedding_dimensions → falls back to 1280
      env: { LITELLM_BASE_URL: 'http://localhost:4000' },
      base_urls: { litellm: 'http://localhost:4000' },
    });
    fetchHandler = async () => okResponse(1280, 1);
    const result = await embedMultimodal([{ kind: 'image_base64', data: 'x', mime: 'image/png' }]);
    expect(result.length).toBe(1);
    expect(result[0].length).toBe(1280);
  });

  test('provider returns 401 → AIConfigError with model id in message', async () => {
    configureLitellm();
    fetchHandler = async () =>
      new Response('invalid key', { status: 401, headers: { 'Content-Type': 'text/plain' } });

    let caught: unknown;
    try {
      await embedMultimodal([{ kind: 'image_base64', data: 'x', mime: 'image/png' }]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AIConfigError);
    expect((caught as Error).message).toContain('401');
  });

  test('provider returns 400 (model does not support multimodal) → AITransientError surfaces body', async () => {
    configureLitellm();
    fetchHandler = async () =>
      new Response('model does not support image inputs', { status: 400 });

    let caught: unknown;
    try {
      await embedMultimodal([{ kind: 'image_base64', data: 'x', mime: 'image/png' }]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AITransientError);
    expect((caught as Error).message).toContain('400');
    expect((caught as Error).message).toContain('model does not support image inputs');
  });

  test('malformed JSON response → AITransientError', async () => {
    configureLitellm();
    fetchHandler = async () =>
      new Response('not json', { status: 200, headers: { 'Content-Type': 'application/json' } });

    let caught: unknown;
    try {
      await embedMultimodal([{ kind: 'image_base64', data: 'x', mime: 'image/png' }]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AITransientError);
    expect((caught as Error).message).toContain('malformed JSON');
  });

  test('non-array embedding payload → AITransientError', async () => {
    configureLitellm();
    fetchHandler = async () =>
      new Response(JSON.stringify({ data: [{ embedding: 'not-array' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    let caught: unknown;
    try {
      await embedMultimodal([{ kind: 'image_base64', data: 'x', mime: 'image/png' }]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AITransientError);
    expect((caught as Error).message).toContain('non-array');
  });

  test('empty data array → AITransientError', async () => {
    configureLitellm();
    fetchHandler = async () =>
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    let caught: unknown;
    try {
      await embedMultimodal([{ kind: 'image_base64', data: 'x', mime: 'image/png' }]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AITransientError);
  });

  test('Voyage recipe still routes to /multimodalembeddings (regression)', async () => {
    // Ensure the new openai-compat route doesn't accidentally hijack Voyage.
    configureGateway({
      embedding_model: 'voyage:voyage-multimodal-3',
      embedding_dimensions: 1024,
      env: { VOYAGE_API_KEY: 'voyage-key' },
    });
    let capturedUrl = '';
    fetchHandler = async (url) => {
      capturedUrl = url;
      return okResponse(1024, 1);
    };

    await embedMultimodal([{ kind: 'image_base64', data: 'x', mime: 'image/png' }]);
    expect(capturedUrl).toContain('/multimodalembeddings');
  });
});

describe('openai-compatible multimodal ambient budget', () => {
  const image = { kind: 'image_base64' as const, data: 'c3ludGhldGlj', mime: 'image/png' };
  const pricingOverrides = { 'litellm:gpt-4o-multimodal': { input: 1, output: 1 } };

  test('unpriced paid model preserves no_pricing reason and fix through the safe path', async () => {
    configureLitellm();
    let calls = 0;
    fetchHandler = async () => { calls++; return okResponse(1024); };
    const tracker = new BudgetTracker({
      label: 'compat-no-pricing', maxCostUsd: 1, auditPath: join(auditDir, 'budget.jsonl'),
    });
    const error = await withBudgetTracker(tracker, () => embedMultimodalSafe([image, image])).catch(error => error);
    expect(error).toBeInstanceOf(BudgetExhausted);
    expect(error.reason).toBe('no_pricing');
    expect(error.modelId).toBe('litellm:gpt-4o-multimodal');
    expect(error.fix).toBeDefined();
    expect(error.pricing).toBeDefined();
    expect(calls).toBe(0);
    expect(tracker.snapshot().callsRecorded).toBe(0);
  });

  test('checks each individual request against measured spend and operator pricing', async () => {
    configureLitellm();
    let calls = 0;
    fetchHandler = async () => {
      calls++;
      return Response.json({ ...await okResponse(1024).json(), usage: { prompt_tokens: 1000, total_tokens: 1000 } });
    };
    const tracker = new BudgetTracker({
      label: 'compat-cap', maxCostUsd: 0.00160001, pricingOverrides, auditPath: join(auditDir, 'budget.jsonl'),
    });
    const error = await withBudgetTracker(tracker, () => embedMultimodal([image, image])).catch(error => error);
    expect(error).toBeInstanceOf(BudgetExhausted);
    expect(error.reason).toBe('cost');
    expect(calls).toBe(1);
    expect(tracker.totalSpent).toBeCloseTo(0.001, 9);
    expect(tracker.snapshot().models[0]).toMatchObject({
      touchpoint: 'embedding', input_tokens: 1000, output_tokens: 0, attempts: 1, cost_basis: 'measured',
    });
  });

  test('settling a smaller measured usage frees the outstanding projection', async () => {
    configureLitellm();
    let calls = 0;
    fetchHandler = async () => {
      calls++;
      return Response.json({ ...await okResponse(1024).json(), usage: { prompt_tokens: 100 } });
    };
    const tracker = new BudgetTracker({
      label: 'compat-release', maxCostUsd: 0.00171, pricingOverrides, auditPath: join(auditDir, 'budget.jsonl'),
    });
    await withBudgetTracker(tracker, () => embedMultimodal([image, image]));
    expect(calls).toBe(2);
    expect(tracker.snapshot().models[0]).toMatchObject({ input_tokens: 200, attempts: 2, cost_basis: 'measured' });
  });

  test.each([true, false])('paid error usage measured=%s settles before refusing another attempt', async (measured) => {
    configureLitellm();
    let calls = 0;
    fetchHandler = async () => {
      calls++;
      return Response.json({ error: 'synthetic overload', ...(measured ? { usage: { prompt_tokens: 2000 } } : {}) }, { status: 503 });
    };
    const tokens = measured ? 2000 : 1600;
    const tracker = new BudgetTracker({
      label: 'compat-failure', maxCostUsd: tokens / 1_000_000 + 0.00000001,
      pricingOverrides, auditPath: join(auditDir, 'budget.jsonl'),
    });
    await expect(withBudgetTracker(tracker, () => embedMultimodal([image]))).rejects.toBeInstanceOf(AITransientError);
    const error = await withBudgetTracker(tracker, () => embedMultimodalSafe([image, image])).catch(error => error);
    expect(error).toBeInstanceOf(BudgetExhausted);
    expect(calls).toBe(1);
    expect(tracker.snapshot().models[0]).toMatchObject({
      ...(measured ? { input_tokens: tokens } : {}), output_tokens: 0, failed_calls: 1, cost_basis: measured ? 'measured' : 'estimated',
    });
  });
});
