/**
 * Fix wave 13 P1.18 (from PR #6400): OCR and multimodal embedding reserve on
 * the ambient BudgetTracker BEFORE the provider call, as embed() and chat do.
 * Protects: an exhausted tracker means zero OCR / multimodal provider calls;
 * OCR is sent with the explicit output bound its reservation holds; a
 * multimodal call settles at the provider's reported tokens when present;
 * outside a tracker nothing changes.
 * Seams: __setGenerateTextTransportForTests, a fetch stub (Voyage multimodal).
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configureGateway, embedMultimodal, expand, generateOcrText, isAvailable, resetGateway, withBudgetTracker, __setGenerateTextTransportForTests,
} from '../src/core/ai/gateway.ts';
import { BudgetExhausted, BudgetTracker } from '../src/core/budget/budget-tracker.ts';

const tmp = mkdtempSync(join(tmpdir(), 'gbrain-w13-reserve-'));
const tracker = (maxCostUsd?: number) => new BudgetTracker({ label: 'w13', auditPath: join(tmp, 'budget.jsonl'), ...(maxCostUsd !== undefined ? { maxCostUsd } : {}) });
const origFetch = globalThis.fetch;
afterEach(() => { __setGenerateTextTransportForTests(null); globalThis.fetch = origFetch; resetGateway(); });

describe('generateOcrText reserves before the call', () => {
  const ocrGateway = () => configureGateway({ expansion_model: 'anthropic:claude-haiku-4-5-20251001', env: { ANTHROPIC_API_KEY: 'sk-test-fake' } });
  test('an exhausted cap refuses with zero OCR calls; the call carries the bound it reserved', async () => {
    ocrGateway();
    const sent: Array<{ maxOutputTokens?: number }> = [];
    __setGenerateTextTransportForTests((async (opts: { maxOutputTokens?: number }) => { sent.push(opts); return { text: 'hi', usage: { inputTokens: 10, outputTokens: 2 } }; }) as never);
    await expect(withBudgetTracker(tracker(0.000001), () => generateOcrText(Buffer.from('x'), 'image/png'))).rejects.toBeInstanceOf(BudgetExhausted);
    expect(sent).toHaveLength(0);
    const t = tracker(1);
    await withBudgetTracker(t, () => generateOcrText(Buffer.from('x'), 'image/png'));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.maxOutputTokens).toBe(4096);
    expect(t.snapshot().callsRecorded).toBe(1);
  });
});

describe('generateOcrText excludes the text-only Codex adapter', () => {
  const codexModel = 'codex-cli:gpt-5.6-terra';
  const visionModel = 'anthropic:claude-haiku-4-5-20251001';
  const env = { ANTHROPIC_API_KEY: 'sk-test-fake', OPENAI_API_KEY: 'sk-test-fake' };

  for (const ai_billing of ['api', 'subscription'] as const) {
    test(`${ai_billing}: Codex expansion remains available without OCR generation, subprocesses or budget records`, async () => {
      configureGateway({ expansion_model: codexModel, ai_billing, env });
      const sent: Array<{ model: { provider: string; modelId: string }; prompt?: string }> = [];
      __setGenerateTextTransportForTests((async (opts: typeof sent[number]) => {
        sent.push(opts);
        return { text: '{"queries":["synthetic followup"]}', usage: { inputTokens: 10, outputTokens: 2 } };
      }) as never);
      const spawn = spyOn(childProcess, 'spawn').mockImplementation(() => { throw new Error('unexpected subprocess'); });
      try {
        const t = tracker(0);
        expect(isAvailable('expansion')).toBe(true);
        expect(await withBudgetTracker(t, () => generateOcrText(Buffer.from('synthetic image'), 'image/png'))).toBe('');
        expect(sent).toHaveLength(0);
        expect(spawn).not.toHaveBeenCalled();
        expect(t.snapshot().callsRecorded).toBe(0);
        expect(t.snapshot().models).toEqual([]);

        expect(await expand('synthetic query')).toEqual(['synthetic query', 'synthetic followup']);
        expect(sent).toHaveLength(1);
        expect(sent[0]!.model.provider).toBe('codex-cli');
        expect(sent[0]!.model.modelId).toBe('gpt-5.6-terra');
        expect(sent[0]!.prompt).toContain('synthetic query');
        expect(spawn).not.toHaveBeenCalled();
      } finally {
        spawn.mockRestore();
      }
    });

    test(`${ai_billing}: explicit capable OCR keeps billing policy and pre-call cap guards`, async () => {
      configureGateway({ expansion_model: codexModel, embedding_image_ocr_model: visionModel, ai_billing, env });
      const sent: Array<{ model: { modelId: string }; maxOutputTokens?: number; messages?: unknown }> = [];
      __setGenerateTextTransportForTests((async (opts: typeof sent[number]) => {
        sent.push(opts);
        return { text: '  synthetic text  ', usage: { inputTokens: 10, outputTokens: 2 } };
      }) as never);
      const capped = tracker(0.000001);
      if (ai_billing === 'api') {
        await expect(withBudgetTracker(capped, () => generateOcrText(Buffer.from('x'), 'image/png'))).rejects.toBeInstanceOf(BudgetExhausted);
      } else {
        expect(await withBudgetTracker(capped, () => generateOcrText(Buffer.from('x'), 'image/png'))).toBe('');
      }
      expect(sent).toHaveLength(0);
      expect(capped.snapshot().callsRecorded).toBe(0);

      const t = tracker(1);
      const text = await withBudgetTracker(t, () => generateOcrText(Buffer.from('x'), 'image/png'));
      if (ai_billing === 'subscription') {
        expect(text).toBe('');
        expect(sent).toHaveLength(0);
        expect(t.snapshot().callsRecorded).toBe(0);
      } else {
        expect(text).toBe('synthetic text');
        expect(sent).toHaveLength(1);
        expect(sent[0]!.model.modelId).toBe('claude-haiku-4-5-20251001');
        expect(sent[0]!.maxOutputTokens).toBe(4096);
        expect(sent[0]!.messages).toEqual(expect.arrayContaining([
          expect.objectContaining({ role: 'user', content: expect.arrayContaining([
            { type: 'image', image: 'data:image/png;base64,eA==' },
          ]) }),
        ]));
        expect(t.snapshot().models).toEqual([expect.objectContaining({
          touchpoint: 'ocr', model: visionModel, calls: 1, failed_calls: 0,
          input_tokens: 10, output_tokens: 2, cost_basis: 'measured',
        })]);
      }
    });
  }

  test('explicit Codex OCR never falls back to a capable expansion model', async () => {
    configureGateway({ expansion_model: visionModel, embedding_image_ocr_model: codexModel, ai_billing: 'api', env });
    let calls = 0;
    __setGenerateTextTransportForTests((async () => {
      calls++;
      return { text: 'must not run', usage: { inputTokens: 10, outputTokens: 2 } };
    }) as never);
    const t = tracker(0);
    expect(await withBudgetTracker(t, () => generateOcrText(Buffer.from('x'), 'image/png'))).toBe('');
    expect(calls).toBe(0);
    expect(t.snapshot().callsRecorded).toBe(0);
  });

  test('explicit capable OCR still throws and accounts for ordinary transport errors', async () => {
    configureGateway({ expansion_model: codexModel, embedding_image_ocr_model: visionModel, ai_billing: 'api', env });
    const failure = new Error('synthetic vision failure');
    __setGenerateTextTransportForTests(async () => { throw failure; });
    const t = tracker(1);
    await expect(withBudgetTracker(t, () => generateOcrText(Buffer.from('x'), 'image/png'))).rejects.toBe(failure);
    expect(t.snapshot().models).toEqual([expect.objectContaining({
      touchpoint: 'ocr', model: visionModel, calls: 1, failed_calls: 1, cost_basis: 'estimated',
    })]);
  });
});

describe('embedMultimodal reserves before the call', () => {
  const voyage = (usage?: number) => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ data: [{ embedding: Array.from({ length: 1024 }, () => 0.1) }], ...(usage ? { usage: { total_tokens: usage } } : {}) }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;
    configureGateway({ embedding_model: 'voyage:voyage-multimodal-3', embedding_multimodal_model: 'voyage:voyage-multimodal-3', embedding_dimensions: 1024, env: { VOYAGE_API_KEY: 'test-key' } });
    return () => calls;
  };
  const image = [{ kind: 'image_base64' as const, data: 'aGk=', mime: 'image/png' }];

  test('an exhausted cap refuses with zero provider calls', async () => {
    const calls = voyage();
    await expect(withBudgetTracker(tracker(0.000001), () => embedMultimodal(image))).rejects.toBeInstanceOf(BudgetExhausted);
    expect(calls()).toBe(0);
  });

  test('the reported tokens settle the reservation; an overrun stops the next call', async () => {
    const calls = voyage(1_000_000);
    const t = tracker(0.1);
    await withBudgetTracker(t, () => embedMultimodal(image));
    expect(t.totalSpent).toBeCloseTo(0.12, 6);
    await expect(withBudgetTracker(t, () => embedMultimodal(image))).rejects.toBeInstanceOf(BudgetExhausted);
    expect(calls()).toBe(1);
  });

  test('outside a tracker nothing changes', async () => {
    const calls = voyage();
    expect(await embedMultimodal(image)).toHaveLength(1);
    expect(calls()).toBe(1);
  });
});
