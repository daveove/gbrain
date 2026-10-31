/**
 * Short-query lexical anchor (DAV-7120).
 *
 * A short name query ("Mandalorian", "Yoda agent") can have no useful
 * embedding: the vector arm returns semantic neighbours that never mention
 * the name (a person called Jedi for a Star Wars codename). Those rows win
 * the fused rank-1 slot on cosine plus backlink/adjacency boosts, while the
 * page that literally names the query sits at keyword #1 further down.
 *
 * The anchor keeps one guarantee and nothing else: when a query has at most
 * LEXICAL_ANCHOR_MAX_CONTENT_TOKENS content tokens, the fused rank-1 row got
 * no lexical vote (keyword, title or relational arm), and the strict keyword
 * arm matched something, the keyword arm's #1 page is lifted to rank 1. The
 * fused #1 drops to #2; every other position keeps its fused order. Queries
 * whose rank-1 row already carries a lexical vote, longer (paraphrase)
 * queries and queries with no strict keyword match are untouched, and a
 * keyword #1 that an earlier stage penalized (superseded, generated,
 * suspected injection) or an unverified stub is never lifted.
 *
 * Runs on the fused list before dedup and the reranker, so a working
 * cross-encoder still has the final say. `search.lexical_anchor=false`
 * turns it off.
 */

import type { BrainEngine } from '../engine.ts';
import type { SearchResult } from '../types.ts';
import { contentTokens, tokenizeTitle } from './title-match.ts';

export const LEXICAL_ANCHOR_KEY = 'search.lexical_anchor';

/** Longest query (content tokens, stopwords excluded) the anchor applies to. */
export const LEXICAL_ANCHOR_MAX_CONTENT_TOKENS = 3;

const pageKey = (r: SearchResult) => `${r.source_id ?? 'default'}::${r.slug}`;

export interface LexicalAnchorLists {
  keywordFusionList: readonly SearchResult[];
  titleFusionList: readonly SearchResult[];
  relationalList: readonly SearchResult[];
}

/**
 * The fused row to lift, or null when the anchor does not apply. Pure: reads
 * `fused` (sorted by score, descending) and the lexical lists that fused.
 */
export function findLexicalAnchor(fused: readonly SearchResult[], query: string, lists: LexicalAnchorLists): SearchResult | null {
  const queryTokens = contentTokens(tokenizeTitle(query)).length;
  if (fused.length < 2 || queryTokens === 0 || queryTokens > LEXICAL_ANCHOR_MAX_CONTENT_TOKENS) return null;
  const anchor = lists.keywordFusionList.find(r => r.keyword_relaxed !== true);
  if (!anchor) return null;
  const lexicalPages = new Set<string>();
  for (const list of [lists.keywordFusionList, lists.titleFusionList, lists.relationalList]) {
    for (const r of list) if (r.keyword_relaxed !== true) lexicalPages.add(pageKey(r));
  }
  if (lexicalPages.has(pageKey(fused[0]))) return null;
  const key = pageKey(anchor);
  const row = fused.find(r => r.chunk_id === anchor.chunk_id && pageKey(r) === key)
    ?? fused.find(r => pageKey(r) === key);
  // A row an earlier stage penalized (superseded, generated, suspected
  // injection) or never trusted (unverified stub) is not lifted: the anchor
  // must not cancel those safeguards.
  if (!row || row.superseded === true || row.supersede_penalty !== undefined || row.generated_demotion !== undefined
    || row.injection_suspected === true || row.unverified === true) return null;
  return row;
}

/**
 * Lift the keyword arm's #1 page above the fused rank-1 row (see header).
 * Mutates the row's score and stamps `lexical_anchor_boost`; caller re-sorts.
 */
export async function applyLexicalAnchor(
  engine: BrainEngine,
  fused: SearchResult[],
  query: string,
  lists: LexicalAnchorLists,
): Promise<void> {
  const row = findLexicalAnchor(fused, query, lists);
  if (!row || !(row.score > 0)) return;
  try {
    const setting = (await engine.getConfig(LEXICAL_ANCHOR_KEY))?.trim().toLowerCase();
    if (setting === 'false' || setting === '0' || setting === 'no' || setting === 'off') return;
  } catch {
    // Config plane down: keep the default (on).
  }
  const factor = (fused[0].score / row.score) * (1 + 1e-6);
  row.score *= factor;
  row.lexical_anchor_boost = factor;
}
