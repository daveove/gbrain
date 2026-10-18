import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import postgres from '#postgres';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { initializeIndependentEmbeddingColumn } from '../../src/core/embedding-column-schema.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { readProjectionSnapshot, installPageEmbeddings } from '../../src/core/page-state/projections.ts';
import { embeddingColumnSignature } from '../../src/core/search/embedding-column.ts';
import { buildVectorSearchStatement } from '../../src/core/search/vector-statement.ts';
import type { ResolvedColumn } from '../../src/core/types.ts';
import * as vectorPool from '../../src/core/search/vector-pool.ts';
import { withVectorSettings } from '../../src/core/search/vector-settings.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';

const url = process.env.DATABASE_URL;
const database = `gbrain_test_semantic_${randomUUID().replaceAll('-', '')}`;
const model = 'ollama:nomic-embed-text';
// A dense query shares the background distribution instead of isolating a sparse-axis needle from HNSW.
const query = Float32Array.from({ length: 768 }, (_, i) => createHash('md5').update(`0:${i + 1}`).digest().readInt32BE(0) / 2147483648);
const queryNorm = Math.sqrt(query.reduce((sum, value) => sum + value * value, 0));
for (let i = 0; i < query.length; i++) query[i] /= queryNorm;
const forbidden = ['wrong-model', 'stale-text', 'missing-input', 'stale-page', 'private', 'other-source'];

function indexes(plan: unknown): string[] {
  if (!plan || typeof plan !== 'object') return [];
  if (Array.isArray(plan)) return plan.flatMap(indexes);
  const index = 'Index Name' in plan && typeof plan['Index Name'] === 'string' ? [plan['Index Name']] : [];
  return [...index, ...Object.values(plan).flatMap(indexes)];
}

