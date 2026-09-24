/**
 * Search configuration pin for retrieval proofs.
 *
 * hybridSearch re-reads search mode, per-key overrides, the embedding
 * column, adaptive return, intent patterns, and the multimodal model on
 * every call. A proof resolves that set once and passes it back in, then
 * hashes it into the before/after fingerprints. The hash also records
 * whether that resolution wired the production query expander.
 */

import { loadConfig, loadConfigWithEngine } from '../config.ts';
import type { BrainEngine } from '../engine.ts';
import { resolveEmbeddingColumn } from '../search/embedding-column.ts';
import {
  loadSearchModeConfig,
  resolveSearchMode,
  type ResolvedSearchKnobs,
  type SearchKeyOverrides,
} from '../search/mode.ts';
import {
  adaptiveReturnFromConfig,
  type AdaptiveReturnConfig,
} from '../search/return-policy.ts';
import type { ResolvedColumn } from '../types.ts';

/**
 * Stable id for `expandQuery` (`src/core/search/expansion.ts`), the expander
 * the query operation passes as `expandFn`. Proofs fingerprint this id when
 * the pinned mode enables expansion, and null when it does not.
 */
export const PROOF_EXPANSION_EXPANDER_ID = 'expandQuery';

/** Null when resolved knobs leave expansion off. Otherwise the production expander id. */
export function proofExpansionExpander(
  knobs: { expansion: boolean },
): typeof PROOF_EXPANSION_EXPANDER_ID | null {
  return knobs.expansion ? PROOF_EXPANSION_EXPANDER_ID : null;
}

/** Config-table keys hybrid search reads that are not folded into mode knobs. */
export const PROOF_SEARCH_RAW_KEYS = [
  'search.adaptive_return',
  'search.adaptive_return_entity_max',
  'search.adaptive_return_other_max',
  'search.adaptive_return_min_keep',
  'search.intent_patterns',
  'embedding_multimodal_model',
] as const;

export interface PinnedProofSearch {
  /** Raw `search.mode` value, or undefined when unset. */
  mode?: string;
  overrides: SearchKeyOverrides;
  embeddingColumn: ResolvedColumn;
  /** Resolved adaptive-return partial hybridSearch would apply. */
  adaptiveReturn: Partial<AdaptiveReturnConfig>;
  /** Raw `search.intent_patterns` value, or null when unset. */
  intentPatterns: string | null;
  /** Resolved multimodal model, or null when the loaded config leaves it unset. */
  embeddingMultimodalModel: string | null;
  /** Stable record folded into proof fingerprint sha256. */
  canonical: string;
}

function snapshotReader(snapshot: Record<string, string>) {
  return {
    async getConfig(key: string): Promise<string | null> {
      return Object.prototype.hasOwnProperty.call(snapshot, key) ? snapshot[key]! : null;
    },
    async getAllConfig(): Promise<Record<string, string>> {
      return { ...snapshot };
    },
  };
}

export interface ProofSearchLive {
  adaptiveReturn?: Partial<AdaptiveReturnConfig>;
  intentPatterns?: string | null;
  embeddingMultimodalModel?: string | null;
  /** Raw config-table values for PROOF_SEARCH_RAW_KEYS. Missing keys are null. */
  raw?: Record<string, string | null>;
}

function stableRecord(value: object | undefined): Record<string, unknown> {
  const src = (value ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src).sort()) out[key] = src[key];
  return out;
}

/** Same resolution hybridSearch uses when the caller does not pass per-call knobs. */
export function canonicalSearchConfig(
  knobs: ResolvedSearchKnobs,
  column: ResolvedColumn,
  live?: ProofSearchLive,
): string {
  const knobRecord = stableRecord(knobs as unknown as object);
  const raw: Record<string, string | null> = {};
  for (const key of PROOF_SEARCH_RAW_KEYS) raw[key] = live?.raw?.[key] ?? null;
  return JSON.stringify({
    knobs: knobRecord,
    embedding_column: {
      name: column.name,
      type: column.type,
      dimensions: column.dimensions,
      embeddingModel: column.embeddingModel,
    },
    adaptive_return: stableRecord(live?.adaptiveReturn),
    intent_patterns: live?.intentPatterns ?? null,
    embedding_multimodal_model: live?.embeddingMultimodalModel ?? null,
    raw,
    expansion_expander: proofExpansionExpander(knobs),
  });
}

/**
 * One snapshot of the DB-backed search settings a proof will use.
 * Mode, overrides, adaptive return, intent patterns, and the multimodal
 * model come from the config table (file plane wins where hybridSearch
 * merges it). The embedding column follows hybridSearch.
 */
export async function readProofSearchPin(engine: BrainEngine): Promise<PinnedProofSearch> {
  const snapshot = await engine.getAllConfig();
  const reader = snapshotReader(snapshot);
  const modeInput = await loadSearchModeConfig(reader);
  const knobs = resolveSearchMode({
    mode: modeInput.mode,
    overrides: modeInput.overrides,
  });
  const mergedCfg = await loadConfigWithEngine(reader).catch(() => null);
  const cfgForColumn = mergedCfg ?? loadConfig() ?? null;
  const embeddingColumn = cfgForColumn
    ? resolveEmbeddingColumn(undefined, cfgForColumn)
    : resolveEmbeddingColumn(undefined, { engine: 'pglite' });
  const adaptiveReturn = adaptiveReturnFromConfig(cfgForColumn as Record<string, unknown> | null);
  const intentPatterns = Object.prototype.hasOwnProperty.call(snapshot, 'search.intent_patterns')
    ? snapshot['search.intent_patterns']!
    : null;
  const embeddingMultimodalModel = cfgForColumn?.embedding_multimodal_model ?? null;
  const raw: Record<string, string | null> = {};
  for (const key of PROOF_SEARCH_RAW_KEYS) {
    raw[key] = Object.prototype.hasOwnProperty.call(snapshot, key) ? snapshot[key]! : null;
  }
  return {
    mode: modeInput.mode,
    overrides: modeInput.overrides ?? {},
    embeddingColumn,
    adaptiveReturn,
    intentPatterns,
    embeddingMultimodalModel,
    canonical: canonicalSearchConfig(knobs, embeddingColumn, {
      adaptiveReturn,
      intentPatterns,
      embeddingMultimodalModel,
      raw,
    }),
  };
}
