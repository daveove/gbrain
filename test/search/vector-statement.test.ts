import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { buildVectorSearchStatement, INDEX_WALK_MIN_SCOPE_SHARE, indexWalkOverfetch, SCOPE_SCAN_FIRST_MAX_CHUNKS, SCOPE_SCAN_MAX_CHUNKS, SCOPE_SCAN_MAX_SHARE, sourceScope, sourceScopeShare, vectorScopeLoader, type PageSourceStats, type VectorSearchStatementInput } from '../../src/core/search/vector-statement.ts';
import { _resetVectorLegacyGuardForTests, readVectorLegacyGuard, resolveVectorLegacyGuard } from '../../src/core/search/vector-legacy-guard.ts';
import { withEnv } from '../helpers/with-env.ts';

const indexedColumn = { name: 'embedding', type: 'vector' as const, dimensions: 1536, embeddingModel: 'openai:text-embedding-3-large' };
const wideColumn = { name: 'embedding', type: 'vector' as const, dimensions: 3072, embeddingModel: 'openai:text-embedding-3-large' };

function build(overrides: Partial<VectorSearchStatementInput['opts']> = {}, dialect: 'postgres' | 'pglite' = 'postgres', scopeShare?: number, scopeChunks?: number) {
  return buildVectorSearchStatement({ dialect, embedding: new Float32Array([1, 0, 0]), limit: 10, offset: 0, opts: { embeddingColumn: indexedColumn, ...overrides }, scope: scopeShare === undefined ? undefined : { share: scopeShare, chunks: scopeChunks } });
}

describe('vector statement parameters', () => {
  test('parameters bind the vector, filters, model and the three limits in order', () => {
    const stmt = build({ type: 'note', sourceId: 'default', limit: 10 });
    expect(stmt.params).toEqual(['[1,0,0]', 'note', 'default', 'openai:text-embedding-3-large', 100, 10, 0]);
    expect(stmt.innerLimitIdx).toBe(4);
    expect(stmt.innerLimit).toBe(100);
  });
});