(url ? describe : describe.skip)('independent-column ANN publication safety (Postgres)', () => {
  let engine: PostgresEngine;
  let column: ResolvedColumn;
  let created = false;

  beforeAll(async () => {
    assertSafeE2eDatabaseUrl(url!);
    const admin = postgres(url!, { max: 1, prepare: false });
    try {
      await admin.unsafe(`CREATE DATABASE ${database}`);
      created = true;
      await admin.unsafe(`ALTER DATABASE ${database} SET work_mem = '1MB'`);
      await admin.unsafe(`ALTER DATABASE ${database} SET maintenance_work_mem = '16MB'`);
      await admin.unsafe(`ALTER DATABASE ${database} SET max_parallel_maintenance_workers = 0`);
    } finally {
      await admin.end();
    }
    const fixtureUrl = new URL(url!);
    fixtureUrl.pathname = `/${database}`;
    engine = new PostgresEngine();
    await engine.connect({ database_url: fixtureUrl.toString(), poolSize: 1 });
    await engine.initSchema();
    column = await initializeIndependentEmbeddingColumn(engine, 'embedding_nomic', {
      provider: model, dimensions: 768, type: 'vector', provenance: 'independent',
      documentPrefix: 'search_document: ', queryPrefix: 'search_query: ',
    });
    await engine.executeRaw(`INSERT INTO sources(id,name) VALUES ('other','Other')`);
    for (const name of ['current', ...forbidden]) {
      const slug = `fixture/${name}`;
      const sourceId = name === 'other-source' ? 'other' : 'default';
      const visibility = name === 'private' ? 'visibility: private\n' : '';
      await importFromContent(engine, slug, `---\ntype: note\ntitle: Fixture\n${visibility}---\n\nA bounded independent embedding fixture.\n`, { noEmbed: true, sourceId });
      const snapshot = await readProjectionSnapshot(engine, slug, sourceId, { embeddingColumn: column });
      if (!snapshot) throw new Error(`Missing native publication snapshot for ${slug}`);
      expect(await installPageEmbeddings(engine, snapshot, snapshot.chunks.map(chunk => ({
        chunk_index: chunk.chunk_index, chunk_text: chunk.chunk_text, chunk_source: chunk.chunk_source,
        embedding: query, model,
      })), embeddingColumnSignature(column))).toBe(true);
    }
    await engine.executeRaw(`INSERT INTO pages (slug,source_id,type,title,compiled_truth,knowledge_revision,text_projection_revision,
      chunker_version,contextual_retrieval_mode,corpus_generation,embedding_nomic_signature)
      SELECT 'background/' || i,p.source_id,p.type,p.title,p.compiled_truth,p.knowledge_revision,p.text_projection_revision,
        p.chunker_version,p.contextual_retrieval_mode,p.corpus_generation,p.embedding_nomic_signature
      FROM pages p CROSS JOIN generate_series(1,4000) i WHERE p.slug='fixture/current'`);
    await engine.executeRaw(`INSERT INTO content_chunks (page_id,chunk_index,chunk_text,chunk_source,embedding_nomic,
      embedding_nomic_model,embedding_nomic_embedded_text_hash,embedding_nomic_embedding_input_hash)
      SELECT p.id,cc.chunk_index,cc.chunk_text,cc.chunk_source,v.embedding,cc.embedding_nomic_model,
        cc.embedding_nomic_embedded_text_hash,cc.embedding_nomic_embedding_input_hash
      FROM pages p CROSS JOIN content_chunks cc
      JOIN pages template ON template.id=cc.page_id AND template.slug='fixture/current'
      CROSS JOIN LATERAL (SELECT l2_normalize(array_agg(
        (('x'||substr(md5(p.id::text||':'||d::text),1,8))::bit(32)::int)::real / 2147483648.0
        ORDER BY d)::real[]::vector) AS embedding FROM generate_series(1,768) d) v
      WHERE p.slug LIKE 'background/%'`);
    await engine.executeRaw(`UPDATE content_chunks cc SET embedding_nomic_model='ollama:other'
      FROM pages p WHERE p.id=cc.page_id AND p.slug='fixture/wrong-model'`);
    await engine.executeRaw(`UPDATE content_chunks cc SET embedding_nomic_embedded_text_hash=md5('before edit')
      FROM pages p WHERE p.id=cc.page_id AND p.slug='fixture/stale-text'`);
    await engine.executeRaw(`UPDATE content_chunks cc SET embedding_nomic_embedding_input_hash=NULL
      FROM pages p WHERE p.id=cc.page_id AND p.slug='fixture/missing-input'`);
    await engine.executeRaw(`UPDATE pages SET title='Changed after publication' WHERE slug='fixture/stale-page'`);
    for (const table of ['pages', 'content_chunks', 'sources']) await engine.executeRaw(`ANALYZE ${table}`);
  }, 120_000);

  afterAll(async () => {
    await engine?.disconnect();
    if (!created) return;
    const admin = postgres(url!, { max: 1, prepare: false });
    try { await admin.unsafe(`DROP DATABASE ${database}`); }
    finally { await admin.end(); }
  }, 60_000);

  const opts = () => ({ embeddingColumn: column, sourceId: 'default', excludePrivate: true, limit: 10 });
  function assertSafe(rows: Array<{ slug: string; source_id: string }>) {
    expect(rows).toHaveLength(10);
    expect(rows[0].slug).toBe('fixture/current');
    expect(rows.every(row => row.source_id === 'default' && !forbidden.some(name => row.slug === `fixture/${name}`))).toBe(true);
  }

  test('the native HNSW path re-sorts relaxed candidates before truncation and rejects stale or inaccessible rows', async () => {
    const control = buildVectorSearchStatement({ dialect: 'postgres', embedding: query, limit: 10, offset: 0, opts: opts(),
      scope: { share: 4006 / 4007, chunks: 4006 } });
    const exact = await engine.executeRaw<{ slug: string; source_id: string }>(control.exactSql, control.params);
    const candidateSql = `WITH candidates AS MATERIALIZED (
      SELECT id,embedding_nomic <=> $1::vector AS distance FROM content_chunks
      WHERE embedding_nomic IS NOT NULL AND modality='text' AND embedding_nomic_model=$2
      ORDER BY embedding_nomic <=> $1::vector LIMIT $3)
      SELECT p.slug,candidates.distance FROM candidates JOIN content_chunks cc ON cc.id=candidates.id
      JOIN pages p ON p.id=cc.page_id ORDER BY candidates.distance + 0,cc.id`;
    const candidateParams = [JSON.stringify(Array.from(query)), model, control.innerLimit * control.indexWalkOverfetch];
    const candidates = await engine.transaction(tx => withVectorSettings((sql, params) => tx.executeRaw(sql, params), true,
      control.innerLimit, Math.max(2_000, control.innerLimit * control.indexWalkOverfetch), async () => {
        expect(indexes(await tx.executeRaw(`EXPLAIN (FORMAT JSON) ${candidateSql}`, candidateParams))).toContain('idx_chunks_embedding_nomic');
        console.info(JSON.stringify({ fixture: 'raw-ann-candidate-control', database, settings: await tx.executeRaw(
          `SELECT name,current_setting(name,true) AS value FROM unnest($1::text[]) t(name)`,
          [['work_mem','hnsw.ef_search','hnsw.iterative_scan','hnsw.max_scan_tuples','hnsw.scan_mem_multiplier','enable_sort']]) }));
        return tx.executeRaw<{ slug: string; distance: number }>(candidateSql, candidateParams);
      }, undefined, undefined, control.indexWalkOverfetch));
    const candidateSlugs = candidates.map(row => row.slug);
    console.info(JSON.stringify({ exact: exact.map(row => row.slug), rawNearest: candidateSlugs.slice(0, 10) }));
    for (const name of ['current', 'stale-text', 'missing-input', 'stale-page', 'private', 'other-source']) {
      expect(candidateSlugs).toContain(`fixture/${name}`);
    }
    assertSafe(exact);
    const legacy = await engine.explainVectorSearch(query, { ...opts(), vectorLegacyGuard: true });
    const fixed = await engine.explainVectorSearch(query, opts());
    expect(indexes(legacy)).not.toContain('idx_chunks_embedding_nomic');
    expect(indexes(fixed)).toContain('idx_chunks_embedding_nomic');
    assertSafe(await engine.searchVector(query, opts()));
    const [versions] = await engine.executeRaw(`SELECT current_setting('server_version') AS postgres,
      (SELECT extversion FROM pg_extension WHERE extname='vector') AS vector`);
    console.info(JSON.stringify({ fixture: 'independent-column-ann', ...versions,
      legacyIndexes: indexes(legacy), fixedIndexes: indexes(fixed) }));
  }, 30_000);

  test('native type and date narrowing re-sort joined HNSW candidates under shipped settings', async () => {
    for (const narrowing of [{ type: 'note' }, { afterDate: '2000-01-01' }]) {
      const options = { ...opts(), ...narrowing };
      expect(indexes(await engine.explainVectorSearch(query, options))).toContain('idx_chunks_embedding_nomic');
      assertSafe(await engine.searchVector(query, options));
    }
  }, 30_000);

  test('an actually underfilled native walk falls back to the guarded, re-sorted joined search', async () => {
    const original = vectorPool.searchIndexWalk;
    let underfilled = false;
    let walkResult: unknown;
    const spy = spyOn(vectorPool, 'searchIndexWalk').mockImplementation(async (statement, limit, run) => {
      const result = await original(statement, limit, async attempt => {
        const batch = await run(attempt);
        if (attempt.indexWalk) underfilled = batch.candidatePool < attempt.innerLimit;
        return batch;
      });
      walkResult = result;
      return result;
    });
    try {
      const rows = await engine.searchVector(query, { ...opts(),
        exclude_slugs: Array.from({ length: 3950 }, (_, i) => `background/${i + 51}`) });
      expect(underfilled).toBe(true);
      expect(walkResult).toBeNull();
      assertSafe(rows);
      expect(rows.every(row => !row.slug.startsWith('background/') || Number(row.slug.slice('background/'.length)) <= 50)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  }, 30_000);

  test('joined, walk, scoped, exact and legacy queries enforce the same publication and source boundary', async () => {
    const statement = buildVectorSearchStatement({ dialect: 'postgres', embedding: query, limit: 10, offset: 0,
      opts: opts(), scope: { share: 0.25, chunks: 30_000 } });
    for (const sql of [statement.exactSql, statement.sql, statement.indexWalkSql!, statement.scopeScanSql!]) {
      assertSafe(await engine.executeRaw<{ slug: string; source_id: string }>(sql, statement.params));
    }
    assertSafe(await engine.searchVector(query, { ...opts(), vectorLegacyGuard: true }));
    const witnessParams = [...statement.params.slice(0, statement.innerLimitIdx), 10_000];
    expect(await engine.executeRaw(statement.hasMoreSql, witnessParams)).toEqual([{ eligible: 4001 }]);
    expect(await engine.searchVector(query, { ...opts(), embeddingColumn: { ...column, documentPrefix: 'changed: ' } })).toEqual([]);
    const unscoped = await engine.searchVector(query, { embeddingColumn: column, limit: 10 });
    expect(unscoped.map(row => row.slug)).toContain('fixture/private');
    expect(unscoped.map(row => row.slug)).toContain('fixture/other-source');
    expect((await engine.searchVector(query, { ...opts(), sourceId: 'other' })).map(row => row.slug)).toEqual(['fixture/other-source']);
  }, 30_000);
});
