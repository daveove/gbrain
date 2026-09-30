import type { CyclePhase } from '../cycle.ts';

/**
 * Phase-scope taxonomy. `runCycle` enforces it for explicit non-default
 * sources: only source phases run there; mixed and global phases run once in
 * the default/global-maintenance lane.
 *
 * - source: safe to parallelize per source.
 * - global: must serialize across the brain.
 * - mixed: reads brain-wide input while writing pages, so it stays in the
 *   default/global-maintenance lane until decomposed. Includes the memory
 *   writers that already walk every source inside one invocation
 *   (consolidate, conversation_facts_backfill, enrich_thin): the daily
 *   maintenance job runs each once, and a per-source freshness job must
 *   not run them again. Global maintenance passes no source id, so
 *   consolidate still enumerates every source.
 */
export type PhaseScope = 'source' | 'global' | 'mixed';

export const PHASE_SCOPE: Record<CyclePhase, PhaseScope> = {
  lint: 'source',
  backlinks: 'source',
  sync: 'source',
  synthesize: 'mixed',
  extract: 'source',
  extract_facts: 'source',
  resolve_symbol_edges: 'global',
  patterns: 'mixed',
  recompute_emotional_weight: 'source',
  consolidate: 'mixed',
  propose_takes: 'source',
  grade_takes: 'global',
  calibration_profile: 'global',
  drift: 'global',
  embed: 'global',
  orphans: 'global',
  purge: 'global',
  'schema-suggest': 'source',
  extract_atoms: 'source',
  synthesize_concepts: 'global',
  conversation_facts_backfill: 'mixed',
  enrich_thin: 'mixed',
  skillopt: 'global',
};

/** Bounded deterministic phases that alone define source freshness. */
export const SOURCE_FRESHNESS_PHASES: CyclePhase[] = [
  'lint', 'backlinks', 'sync', 'extract', 'extract_facts',
  'recompute_emotional_weight',
];
