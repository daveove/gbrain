/**
 * #5824 correctness on PGLite: with content freshness filtered outside the
 * HNSW candidate CTE, a chunk whose text changed after embedding still never
 * reaches results, legacy NULL-hash chunks stay eligible, model mismatches
 * stay excluded, the pre-migration `$m IS NULL` branch is unchanged, and a
 * candidate window full of stale rows escalates instead of underfilling.
 * The Postgres side (plan proof, exact fallback) is
 * test/e2e/vector-plan-real-column-postgres.test.ts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import * as vectorPool from '../../src/core/search/vector-pool.ts';
import type { VectorPoolAttempt } from '../../src/core/search/vector-pool.ts';
import { buildVectorSearchStatement } from '../../src/core/search/vector-statement.ts';
import type { SearchOpts } from '../../src/core/types.ts';

const MODEL = 'test:vector-freshness';
const column = { name: 'embedding', type: 'vector' as const, dimensions: 8, embeddingModel: MODEL };
const query = new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]);
type PoolMeta = Parameters<NonNullable<SearchOpts['onVectorPoolMeta']>>[0];

let engine: PGLiteEngine;
const originalPool = vectorPool.searchVectorPool;
let poolSpy: ReturnType<typeof spyOn> | undefined;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw('DROP INDEX IF EXISTS idx_chunks_embedding');
  await engine.executeRaw('ALTER TABLE content_chunks ALTER COLUMN embedding TYPE vector(8)');
  await engine.executeRaw('CREATE INDEX idx_chunks_embedding ON content_chunks USING hnsw (embedding vector_cosine_ops)');
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

afterEach(() => {
  poolSpy?.mockRestore();
  poolSpy = undefined;
});

/** Pages `<prefix>-<i>`, one chunk each at angle `start + i * step` from the query. */
async function seed(prefix: string, count: number, start: number, step: number, chunk: { hash: 'current' | 'stale' | 'null'; model?: string }) {
  const hash = chunk.hash === 'current' ? 'md5(cc_text)' : chunk.hash === 'stale' ? `md5('text before the edit')` : 'NULL';
  await engine.executeRaw(`INSERT INTO pages (slug, source_id, type, title, compiled_truth, knowledge_revision, text_projection_revision, chunker_version)
    SELECT '${prefix}-' || i, 'default', 'note', '${prefix} ' || i, 'fixture', '00000000-0000-4000-8000-000000000001'::uuid,
      '00000000-0000-4000-8000-000000000001'::uuid, 4
    FROM generate_series(0, ${count - 1}) i`);
  await engine.executeRaw(`INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, model, embedded_text_hash, embedding)
    SELECT id, 0, cc_text, 'compiled_truth', $1, ${hash}, ARRAY[cos(a), sin(a), 0, 0, 0, 0, 0, 0]::real[]::vector
    FROM (SELECT p.id, '${prefix} chunk text ' || p.slug AS cc_text,
            ${start} + (split_part(p.slug, '-', 2)::int) * ${step} AS a
          FROM pages p WHERE p.slug LIKE '${prefix}-%') src`, [chunk.model ?? MODEL]);
}

async function reset() {
  await engine.executeRaw('DELETE FROM content_chunks');
  await engine.executeRaw('DELETE FROM pages');
  await engine.executeRaw(`DELETE FROM config WHERE key = 'embedding_migration.state'`);
}

/** Records the `run` attempts searchVector hands to searchVectorPool. */
function spyAttempts(): VectorPoolAttempt[] {
  const attempts: VectorPoolAttempt[] = [];
  poolSpy = spyOn(vectorPool, 'searchVectorPool').mockImplementation((limit, initial, iterative, indexed, kind, run, hasMore, onMeta) =>
    originalPool(limit, initial, iterative, indexed, kind, async attempt => { attempts.push(attempt); return run(attempt); }, hasMore, onMeta));
  return attempts;
}

