import type { BrainEngine } from './engine.ts';
import { buildBasenameIndex } from './link-extraction.ts';

interface SourceSlugIndex {
  count: number;
  hash: bigint;
  maxId: number;
  slugs: string[];
  index: Map<string, string[]>;
}

const sourceSlugIndexes = new WeakMap<BrainEngine, Map<string, Promise<SourceSlugIndex | null>>>();
const SLUG_FINGERPRINT = 'count(*)::int AS n, coalesce(sum(hashtextextended(slug, 0)), 0)::text AS h, coalesce(max(id), 0)::int AS m';

async function refreshSourceSlugIndex(engine: BrainEngine, sourceId: string, state: SourceSlugIndex | null): Promise<SourceSlugIndex> {
  if (state) {
    const [probe] = await engine.executeRaw<{ n: number; h: string; m: number; added: string[]; added_h: string }>(`SELECT ${SLUG_FINGERPRINT},
      coalesce(array_agg(slug) FILTER (WHERE id > $2), '{}') AS added, coalesce(sum(hashtextextended(slug, 0)) FILTER (WHERE id > $2), 0)::text AS added_h
      FROM pages WHERE source_id=$1`, [sourceId, state.maxId]);
    const hash = BigInt(probe!.h);
    if (!probe!.added.length && probe!.n === state.count && hash === state.hash) return state;
    if (probe!.n === state.count + probe!.added.length && hash === state.hash + BigInt(probe!.added_h)) {
      for (const slug of probe!.added) state.slugs.push(slug);
      return { count: probe!.n, hash, maxId: probe!.m, slugs: state.slugs, index: buildBasenameIndex(probe!.added, state.index) };
    }
  }
  const [all] = await engine.executeRaw<{ n: number; h: string; m: number; slugs: string[] }>(
    `SELECT ${SLUG_FINGERPRINT}, coalesce(array_agg(slug), '{}') AS slugs FROM pages WHERE source_id=$1`, [sourceId]);
  return { count: all!.n, hash: BigInt(all!.h), maxId: all!.m, slugs: all!.slugs, index: buildBasenameIndex(all!.slugs) };
}

/**
 * Every source slug, including deleted pages, matching the unfiltered slug read.
 * A fingerprint probe reuses unchanged sources, extends inserts, and rebuilds
 * after renames or deletions. The promise chain serializes users of one source.
 */
export async function sourceSlugIndex(engine: BrainEngine, sourceId: string): Promise<SourceSlugIndex> {
  const bySource = sourceSlugIndexes.get(engine) ?? new Map<string, Promise<SourceSlugIndex | null>>();
  sourceSlugIndexes.set(engine, bySource);
  const next = (bySource.get(sourceId) ?? Promise.resolve(null)).then(state => refreshSourceSlugIndex(engine, sourceId, state));
  bySource.set(sourceId, next.catch(() => null));
  return next;
}
