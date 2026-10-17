/**
 * Keep one near-best semantic neighbor on the first page.
 *
 * Hybrid fusion ranks a page by how many arms vote. A page that is almost the
 * nearest embedding neighbor, and that the keyword arm cannot AND-match, sits
 * past the result limit while weaker lexical pages fill the top. This promotes
 * that one neighbor to rank 3. It does not change scores of other rows and it
 * does not run on later pages.
 */
import type { SearchResult } from '../types.ts';

/** Ignore neighbors below this raw query-chunk cosine. */
export const SEMANTIC_NEIGHBOR_FLOOR = 0.7;
/** A neighbor must be at least this close to the best cosine in the pool. */
export const SEMANTIC_NEIGHBOR_GAP = 0.02;

export interface SemanticNeighborDecision {
  action: 'promoted';
  slug: string;
  source_id: string;
  from_rank: number;
  cosine: number;
}

function cosineOf(row: SearchResult): number {
  return typeof row.cosine === 'number' && Number.isFinite(row.cosine) ? row.cosine : -1;
}

export function ensureSemanticNeighborSlot(
  pool: SearchResult[],
  limit: number,
  offset: number,
): { pool: SearchResult[]; decision?: SemanticNeighborDecision } {
  if (offset > 0 || limit < 3 || pool.length < 4) return { pool };
  let maxCosine = -1;
  for (const row of pool) maxCosine = Math.max(maxCosine, cosineOf(row));
  if (maxCosine < SEMANTIC_NEIGHBOR_FLOOR) return { pool };
  const cutoff = Math.max(SEMANTIC_NEIGHBOR_FLOOR, maxCosine - SEMANTIC_NEIGHBOR_GAP);
  const head = Math.min(3, limit);
  let bestAt = -1;
  for (let i = head; i < pool.length; i++) {
    const cosine = cosineOf(pool[i]);
    if (cosine < cutoff) continue;
    if (bestAt < 0 || cosine > cosineOf(pool[bestAt])) bestAt = i;
  }
  if (bestAt < 0) return { pool };
  const out = pool.slice();
  const [row] = out.splice(bestAt, 1);
  const insertAt = 2;
  const prev = out[insertAt - 1];
  const next = out[insertAt];
  let score = row.score;
  if (prev && !(score < prev.score)) score = prev.score * 0.999;
  if (next && score < next.score && prev && prev.score > next.score) {
    score = (prev.score + next.score) / 2;
  }
  const placed: SearchResult = score === row.score ? row : { ...row, score };
  out.splice(insertAt, 0, placed);
  return {
    pool: out,
    decision: {
      action: 'promoted',
      slug: row.slug,
      source_id: row.source_id ?? 'default',
      from_rank: bestAt,
      cosine: cosineOf(row),
    },
  };
}
