import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import postgres from '#postgres';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { initializeIndependentEmbeddingColumn } from '../../src/core/embedding-column-schema.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { readProjectionSnapshot, installPageEmbeddings } from '../../src/core/page-state/projections.ts';
import { embeddingColumnSignature } from '../../src/core/search/embedding-column.ts';
import { buildVectorSearchStatement } from '../../src/core/search/vector-statement.ts';
import type { ResolvedColumn } from '../../src/core/types.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';

const url = process.env.DATABASE_URL;
const database = `gbrain_test_semantic_${randomUUID().replaceAll('-', '')}`;
const model = 'ollama:nomic-embed-text';
const query = new Float32Array(768);
query[0] = 1;
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
    for (const name of ['current', ...forbidden]) {
      const slug = `fixture/${name}`;
      await importFromContent(engine, slug, '---\ntype: note\ntitle: Fixture\n---\n\nA bounded independent embedding fixture.\n', { noEmbed: true });
      const snapshot = await readProjectionSnapshot(engine, slug, 'default', { embeddingColumn: column });
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
    const background = new Float32Array(768);
    background[0] = 0.6;
    background[1] = 0.8;
    await engine.executeRaw(`INSERT INTO content_chunks (page_id,chunk_index,chunk_text,chunk_source,embedding_nomic,
      embedding_nomic_model,embedding_nomic_embedded_text_hash,embedding_nomic_embedding_input_hash)
      SELECT p.id,cc.chunk_index,cc.chunk_text,cc.chunk_source,$1::vector,cc.embedding_nomic_model,
        cc.embedding_nomic_embedded_text_hash,cc.embedding_nomic_embedding_input_hash
      FROM pages p CROSS JOIN content_chunks cc
      JOIN pages template ON template.id=cc.page_id AND template.slug='fixture/current'
      WHERE p.slug LIKE 'background/%'`, [JSON.stringify(Array.from(background))]);
    await engine.executeRaw(`UPDATE content_chunks cc SET embedding_nomic_model='ollama:other'
      FROM pages p WHERE p.id=cc.page_id AND p.slug='fixture/wrong-model'`);
    await engine.executeRaw(`UPDATE content_chunks cc SET embedding_nomic_embedded_text_hash=md5('before edit')
      FROM pages p WHERE p.id=cc.page_id AND p.slug='fixture/stale-text'`);
    await engine.executeRaw(`UPDATE content_chunks cc SET embedding_nomic_embedding_input_hash=NULL
      FROM pages p WHERE p.id=cc.page_id AND p.slug='fixture/missing-input'`);
    await engine.executeRaw(`UPDATE pages SET title='Changed after publication' WHERE slug='fixture/stale-page'`);
    await engine.executeRaw(`UPDATE pages SET frontmatter='{"visibility":"private"}'::jsonb WHERE slug='fixture/private'`);
    await engine.executeRaw(`INSERT INTO sources(id,name) VALUES ('other','Other')`);
    await engine.executeRaw(`UPDATE pages SET source_id='other' WHERE slug='fixture/other-source'`);
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

  test('the native search path naturally uses independent HNSW and rejects stale or inaccessible candidates', async () => {
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

  test('joined, walk, scoped, exact and legacy queries enforce the same publication and source boundary', async () => {
    const statement = buildVectorSearchStatement({ dialect: 'postgres', embedding: query, limit: 10, offset: 0,
      opts: opts(), scope: { share: 0.25, chunks: 30_000 } });
    for (const sql of [statement.sql, statement.indexWalkSql!, statement.scopeScanSql!, statement.exactSql]) {
      assertSafe(await engine.executeRaw<{ slug: string; source_id: string }>(sql, statement.params));
    }
    assertSafe(await engine.searchVector(query, { ...opts(), vectorLegacyGuard: true }));
    const witnessParams = [...statement.params.slice(0, statement.innerLimitIdx), 10_000];
    expect(await engine.executeRaw(statement.hasMoreSql, witnessParams)).toEqual([{ eligible: 4001 }]);
    expect(await engine.searchVector(query, { ...opts(), embeddingColumn: { ...column, documentPrefix: 'changed: ' } })).toEqual([]);
  }, 30_000);
});