describe('source scope strategy: walk overfetch, walk skip and scope scan', () => {
  const stats: PageSourceStats = { sources: ['notes', 'sessions', 'small'], freqs: [0.7, 0.25, 0.01], n_distinct: 5, null_frac: 0, reltuples: 1000, chunk_reltuples: 200_000 };

  test('the walk over-fetches about INDEX_WALK_OVERFETCH in-scope rows per window slot', () => {
    expect(indexWalkOverfetch(undefined)).toBe(2);
    expect(indexWalkOverfetch(1)).toBe(2);
    expect(indexWalkOverfetch(0.5)).toBe(4);
    expect(indexWalkOverfetch(0.16)).toBe(13);
    expect(indexWalkOverfetch(INDEX_WALK_MIN_SCOPE_SHARE)).toBe(50);
    expect(indexWalkOverfetch(INDEX_WALK_MIN_SCOPE_SHARE / 10)).toBe(50);
  });


  test('a scope share below the walk threshold omits the walk; without chunk statistics it keeps only the joined statement', () => {
    for (const dialect of ['postgres', 'pglite'] as const) {
      const sparse = build({ sourceId: 'small', excludePrivate: true }, dialect, INDEX_WALK_MIN_SCOPE_SHARE / 2);
      expect(sparse.indexWalkSql).toBeUndefined();
      expect(sparse.scopeScanSql).toBeUndefined();
    }
  });

  test('a scope of at most SCOPE_SCAN_FIRST_MAX_CHUNKS runs the scope scan instead of the walk', () => {
    const small = build({ sourceId: 'small' }, 'postgres', 0.2, SCOPE_SCAN_FIRST_MAX_CHUNKS);
    expect(small.scopeScanSql).toBeDefined();
    expect(small.indexWalkSql).toBeUndefined();
    const narrowed = build({ sourceId: 'small', type: 'note' }, 'postgres', 0.01, 500);
    expect(narrowed.scopeScanSql).toBeDefined();
  });

  test('a mid-size scope runs the walk first and keeps the scope scan as its fallback; larger, wider or unindexed scopes get no scan', () => {
    const mid = build({ sourceId: 'sessions' }, 'postgres', 0.25, SCOPE_SCAN_MAX_CHUNKS);
    expect(mid.indexWalkSql).toBeDefined();
    expect(mid.scopeScanSql).toBeDefined();
    expect(build({ sourceId: 'sessions' }, 'postgres', 0.25, SCOPE_SCAN_MAX_CHUNKS + 1).scopeScanSql).toBeUndefined();
    expect(build({ sourceId: 'notes' }, 'postgres', SCOPE_SCAN_MAX_SHARE, 1_000).scopeScanSql).toBeUndefined();
    expect(build({ sourceId: 'small' }, 'postgres', 0.01).scopeScanSql).toBeUndefined();
    expect(build({ sourceId: 'small', vectorLegacyGuard: true }, 'postgres', 0.01, 500).scopeScanSql).toBeUndefined();
    expect(build({ sourceId: 'small', embeddingColumn: wideColumn }, 'postgres', 0.01, 500).scopeScanSql).toBeUndefined();
  });


  test('scope share sums the planner frequencies of the scoped sources', () => {
    expect(sourceScopeShare(stats, { sourceId: 'sessions' })).toBe(0.25);
    expect(sourceScopeShare(stats, { sourceIds: ['notes', 'sessions', 'notes'] })).toBeCloseTo(0.95);
    expect(sourceScopeShare(stats, { sourceIds: ['small'], sourceId: 'notes' })).toBe(0.01);
    // Unlisted sources split what the MCV list leaves: (1 - 0.96) / (5 - 3).
    expect(sourceScopeShare(stats, { sourceId: 'missing' })).toBeCloseTo(0.02);
    // A negative n_distinct is a fraction of the row estimate.
    expect(sourceScopeShare({ ...stats, n_distinct: -0.005 }, { sourceId: 'missing' })).toBeCloseTo(0.04 / 2);
    expect(sourceScopeShare({ sources: null, freqs: null, n_distinct: 4, null_frac: 0, reltuples: 100 }, { sourceId: 'x' })).toBe(0.25);
  });

  test('scope chunks are the share of content_chunks reltuples, absent when chunks were never analyzed', () => {
    expect(sourceScope(stats, { sourceId: 'sessions' })).toEqual({ share: 0.25, chunks: 50_000 });
    expect(sourceScope({ ...stats, chunk_reltuples: -1 }, { sourceId: 'sessions' })).toEqual({ share: 0.25 });
    expect(sourceScope({ ...stats, chunk_reltuples: undefined }, { sourceId: 'sessions' })).toEqual({ share: 0.25 });
    expect(sourceScope(stats, {})).toBeUndefined();
  });

  test('a sampled chunk count replaces the share estimate; an empty sample falls back to it', () => {
    expect(sourceScope(stats, { sourceId: 'sessions' }, { pages: 250, sampled: 125, sample_chunks: 1_200 })).toEqual({ share: 0.25, chunks: 2_400 });
    expect(sourceScope(stats, { sourceId: 'sessions' }, { pages: 7_900, sampled: 416, sample_chunks: 3_922 })).toEqual({ share: 0.25, chunks: 74_480 });
    expect(sourceScope(stats, { sourceId: 'sessions' }, { pages: 0, sampled: 0, sample_chunks: 0 })).toEqual({ share: 0.25, chunks: 50_000 });
    expect(sourceScope({ ...stats, chunk_reltuples: -1 }, { sourceId: 'sessions' }, { pages: 0, sampled: 0, sample_chunks: 0 })).toEqual({ share: 0.25 });
  });

  test('a scope of long pages routes on its counted chunks: walk first with the scan as fallback instead of scan first', () => {
    const estimated = sourceScope(stats, { sourceId: 'sessions' })!;
    const counted = sourceScope(stats, { sourceId: 'sessions' }, { pages: 250, sampled: 250, sample_chunks: 100_000 })!;
    expect(estimated.chunks!).toBeLessThanOrEqual(SCOPE_SCAN_FIRST_MAX_CHUNKS * 2);
    expect(counted.chunks!).toBeGreaterThan(SCOPE_SCAN_FIRST_MAX_CHUNKS);
    expect(counted.chunks!).toBeLessThanOrEqual(SCOPE_SCAN_MAX_CHUNKS);
    const scanFirst = buildVectorSearchStatement({ dialect: 'postgres', embedding: new Float32Array([1, 0, 0]), limit: 10, offset: 0, opts: { embeddingColumn: indexedColumn, sourceId: 'sessions' }, scope: { share: 0.25, chunks: SCOPE_SCAN_FIRST_MAX_CHUNKS } });
    const walkFirst = buildVectorSearchStatement({ dialect: 'postgres', embedding: new Float32Array([1, 0, 0]), limit: 10, offset: 0, opts: { embeddingColumn: indexedColumn, sourceId: 'sessions' }, scope: counted });
    expect([!!scanFirst.indexWalkSql, !!scanFirst.scopeScanSql]).toEqual([false, true]);
    expect([!!walkFirst.indexWalkSql, !!walkFirst.scopeScanSql]).toEqual([true, true]);
  });

  test('the loader counts chunks only for scopes under SCOPE_SCAN_MAX_SHARE, in the background, once a minute per scope, and keeps the estimate on a failed count', async () => {
    const asked: string[][] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const scope = vectorScopeLoader(async () => [stats], async ids => { asked.push(ids); await gate; return [{ pages: 250, sampled: 250, sample_chunks: 90_000 }]; });
    expect(await scope({ sourceIds: ['notes'] })).toEqual({ share: 0.7, chunks: 140_000 });
    expect(asked).toEqual([]);
    // The first search routes on the share estimate while the count runs.
    expect(await scope({ sourceId: 'sessions' })).toEqual({ share: 0.25, chunks: 50_000 });
    expect(await scope({ sourceIds: ['sessions', 'sessions'] })).toEqual({ share: 0.25, chunks: 50_000 });
    expect(asked).toEqual([['sessions']]);
    release();
    await Bun.sleep(0);
    expect(await scope({ sourceId: 'sessions' })).toEqual({ share: 0.25, chunks: 90_000 });
    await scope({ sourceIds: ['small', 'sessions'] });
    await Bun.sleep(0);
    expect((await scope({ sourceIds: ['sessions', 'small'] }))?.chunks).toBe(90_000);
    expect(asked).toEqual([['sessions'], ['small', 'sessions']]);
    const now = performance.now();
    const clock = spyOn(performance, 'now').mockReturnValue(now + 61_000);
    try {
      // A refresh keeps routing on the last count until it lands.
      expect((await scope({ sourceId: 'sessions' }))?.chunks).toBe(90_000);
      expect(asked).toHaveLength(3);
    } finally {
      clock.mockRestore();
    }
    const failing = vectorScopeLoader(async () => [stats], async () => { throw new Error('canceling statement due to statement timeout'); });
    await failing({ sourceId: 'sessions' });
    await Bun.sleep(0);
    expect(await failing({ sourceId: 'sessions' })).toEqual({ share: 0.25, chunks: 50_000 });
  });

  test('no scope or no statistics leaves the walk on', () => {
    expect(sourceScopeShare(stats, {})).toBeUndefined();
    expect(sourceScopeShare(stats, { sourceIds: [] })).toBeUndefined();
    expect(sourceScopeShare(undefined, { sourceId: 'small' })).toBeUndefined();
    expect(build({ sourceId: 'small' }, 'postgres', undefined).indexWalkSql).toBeDefined();
  });

  test('the loader reads statistics only for scoped searches, once a minute, and treats a failed read as unknown', async () => {
    let reads = 0;
    const scope = vectorScopeLoader(async () => { reads++; return [stats]; });
    expect(await scope({})).toBeUndefined();
    expect(await scope(undefined)).toBeUndefined();
    expect(reads).toBe(0);
    expect(await scope({ sourceId: 'small' })).toEqual({ share: 0.01, chunks: 2_000 });
    expect((await scope({ sourceIds: ['notes'] }))?.share).toBe(0.7);
    expect(reads).toBe(1);
    const now = performance.now();
    const clock = spyOn(performance, 'now').mockReturnValue(now + 61_000);
    try {
      expect((await scope({ sourceId: 'small' }))?.share).toBe(0.01);
      expect(reads).toBe(2);
    } finally {
      clock.mockRestore();
    }
    const failing = vectorScopeLoader(async () => { throw new Error('permission denied for pg_stats'); });
    expect(await failing({ sourceId: 'small' })).toBeUndefined();
    const empty = vectorScopeLoader(async () => []);
    expect(await empty({ sourceId: 'small' })).toBeUndefined();
  });
});

