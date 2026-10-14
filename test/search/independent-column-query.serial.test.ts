/**
 * DAV-6928: querying an independent embedding column (`provenance:
 * 'independent'`) uses that column's own model, dimensions and queryPrefix
 * while the live default model and brain-wide `embedding_query_prefix` stay
 * on the primary OpenAI 1536 space; only vectors whose own model and text
 * hash are current rank or re-score; unified multimodal routing is omitted
 * with honest meta; and the query op's native keyword-only alias fan-out
 * keeps its vector arm in the requested space.
 *
 * Isolated PGLite/PostgreSQL; the embedding transport is stubbed ($0).
 * The native initializer creates the space and guarded publication writes
 * its proof before each stale, wrong-model or missing-proof corruption.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { hybridSearchCached } from '../../src/core/search/hybrid.ts';
import type { HybridSearchMeta, SearchResult } from '../../src/core/types.ts';
import { initializeIndependentEmbeddingColumn } from '../../src/core/embedding-column-schema.ts';
import { readProjectionSnapshot, installPageEmbeddings } from '../../src/core/page-state/projections.ts';
import { fetchFar } from '../../src/core/brainstorm/domain-bank.ts';
import { resolveEmbeddingColumn, resolveRegisteredEmbeddingColumnFromEngine, embeddingColumnSignature } from '../../src/core/search/embedding-column.ts';
import { loadConfigWithEngine } from '../../src/core/config.ts';

import { sweep } from '../helpers/mention-brain.ts';
const COLUMN = 'embedding_nomic';
const NOMIC = 'ollama:nomic-embed-text';
const DIMS = 768;
const PRIMARY = 'openai:text-embedding-3-large';
const UNIT = new Float32Array(DIMS);
UNIT[0] = 1;

for (const backend of testBackends()) {
  describe(`independent-space ${backend}`, () => {
    let engine: BrainEngine;
    let closePostgres: (() => Promise<void>) | undefined;
    let seen: Array<{ model: string; value: string }> = [];

    function configureEmbedding(): void {
      configureGateway({ embedding_model: PRIMARY, embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-fake' } });
      __setEmbedTransportForTests((async (args: { model: { modelId?: string }; values: string[] }) => {
        const model = String(args.model?.modelId);
        for (const value of args.values) seen.push({ model, value });
        const nomic = model.includes('nomic');
        return {
          embeddings: args.values.map(() => nomic
            ? Array.from({ length: DIMS }, (_, i) => (i === 0 ? 1 : 0))
            : Array.from({ length: 1536 }, () => 0.01)),
        };
      }) as never);
    }

    /** Publish through the native guard, then corrupt one proof field to exercise reads. */
    async function plant(slug: string, proof: { model: string | null; hash: 'current' | 'stale' | null; input: string | null }): Promise<void> {
      const column = await resolveRegisteredEmbeddingColumnFromEngine(engine, COLUMN);
      const prepared = await readProjectionSnapshot(engine, slug, 'default', { embeddingColumn: column });
      if (!prepared) throw new Error(`Missing sealed fixture page ${slug}`);
      const published = await installPageEmbeddings(engine, prepared, prepared.chunks.map(chunk => ({
        chunk_index: chunk.chunk_index, chunk_text: chunk.chunk_text, chunk_source: chunk.chunk_source, embedding: UNIT, model: NOMIC,
      })), embeddingColumnSignature(column));
      if (!published) throw new Error(`Fixture publication lost its page guard for ${slug}`);
      const hash = proof.hash === 'current' ? 'md5(cc.chunk_text)' : proof.hash === 'stale' ? `md5('text before the edit')` : 'NULL';
      await engine.executeRaw(`UPDATE content_chunks cc SET ${COLUMN}_model=$1,${COLUMN}_embedded_text_hash=${hash},
        ${COLUMN}_embedding_input_hash=CASE WHEN $2::boolean THEN ${COLUMN}_embedding_input_hash ELSE NULL END
        FROM pages p WHERE p.id=cc.page_id AND p.slug=$3`, [proof.model, proof.input !== null, slug]);
    }

    async function search(query: string, opts: Parameters<typeof hybridSearchCached>[2] = {}): Promise<{ results: SearchResult[]; meta: HybridSearchMeta }> {
      let meta: HybridSearchMeta | undefined;
      const results = await hybridSearchCached(engine, query, { expansion: false, ...opts, onMeta: (m) => { meta = m; } });
      return { results, meta: meta! };
    }

    beforeAll(async () => {
      configureEmbedding();
      if (backend === 'postgres') ({ engine, close: closePostgres } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
      const pages: Array<[string, string, string]> = [
        ['notes/alpha', 'Alpha', 'Alpha roadmap gizmotron. Alpha is also known as Zorblax.'],
        ['notes/bravo', 'Bravo', 'Bravo gizmotron field notes.'],
        ['notes/charlie', 'Charlie', 'Charlie gizmotron field notes.'],
        ['notes/delta', 'Delta', 'Delta gizmotron field notes.'],
      ];
      for (const [slug, title, body] of pages) {
        await importFromContent(engine, slug, `---\ntype: note\ntitle: ${title}\n---\n\n${body}\n`, { noEmbed: true });
      }
      await initializeIndependentEmbeddingColumn(engine, COLUMN, {
        provider: NOMIC, dimensions: DIMS, type: 'vector', provenance: 'independent',
        documentPrefix: 'search_document: ', queryPrefix: 'search_query: ',
      });
      // The primary space keeps its own instruction; it must never reach the independent space.
      await engine.setConfig('embedding_query_prefix', 'query: ');
      await plant('notes/alpha', { model: NOMIC, hash: 'current', input: 'fixture-input' });
      await plant('notes/bravo', { model: NOMIC, hash: 'stale', input: 'fixture-input' });
      await plant('notes/charlie', { model: 'ollama:mxbai-embed-large', hash: 'current', input: 'fixture-input' });
      await plant('notes/delta', { model: null, hash: null, input: null });
      resetGateway();
    }, 120_000);

    afterAll(async () => {
      if (closePostgres) await closePostgres();
      else await engine?.disconnect();
    }, 60_000);

    afterEach(async () => {
      __setEmbedTransportForTests(null);
      resetGateway();
      seen = [];
      await engine.unsetConfig('search.unified_multimodal');
    });

    describe('independent column query', () => {
      test('embeds with the column model and queryPrefix while the live model and brain prefix stay primary', async () => {
        configureEmbedding();
        const { results, meta } = await search('zephyrquux', { embeddingColumn: COLUMN });
        expect(seen).toEqual([{ model: 'nomic-embed-text', value: 'search_query: zephyrquux' }]);
        expect(meta.embedding_column).toBe(COLUMN);
        expect(meta.vector_enabled).toBe(true);
        // Stale-text, other-model and proof-less vectors point exactly at the query, yet never rank.
        expect(results.map(r => r.slug)).toEqual(['notes/alpha']);
      });

      test('file-plane registration cannot drop the proof of an initialized independent space', async () => {
        const merged = await loadConfigWithEngine(engine, {
          engine: 'pglite',
          embedding_columns: { [COLUMN]: { provider: NOMIC, dimensions: DIMS, type: 'vector' } },
        });
        if (!merged) throw new Error('Missing fixture configuration');
        const column = resolveEmbeddingColumn({ embeddingColumn: COLUMN }, merged);
        const results = await engine.searchVector(UNIT, { embeddingColumn: column });
        expect(results.map(row => row.slug)).toEqual(['notes/alpha']);
      });

      test('the default column still embeds with the primary model and brain prefix', async () => {
        configureEmbedding();
        const { meta } = await search('zephyrquux');
        expect(seen).toEqual([{ model: 'text-embedding-3-large', value: 'query: zephyrquux' }]);
        expect(meta.embedding_column).toBe('embedding');
        expect(meta.omitted_vector_arms).toBeUndefined();
      });

      test('re-score hydrates only current own-space proof: keyword rows with stale, other-model or missing proof score cosine 0', async () => {
        configureEmbedding();
        const { results } = await search('gizmotron', { embeddingColumn: COLUMN, limit: 10 });
        const cosine = new Map(results.map(r => [r.slug, r.cosine]));
        expect([...cosine.keys()].sort()).toEqual(['notes/alpha', 'notes/bravo', 'notes/charlie', 'notes/delta']);
        expect(cosine.get('notes/alpha')).toBeCloseTo(1, 5);
        for (const slug of ['notes/bravo', 'notes/charlie', 'notes/delta']) expect(cosine.get(slug)).toBe(0);
      });

      test('unified multimodal routing is omitted with meta, and the column space answers', async () => {
        configureEmbedding();
        await engine.setConfig('search.unified_multimodal', 'true');
        const { results, meta } = await search('zephyrquux', { embeddingColumn: COLUMN });
        expect(meta.omitted_vector_arms).toEqual([{ arm: 'unified_multimodal', reason: 'independent_embedding_column' }]);
        expect(seen).toEqual([{ model: 'nomic-embed-text', value: 'search_query: zephyrquux' }]);
        expect(results.map(r => r.slug)).toEqual(['notes/alpha']);
      });

      test('the query op keeps the requested vector space while native alias fan-out stays keyword-only', async () => {
        await importFromContent(engine, 'companies/alpha', '---\ntype: company\ntitle: Alpha\naliases: [Zorblax]\n---\n\nAlpha project identity.\n', { noEmbed: true });
        await importFromContent(engine, 'notes/alias-roadmap', '---\ntype: note\ntitle: Alias-only roadmap\n---\n\nZorblax roadmap commitments.\n', { noEmbed: true });
        try {
          await sweep(engine);
          configureEmbedding();
          const result = await dispatchToolCall(engine, 'query',
            { query: 'Alpha roadmap', expand: false, embedding_column: COLUMN }, { remote: false, sourceId: 'default' });
          expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
          expect(seen).toEqual([{ model: 'nomic-embed-text', value: 'search_query: Alpha roadmap' }]);
          const fanout = (result._meta?.retrieval as { fanout?: { aliases_searched: Array<{ alias: string }> } } | undefined)?.fanout;
          expect(fanout?.aliases_searched.map(row => row.alias)).toContain('Zorblax');
          expect(result.content.map(row => row.text ?? '').join('\n')).toContain('notes/alias-roadmap');
        } finally {
          await engine.deletePage('companies/alpha', { sourceId: 'default' });
          await engine.deletePage('notes/alias-roadmap', { sourceId: 'default' });
        }
      });
      test('brainstorm file-plane column yields far-page distance without a DB registration', async () => {
        const name = 'embedding_far_file';
        const registry = await engine.getConfig('embedding_columns');
        const column = resolveEmbeddingColumn({ embeddingColumn: name }, {
          engine: 'pglite', embedding_columns: { [name]: { provider: NOMIC, dimensions: DIMS, type: 'vector' } },
        });
        await engine.executeRaw(`ALTER TABLE content_chunks ADD COLUMN ${name} vector(768)`);
        try {
          await engine.executeRaw(`UPDATE content_chunks SET embedding=$1::vector,${name}=$2::vector
            WHERE page_id=(SELECT id FROM pages WHERE slug='notes/alpha')`,
          [JSON.stringify(Array.from({ length: 1536 }, () => 0.01)), JSON.stringify(Array.from(UNIT, value => -value))]);
          const result = await fetchFar(engine, { m: 1, closeSet: [], questionEmbedding: UNIT,
            prefixListOverride: ['notes/alpha'], embeddingColumn: column });
          expect(result.pages.map(page => page.slug)).toEqual(['notes/alpha']);
          expect(result.pages[0]?.distance_score).toBeCloseTo(1, 5);
          expect(await engine.getConfig('embedding_columns')).toBe(registry);
        } finally {
          await engine.executeRaw("UPDATE content_chunks SET embedding=NULL WHERE page_id=(SELECT id FROM pages WHERE slug='notes/alpha')");
          await engine.executeRaw(`ALTER TABLE content_chunks DROP COLUMN ${name}`);
        }
      });

    });
  });
}
