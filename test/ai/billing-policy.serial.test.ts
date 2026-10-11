/**
 * ai_billing=subscription (src/core/ai/billing-policy.ts): paid model APIs are
 * refused before any request; text defaults move to codex-cli. `fetch` is
 * replaced with a counter that throws, so a reached network is a failure.
 * Serial: patches globalThis.fetch and process.env.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from '../helpers/with-env.ts';
import {
  PaidModelApiDisabledError,
  modelApiAllowed,
  resolveAIBilling,
} from '../../src/core/ai/billing-policy.ts';
import { chat, configureGateway, diagnoseEmbedding, embed, expand, isAvailable, resetGateway } from '../../src/core/ai/gateway.ts';
import { buildGatewayConfig } from '../../src/core/ai/build-gateway-config.ts';
import { invokeAI } from '../../src/core/ai/invocation-guard.ts';
import { resolveTierDefault, SUBSCRIPTION_TIER_DEFAULTS } from '../../src/core/model-config.ts';
import { reservationCostUsd } from '../../src/core/budget/reservation-cost.ts';
import { formatEmbeddingCredsError } from '../../src/core/embed-preflight.ts';
import { transcribe } from '../../src/core/transcription.ts';

const realFetch = globalThis.fetch;
let fetches = 0;

beforeEach(() => {
  fetches = 0;
  globalThis.fetch = (async () => { fetches++; throw new Error('network must not be reached'); }) as unknown as typeof fetch;
  resetGateway();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  resetGateway();
});

const subscriptionGateway = () => configureGateway({
  embedding_model: 'openai:text-embedding-3-large',
  embedding_dimensions: 1536,
  chat_model: 'openai:gpt-5.6-terra',
  expansion_model: 'openai:gpt-5.6-luna',
  env: { OPENAI_API_KEY: 'sk-test-not-real', ANTHROPIC_API_KEY: 'sk-ant-test-not-real' },
  ai_billing: 'subscription',
});

describe('resolveAIBilling', () => {
  test('api by default; either plane selecting subscription wins; unknown values fail closed', () => {
    expect(resolveAIBilling(null, {})).toBe('api');
    expect(resolveAIBilling({ ai_billing: 'api' }, { GBRAIN_AI_BILLING: 'api' })).toBe('api');
    expect(resolveAIBilling({ ai_billing: 'subscription' }, {})).toBe('subscription');
    expect(resolveAIBilling(null, { GBRAIN_AI_BILLING: 'subscription' })).toBe('subscription');
    // An inherited env value can never re-enable paid APIs the file disabled.
    expect(resolveAIBilling({ ai_billing: 'subscription' }, { GBRAIN_AI_BILLING: 'api' })).toBe('subscription');
    expect(resolveAIBilling({ ai_billing: 'paid-please' }, {})).toBe('subscription');
  });

  test('buildGatewayConfig folds the file + env policy, omitting the api default', async () => {
    await withEnv({ GBRAIN_AI_BILLING: 'subscription' }, () => {
      expect(buildGatewayConfig({ engine: 'pglite' }).ai_billing).toBe('subscription');
    });
    await withEnv({ GBRAIN_AI_BILLING: undefined, GBRAIN_HOME: mkdtempSync(join(tmpdir(), 'billing-home-')) }, () => {
      expect('ai_billing' in buildGatewayConfig({ engine: 'pglite' })).toBe(false);
    });
  });

  test('subscription allows only subscription CLIs and local inference', () => {
    expect(modelApiAllowed('codex-cli:gpt-5.6-terra', 'subscription')).toBe(true);
    expect(modelApiAllowed('claude-cli:claude-sonnet-4-6', 'subscription')).toBe(true);
    expect(modelApiAllowed('ollama:llama3', 'subscription')).toBe(true);
    for (const paid of ['openai:text-embedding-3-large', 'openai:gpt-5.6-terra', 'anthropic:claude-sonnet-4-6',
      'voyage:voyage-4', 'openrouter:openai/gpt-5.2', 'litellm:gpt-5.4', 'not-a-provider:x', 'bare-model']) {
      expect(modelApiAllowed(paid, 'subscription')).toBe(false);
      expect(modelApiAllowed(paid, 'api')).toBe(true);
    }
  });
});

describe('gateway under ai_billing=subscription', () => {
  test('a configured paid embedding is unavailable and cannot reach the network', async () => {
    subscriptionGateway();
    const d = diagnoseEmbedding();
    expect(d.ok).toBe(false);
    expect(!d.ok && d.reason).toBe('paid_api_disabled');
    expect(formatEmbeddingCredsError(d)).toContain('no request was made');
    expect(isAvailable('embedding')).toBe(false);
    await expect(embed(['Alice joined Acme.'])).rejects.toBeInstanceOf(PaidModelApiDisabledError);
    expect(fetches).toBe(0);
  });

  test('paid chat and expansion are refused before any request; no API fallback', async () => {
    subscriptionGateway();
    expect(isAvailable('chat')).toBe(false);
    expect(isAvailable('chat', 'anthropic:claude-sonnet-4-6')).toBe(false);
    expect(isAvailable('chat', 'codex-cli:gpt-5.6-terra')).toBe(true);
    expect(isAvailable('expansion')).toBe(false);
    await expect(chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(/Paid model APIs are disabled/);
    await expect(chat({ model: 'anthropic:claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(/Paid model APIs are disabled/);
    expect(await expand('alice acme')).toEqual(['alice acme']);
    expect(fetches).toBe(0);
  });

  test('direct provider calls through invokeAI are refused (raw subagent / rerank / multimodal lanes)', async () => {
    subscriptionGateway();
    let ran = false;
    await expect(invokeAI({ operation: 'subagent_legacy', kind: 'chat', model: 'anthropic:claude-sonnet-4-6' },
      async () => { ran = true; return {}; }, () => null)).rejects.toBeInstanceOf(PaidModelApiDisabledError);
    expect(ran).toBe(false);
  });

  test('the api default keeps every recipe callable (policy is opt-in)', () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-test' } });
    expect(isAvailable('embedding')).toBe(true);
    expect(isAvailable('chat', 'openai:gpt-5.6-terra')).toBe(true);
  });
});

describe('tier defaults and pricing', () => {
  test('subscription text tiers resolve to codex-cli even with API keys present', () => {
    const keyed = { OPENAI_API_KEY: 'sk-test', ANTHROPIC_API_KEY: 'sk-ant-test' };
    expect(resolveTierDefault('reasoning', { ...keyed, GBRAIN_AI_BILLING: 'subscription' })).toBe('codex-cli:gpt-5.6-terra');
    expect(resolveTierDefault('utility', { ...keyed, GBRAIN_AI_BILLING: 'subscription' })).toBe(SUBSCRIPTION_TIER_DEFAULTS.utility);
    expect(resolveTierDefault('deep', keyed, 'subscription')).toBe(SUBSCRIPTION_TIER_DEFAULTS.deep);
    expect(resolveTierDefault('reasoning', keyed)).toBe('anthropic:claude-sonnet-4-6');
  });

  test('codex-cli chat prices at zero marginal spend, so dollar caps admit it', () => {
    expect(reservationCostUsd('codex-cli:gpt-5.6-terra', 'chat', 50_000, 12_000)).toBe(0);
  });
});

describe('transcription', () => {
  test('paid speech APIs are refused before a key is read or a request is made', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'billing-audio-'));
    const audio = join(dir, 'clip.mp3');
    writeFileSync(audio, 'not really audio');
    try {
      await withEnv({ GBRAIN_AI_BILLING: 'subscription', OPENAI_API_KEY: 'sk-test' }, async () => {
        await expect(transcribe(audio, { provider: 'openai' })).rejects.toBeInstanceOf(PaidModelApiDisabledError);
      });
      expect(fetches).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