describe('vector legacy guard setting', () => {
  afterEach(() => _resetVectorLegacyGuardForTests());

  test('env wins over config, and config enables it when env is unset', async () => {
    await withEnv({ GBRAIN_VECTOR_LEGACY_GUARD: undefined }, async () => {
      expect(readVectorLegacyGuard(null)).toEqual({ enabled: false, via: null });
      expect(readVectorLegacyGuard({ search: { vector_legacy_guard: true } })).toEqual({ enabled: true, via: 'config' });
    });
    await withEnv({ GBRAIN_VECTOR_LEGACY_GUARD: '1' }, async () => {
      expect(readVectorLegacyGuard(null)).toEqual({ enabled: true, via: 'env' });
    });
    await withEnv({ GBRAIN_VECTOR_LEGACY_GUARD: '0' }, async () => {
      expect(readVectorLegacyGuard({ search: { vector_legacy_guard: true } })).toEqual({ enabled: false, via: 'env' });
    });
  });

  test('resolves once per process and logs activation once to stderr', async () => {
    const stderr = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await withEnv({ GBRAIN_VECTOR_LEGACY_GUARD: 'true' }, async () => {
        expect(resolveVectorLegacyGuard(null)).toBe(true);
        expect(resolveVectorLegacyGuard(null)).toBe(true);
      });
      await withEnv({ GBRAIN_VECTOR_LEGACY_GUARD: undefined }, async () => {
        expect(resolveVectorLegacyGuard(null)).toBe(true);
      });
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(String(stderr.mock.calls[0][0])).toStartWith('[gbrain] vector legacy guard active');
    } finally {
      stderr.mockRestore();
    }
  });
});
