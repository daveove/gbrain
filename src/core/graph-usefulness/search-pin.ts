/**
 * Search configuration pin for retrieval proofs.
 *
 * hybridSearch re-reads search.mode, per-key overrides, and the embedding
 * column on every call. A proof resolves that set once and passes it back
 * in, then hashes it into the before/after fingerprints.
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
import type { ResolvedColumn } from '../types.ts';

export interface PinnedProofSearch {
  /** Raw `search.mode` value, or undefined when unset. */
  mode?: string;
  overrides: SearchKeyOverrides;
  embeddingColumn: ResolvedColumn;
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

/** Same resolution hybridSearch uses when the caller does not pass per-call knobs. */
export function canonicalSearchConfig(knobs: ResolvedSearchKnobs, column: ResolvedColumn): string {
  const knobRecord: Record<string, unknown> = {};
  for (const key of Object.keys(knobs).sort()) {
    knobRecord[key] = (knobs as unknown as Record<string, unknown>)[key];
  }
  return JSON.stringify({
    knobs: knobRecord,
    embedding_column: {
      name: column.name,
      type: column.type,
      dimensions: column.dimensions,
      embeddingModel: column.embeddingModel,
    },
  });
}

/**
 * One snapshot of the DB-backed search settings a proof will use.
 * Mode and overrides come from the config table. The embedding column
 * follows hybridSearch: DB plane merged over file config, then the resolver.
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
  return {
    mode: modeInput.mode,
    overrides: modeInput.overrides ?? {},
    embeddingColumn,
    canonical: canonicalSearchConfig(knobs, embeddingColumn),
  };
}