describe('vector freshness outside the candidate CTE (PGLite)', () => {
  test('stale, mismatched and NULL-hash chunks keep their exact eligibility', async () => {
    await reset();
    await seed('stale', 3, 0.001, 0.001, { hash: 'stale' });
    await seed('mismatch', 3, 0.002, 0.001, { hash: 'current', model: 'test:other-model' });
    await seed('legacy', 2, 0.01, 0.001, { hash: 'null' });
    await seed('fresh', 20, 0.05, 0.001, { hash: 'current' });
    const expected = ['legacy-0', 'legacy-1', ...Array.from({ length: 8 }, (_, i) => `fresh-${i}`)];
    const actual = [];
    for (const vectorLegacyGuard of [false, true]) {
      const options = { limit: 10, embeddingColumn: column, vectorLegacyGuard };
      const native = (await engine.searchVector(query, options)).map(row => row.slug);
      const queries = [];
      for (const dialect of ['postgres', 'pglite'] as const) {
        const statement = buildVectorSearchStatement({ dialect, embedding: query, limit: 10, offset: 0, opts: options });
        const hits = (await engine.executeRaw<{ slug: string }>(statement.sql, statement.params)).map(row => row.slug);
        const exact = (await engine.executeRaw<{ slug: string }>(statement.exactSql, statement.params)).map(row => row.slug);
        const witness = await engine.executeRaw(statement.hasMoreSql, statement.params.slice(0, statement.innerLimitIdx + 1));
        queries.push({ dialect, hits, exact, witness });
      }
      actual.push({ vectorLegacyGuard, native, queries });
    }
    expect(actual).toEqual([false, true].map(vectorLegacyGuard => ({ vectorLegacyGuard, native: expected,
      queries: ['postgres', 'pglite'].map(dialect => ({ dialect, hits: expected, exact: expected, witness: [{ eligible: 22 }] })) })));
  }, 60_000);

  test('the pre-migration branch (no model, no migration state) is unchanged: every model and hash is eligible', async () => {
    await reset();
    await seed('stale', 2, 0.001, 0.001, { hash: 'stale' });
    await seed('mismatch', 2, 0.002, 0.001, { hash: 'current', model: 'test:other-model' });
    await seed('fresh', 10, 0.05, 0.001, { hash: 'current' });
    const preMigration = { ...column, embeddingModel: '' };
    const hits = await engine.searchVector(query, { limit: 4, embeddingColumn: preMigration });
    expect(hits.map(hit => hit.slug).sort()).toEqual(['mismatch-0', 'mismatch-1', 'stale-0', 'stale-1']);
    await engine.executeRaw(`INSERT INTO config (key, value) VALUES ('embedding_migration.state', '{}')`);
    expect(await engine.searchVector(query, { limit: 4, embeddingColumn: preMigration })).toEqual([]);
  }, 60_000);

  test('a candidate window full of stale chunks escalates and fills from current chunks', async () => {
    await reset();
    await seed('stale', 300, 0.0001, 0.0001, { hash: 'stale' });
    await seed('fresh', 30, 0.5, 0.001, { hash: 'current' });
    const attempts = spyAttempts();
    const events: PoolMeta[] = [];
    const hits = await engine.searchVector(query, { limit: 10, embeddingColumn: column, onVectorPoolMeta: meta => events.push(meta) });
    expect(hits.map(hit => hit.slug)).toEqual(Array.from({ length: 10 }, (_, i) => `fresh-${i}`));
    expect(attempts.map(attempt => attempt.innerLimit)).toEqual([100, 400]);
    expect(events).toEqual([]);

    const guarded = spyAttempts();
    const legacy = await engine.searchVector(query, { limit: 10, embeddingColumn: column, vectorLegacyGuard: true });
    expect(legacy.map(hit => hit.slug)).toEqual(hits.map(hit => hit.slug));
    expect(guarded.map(attempt => attempt.innerLimit)).toEqual([100]);
  }, 60_000);

  test('a stale wall beyond three escalations ends in the documented underfilled exit with only current chunks', async () => {
    await reset();
    await seed('stale', 6_500, 0.00001, 0.00001, { hash: 'stale' });
    await seed('fresh', 30, 0.5, 0.001, { hash: 'current' });
    const attempts = spyAttempts();
    const events: PoolMeta[] = [];
    const hits = await engine.searchVector(query, { limit: 10, embeddingColumn: column, onVectorPoolMeta: meta => events.push(meta) });
    expect(attempts.map(attempt => attempt.innerLimit)).toEqual([100, 400, 1_600, 6_400]);
    expect(hits).toEqual([]);
    expect(events).toEqual([{ underfilled: true, incomplete: true, reason: 'candidate_budget', escalations: 3, innerLimit: 6_400, candidatePool: 6_400, exactFallback: false }]);
  }, 120_000);
  test('since/until bounds keep the effective_date -> updated_at fallback and inclusivity', async () => {
    await reset();
    await seed('dated', 4, 0.01, 0.001, { hash: 'current' });
    await engine.executeRaw(`UPDATE pages SET effective_date = CASE slug
        WHEN 'dated-0' THEN '2024-01-10T00:00:00Z'::timestamptz WHEN 'dated-1' THEN NULL
        WHEN 'dated-2' THEN '2024-02-01T00:00:00Z'::timestamptz ELSE '2024-01-15T00:00:00Z'::timestamptz END,
      updated_at = CASE slug WHEN 'dated-1' THEN '2024-01-20T00:00:00Z'::timestamptz ELSE '2023-06-01T00:00:00Z'::timestamptz END`);
    const slugs = async (opts: SearchOpts) => (await engine.searchVector(query, { limit: 10, embeddingColumn: column, ...opts })).map(hit => hit.slug).sort();
    expect(await slugs({ afterDate: '2024-01-15T00:00:00Z' })).toEqual(['dated-1', 'dated-2']);
    expect(await slugs({ afterDate: '2024-01-15T00:00:00Z', afterDateInclusive: true })).toEqual(['dated-1', 'dated-2', 'dated-3']);
    expect(await slugs({ beforeDate: '2024-01-20T00:00:00Z' })).toEqual(['dated-0', 'dated-3']);
    expect(await slugs({ afterDate: '2024-01-12T00:00:00Z', beforeDate: '2024-01-20T00:00:00Z', beforeDateInclusive: true })).toEqual(['dated-1', 'dated-3']);
  }, 60_000);

  test('walk, scoped and joined queries enforce discriminating chunk and page predicates', async () => {
    await reset();
    await seed('current', 3, 0.05, 0.001, { hash: 'current' });
    await seed('blocked', 6, 0.001, 0.001, { hash: 'current' });
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('filter-other', 'Filter other')`);
    await engine.executeRaw(`UPDATE pages SET
      source_id = CASE WHEN slug = 'blocked-2' THEN 'filter-other' ELSE source_id END,
      frontmatter = CASE WHEN slug = 'blocked-4' THEN '{"visibility":"private"}'::jsonb ELSE frontmatter END,
      type = CASE WHEN slug = 'blocked-5' THEN 'person' ELSE type END`);
    await engine.executeRaw(`UPDATE content_chunks cc SET
      language = CASE WHEN p.slug = 'blocked-0' THEN 'python' ELSE 'typescript' END,
      chunk_source = CASE WHEN p.slug = 'blocked-1' THEN 'fenced_code' ELSE 'compiled_truth' END
      FROM pages p WHERE p.id = cc.page_id`);
    const options: SearchOpts = { embeddingColumn: column, sourceId: 'default', excludePrivate: true,
      exclude_slugs: ['blocked-3'], language: 'typescript', detail: 'low' };
    const results = [];
    for (const dialect of ['postgres', 'pglite'] as const) {
      const walk = buildVectorSearchStatement({ dialect, embedding: query, limit: 10, offset: 0, opts: options });
      const narrowed = buildVectorSearchStatement({ dialect, embedding: query, limit: 10, offset: 0,
        opts: { ...options, type: 'note' }, scope: { share: 0.2, chunks: 500 } });
      const slugs = async (sql: string, params: unknown[]) => (await engine.executeRaw<{ slug: string }>(sql, params)).map(row => row.slug);
      results.push({ dialect, walk: await slugs(walk.indexWalkSql!, walk.params),
        joined: await slugs(narrowed.sql, narrowed.params), scoped: await slugs(narrowed.scopeScanSql!, narrowed.params),
        exact: await slugs(narrowed.exactSql, narrowed.params),
        witness: await engine.executeRaw(narrowed.hasMoreSql, narrowed.params.slice(0, narrowed.innerLimitIdx + 1)) });
    }
    const expected = ['current-0', 'current-1', 'current-2'];
    expect(results).toEqual(['postgres', 'pglite'].map(dialect => ({ dialect, walk: ['blocked-5', ...expected],
      joined: expected, scoped: expected, exact: expected, witness: [{ eligible: 3 }] })));
  }, 60_000);

  test('non-indexed 3072-dimensional vectors retain model, legacy and freshness eligibility in both dialects', async () => {
    await reset();
    await seed('stale', 1, 0.001, 0, { hash: 'stale' });
    await seed('mismatch', 1, 0.002, 0, { hash: 'current', model: 'test:other-model' });
    await seed('legacy', 1, 0.01, 0, { hash: 'null' });
    await seed('fresh', 2, 0.05, 0.001, { hash: 'current' });
    await engine.executeRaw('DROP INDEX idx_chunks_embedding');
    await engine.executeRaw(`ALTER TABLE content_chunks ALTER COLUMN embedding TYPE vector(3072)
      USING embedding || array_fill(0::real, ARRAY[3064])::vector`);
    try {
      const wideQuery = new Float32Array(3072);
      wideQuery[0] = 1;
      const options = { limit: 10, embeddingColumn: { ...column, dimensions: 3072 } };
      const expected = ['legacy-0', 'fresh-0', 'fresh-1'];
      expect((await engine.searchVector(wideQuery, options)).map(row => row.slug)).toEqual(expected);
      for (const dialect of ['postgres', 'pglite'] as const) {
        const statement = buildVectorSearchStatement({ dialect, embedding: wideQuery, limit: 10, offset: 0, opts: options });
        for (const sql of [statement.sql, statement.exactSql]) {
          expect((await engine.executeRaw<{ slug: string }>(sql, statement.params)).map(row => row.slug)).toEqual(expected);
        }
      }
    } finally {
      await engine.executeRaw('DELETE FROM content_chunks');
      await engine.executeRaw('ALTER TABLE content_chunks ALTER COLUMN embedding TYPE vector(8)');
      await engine.executeRaw('CREATE INDEX idx_chunks_embedding ON content_chunks USING hnsw (embedding vector_cosine_ops)');
    }
  }, 60_000);

  test('image retrieval enforces modality without applying text-model or text-hash guards in either dialect', async () => {
    await reset();
    await seed('image', 2, 0.01, 0.01, { hash: 'stale', model: 'test:not-the-image-model' });
    await seed('text', 1, 0, 0, { hash: 'current' });
    await engine.executeRaw(`UPDATE content_chunks cc SET
      modality = CASE WHEN p.slug LIKE 'image-%' THEN 'image' ELSE 'text' END,
      embedding_image = ARRAY[cos(a), sin(a)]::real[]::vector || array_fill(0::real, ARRAY[1022])::vector
      FROM (SELECT id, slug, CASE slug WHEN 'image-0' THEN 0.01 WHEN 'image-1' THEN 0.02 ELSE 0 END AS a FROM pages) p
      WHERE p.id = cc.page_id`);
    const imageQuery = new Float32Array(1024);
    imageQuery[0] = 1;
    const options = { limit: 10, embeddingColumn: { name: 'embedding_image', type: 'vector' as const, dimensions: 1024, embeddingModel: 'test:image-model' } };
    const expected = ['image-0', 'image-1'];
    expect((await engine.searchVector(imageQuery, options)).map(row => row.slug)).toEqual(expected);
    for (const dialect of ['postgres', 'pglite'] as const) {
      const statement = buildVectorSearchStatement({ dialect, embedding: imageQuery, limit: 10, offset: 0, opts: options });
      for (const sql of [statement.sql, statement.exactSql]) {
        expect((await engine.executeRaw<{ slug: string }>(sql, statement.params)).map(row => row.slug)).toEqual(expected);
      }
    }
  }, 60_000);
});
