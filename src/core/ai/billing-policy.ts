/**
 * Model billing policy: may this process call a paid, per-token model API?
 *
 * `ai_billing` (file plane, ~/.gbrain/config.json) and `GBRAIN_AI_BILLING`
 * (env) select it. `api` (the default) keeps every recipe callable.
 * `subscription` allows only recipes that bill a logged-in subscription CLI
 * (`codex-cli`, `claude-cli`) or run on local inference; every other recipe
 * (OpenAI, Anthropic, Google, Voyage, OpenRouter, LiteLLM, ...) is refused
 * BEFORE any request is built, for chat, expansion, OCR, embedding,
 * multimodal, rerank and transcription alike.
 *
 * Either plane selecting `subscription` wins: an inherited env value can
 * never re-enable paid APIs that the config file disabled, and vice versa.
 * Any value other than `api` fails closed to `subscription`. The DB config
 * plane is deliberately NOT read: a mounted or shared brain must never be
 * able to switch this process onto a paid API.
 *
 * The refusal is an AIConfigError that is NOT an invocation-guard policy
 * refusal, so callers that already degrade on a missing provider (fact
 * embeddings land with a NULL vector for the stale-embedding backfill,
 * hybrid search keeps its keyword leg) degrade the same way here, and
 * stored vectors plus the configured embedding identity are never touched.
 */
import type { Recipe } from './types.ts';
import { AIConfigError } from './errors.ts';
import { resolveRecipe } from './model-resolver.ts';

export type AIBilling = 'api' | 'subscription';

export const AI_BILLING_ENV = 'GBRAIN_AI_BILLING';

/** Recipes billed through a logged-in subscription CLI, never per token. */
const SUBSCRIPTION_IMPLEMENTATIONS: Partial<Record<Recipe['implementation'], true>> = { 'codex-cli': true, 'claude-cli': true };

/** Local-inference recipes: no provider account, no per-token bill. */
const LOCAL_RECIPE_IDS: Record<string, true> = { ollama: true, 'llama-server': true, 'llama-server-reranker': true, lmstudio: true };

function selects(raw: unknown): AIBilling | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  return raw.trim().toLowerCase() === 'api' ? 'api' : 'subscription';
}

/** Resolve the policy from the file plane and env (see module header). */
export function resolveAIBilling(
  fileCfg: { ai_billing?: unknown } | null | undefined,
  env: Record<string, string | undefined> = process.env,
): AIBilling {
  const fromEnv = selects(env[AI_BILLING_ENV]);
  const fromFile = selects(fileCfg?.ai_billing);
  return fromEnv === 'subscription' || fromFile === 'subscription' ? 'subscription' : 'api';
}

let _active: AIBilling | null = null;

/** Installed by configureGateway; `null` clears it with the gateway state. */
export function setActiveAIBilling(billing: AIBilling | null): void {
  _active = billing;
}

/** The configured gateway's policy, else the env plane alone. */
export function activeAIBilling(): AIBilling {
  return _active ?? resolveAIBilling(null, process.env);
}

/** True when `recipe` bills per token through a provider API account. */
export function isPaidModelApi(recipe: Pick<Recipe, 'id' | 'implementation'>): boolean {
  return !SUBSCRIPTION_IMPLEMENTATIONS[recipe.implementation] && !LOCAL_RECIPE_IDS[recipe.id];
}

export class PaidModelApiDisabledError extends AIConfigError {
  constructor(model: string) {
    super(
      `Paid model APIs are disabled (ai_billing=subscription); refusing ${model} before any request.`,
      'Use a subscription or local model (e.g. codex-cli:gpt-5.6-terra after `codex login`). ' +
      'Embedding, image, speech and rerank have no subscription runtime; queued work stays queued.',
    );
    this.name = 'PaidModelApiDisabledError';
  }
}

/** True when the active policy refuses this recipe. */
export function paidModelApiBlocked(recipe: Pick<Recipe, 'id' | 'implementation'>, billing: AIBilling = activeAIBilling()): boolean {
  return billing === 'subscription' && isPaidModelApi(recipe);
}

/**
 * May `model` (`provider:model`) be called under `billing`? An unparseable
 * or unknown id is refused under `subscription`: the policy cannot prove it
 * is not a paid API.
 */
export function modelApiAllowed(model: string, billing: AIBilling = activeAIBilling()): boolean {
  if (billing !== 'subscription') return true;
  try {
    return !isPaidModelApi(resolveRecipe(model).recipe);
  } catch {
    return false;
  }
}

/** Throw before a provider call when the active policy refuses `model`. */
export function assertModelApiAllowed(model: string, billing: AIBilling = activeAIBilling()): void {
  if (!modelApiAllowed(model, billing)) throw new PaidModelApiDisabledError(model);
}
