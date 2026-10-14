/**
 * DAV-6928: `gbrain embed --embedding-column <independent column>` stages a
 * second model space next to the live one.
 *
 * Protects: a staging run (dry, slug, slugs, --all, --stale) selects by the
 * target column's own proof, embeds with the target's model, width and
 * document prefix, and writes only the target vector, its provenance and its
 * page signature. The live OpenAI 1536 vectors and their model, text/input
 * hash, embedded/pending time and page signature, the chunk projection and
 * the live search/default model stay byte-identical. Unsealed pages are
 * reported, never repaired. Only a registered, initialized independent column
 * can be targeted.
 * Fails when: staging routes to the live model, rewrites or invalidates live
 * vectors or stamps, skips the prefix, re-embeds fresh target rows, repairs an
 * unsealed projection, or accepts a built-in/unregistered/uninitialized column.
 *
 * PGLite in-memory; the embedding transport is stubbed ($0). The independent
 * column and its derived provenance columns are fixture DDL, registered
 * through the brain's own `embedding_columns` config row.
 *
 * Named `.serial.test.ts`: configures the AI gateway and a fake embed
 * transport for its whole lifecycle, which withEnv() can't wrap.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import postgres from '#postgres';
import { importFromContent } from '../src/core/import-file.ts';
import { configureGateway, getEmbeddingModel, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { runEmbedCore } from '../src/commands/embed.ts';
import { EmbeddingStagingTargetError, parseEmbeddingColumnArg, resolveEmbeddingStagingTarget } from '../src/commands/embed-setup.ts';
import { EmbeddingColumnNotRegisteredError } from '../src/core/search/embedding-column.ts';
import { initializeIndependentEmbeddingColumn } from '../src/core/embedding-column-schema.ts';
import type { EmbeddingColumnConfig } from '../src/core/types.ts';
import { learnedChunkCap, _resetLearnedChunkCapsForTest } from '../src/core/embedding-input-limit.ts';
import { _resetOverLengthHealForTest } from '../src/core/embed-overlength-heal.ts';

const COLUMN = 'embedding_nomic';
const NOMIC = 'ollama:nomic-embed-text';
const DIMS = 768;
const PRIMARY = 'openai:text-embedding-3-large';
const PREFIX = 'search_document: ';
const REGISTRY: Record<string, EmbeddingColumnConfig> = {
  [COLUMN]: { provider: NOMIC, dimensions: DIMS, type: 'vector', provenance: 'independent', documentPrefix: PREFIX, queryPrefix: 'search_query: ' },
};
const SLUGS = ['notes/alpha', 'notes/bravo', 'notes/charlie'];

for (const backend of testBackends()) {
  describe(`independent-space ${backend}`, () => {
    let engine: BrainEngine;
    let closePostgres: (() => Promise<void>) | undefined;
    let postgresDatabaseUrl: string | undefined;
    let seen: Array<{ model: string; value: string }> = [];
    let rejectNomic = false;

    /** Every live-space byte a staging run must leave alone, per chunk and page. */
    async function liveSpace(): Promise<Record<string, unknown>[]> {
      return engine.executeRaw<Record<string, unknown>>(`SELECT p.slug, cc.id, cc.chunk_index, cc.chunk_text, cc.embedding::text AS vector, cc.model,
          cc.embedded_text_hash, cc.embedding_input_hash, cc.embedded_at::text AS embedded_at,
          cc.embedding_pending_since::text AS pending_since, p.embedding_signature, p.contextual_retrieval_mode,
          p.text_projection_revision::text AS projection, p.chunker_version
        FROM content_chunks cc JOIN pages p ON p.id = cc.page_id ORDER BY p.slug, cc.chunk_index`);
    }

    async function liveConfig(): Promise<unknown[]> {
      return engine.executeRaw(`SELECT key, value FROM config
        WHERE key IN ('search_embedding_column', 'embedding_model', 'embedding_dimensions', 'embedding_query_prefix') ORDER BY key`);
    }

    async function staged(): Promise<Array<{ slug: string; chunk_text: string; dims: number | null; model: string | null; text_current: boolean; input_hash: string | null; signature: string | null }>> {
      return engine.executeRaw(`SELECT p.slug, cc.chunk_text, vector_dims(cc.${COLUMN}) AS dims, cc.${COLUMN}_model AS model,
          COALESCE(cc.${COLUMN}_embedded_text_hash = md5(cc.chunk_text), false) AS text_current,
          cc.${COLUMN}_embedding_input_hash AS input_hash, p.${COLUMN}_signature AS signature
        FROM content_chunks cc JOIN pages p ON p.id = cc.page_id ORDER BY p.slug, cc.chunk_index`);
    }

    beforeAll(async () => {
      configureGateway({ embedding_model: PRIMARY, embedding_dimensions: 1536, env: { ...process.env, OPENAI_API_KEY: 'sk-test-fake' } });
      __setEmbedTransportForTests((async (args: { model: { modelId?: string }; values: string[] }) => {
        const model = String(args.model?.modelId);
        for (const value of args.values) seen.push({ model, value });
        if (rejectNomic && model.includes('nomic')) throw Object.assign(
          new Error('Input length 1460 exceeds maximum allowed token size 512'), { status: 400 });
        const width = model.includes('nomic') ? DIMS : 1536;
        return { embeddings: args.values.map((_, i) => Array.from({ length: width }, (_, j) => (j === i % width ? 1 : 0.001))), usage: { tokens: args.values.length } };
      }) as never);
      if (backend === 'postgres') ({ engine, close: closePostgres, databaseUrl: postgresDatabaseUrl } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
      for (const slug of SLUGS) {
        const title = slug.split('/')[1]!;
        await importFromContent(engine, slug, `---\ntype: note\ntitle: ${title}\n---\n\n${title} field notes about the gizmotron.\n`, { noEmbed: true });
      }
      // The live space is embedded and stamped by the normal drain first.
      const live = await runEmbedCore(engine, { stale: true, quiet: true });
      expect(live.embedded).toBe(SLUGS.length);
      await initializeIndependentEmbeddingColumn(engine, COLUMN, REGISTRY[COLUMN]!);
    }, 120_000);

    afterAll(async () => {
      __setEmbedTransportForTests(null);
      resetGateway();
      if (closePostgres) await closePostgres();
      else await engine?.disconnect();
    }, 60_000);

    beforeEach(async () => {
      // Reset only the staged space; the live space is never touched by fixtures.
      await engine.executeRaw(`UPDATE content_chunks SET ${COLUMN} = NULL, ${COLUMN}_model = NULL, ${COLUMN}_embedded_text_hash = NULL,
        ${COLUMN}_embedding_input_hash = NULL, ${COLUMN}_embedded_at = NULL, ${COLUMN}_pending_since = NULL`);
      await engine.executeRaw(`UPDATE pages SET ${COLUMN}_signature = NULL`);
      await engine.setConfig('embedding_columns', JSON.stringify(REGISTRY));
      seen = [];
      rejectNomic = false;
    });

    describe('embed --embedding-column staging', () => {
      test('dry run counts the target backlog, calls no provider and writes nothing', async () => {
        const before = await liveSpace();
        const result = await runEmbedCore(engine, { stale: true, dryRun: true, quiet: true, embeddingColumn: COLUMN });
        expect(result.embedding_column).toBe(COLUMN);
        expect(result.would_embed).toBe(SLUGS.length);
        expect(seen).toEqual([]);
        expect(await liveSpace()).toEqual(before);
        expect((await staged()).every(row => row.dims === null)).toBe(true);
        // The live space is fully embedded: its own backlog stays empty.
        expect((await runEmbedCore(engine, { stale: true, dryRun: true, quiet: true })).would_embed).toBe(0);
      });

      test('a stale drain stages own-model, prefixed vectors and leaves the live space byte-identical', async () => {
        const before = await liveSpace();
        const config = await liveConfig();
        const result = await runEmbedCore(engine, { stale: true, quiet: true, embeddingColumn: COLUMN });
        expect(result.failures).toBe(0);
        expect(result.embedded).toBe(SLUGS.length);
        const rows = await staged();
        expect(seen.map(call => call.model)).toEqual(SLUGS.map(() => 'nomic-embed-text'));
        for (const row of rows) {
          expect(row).toMatchObject({ dims: DIMS, model: NOMIC, text_current: true });
        }
        expect(await liveSpace()).toEqual(before);
        expect(await liveConfig()).toEqual(config);

        // Fresh target proof is never re-embedded.
        seen = [];
        const again = await runEmbedCore(engine, { stale: true, quiet: true, embeddingColumn: COLUMN });
        expect(again.embedded).toBe(0);
        expect(seen).toEqual([]);
      });

      test('a live independent selector uses its own provider and leaves primary vectors unchanged in every mode', async () => {
        const before = await liveSpace();
        await engine.setConfig('search_embedding_column', COLUMN);
        try {
          for (const mode of [{ slugs: SLUGS }, { all: true }, { stale: true }]) {
            await engine.executeRaw(`UPDATE content_chunks SET ${COLUMN}=NULL`);
            await engine.executeRaw(`UPDATE pages SET ${COLUMN}_signature=NULL`);
            seen = [];
            const result = await runEmbedCore(engine, { ...mode, quiet: true });
            expect(result.failures).toBe(0);
            expect(result.embedded).toBe(SLUGS.length);
            expect(seen.every(call => call.model === 'nomic-embed-text' && call.value.startsWith(PREFIX))).toBe(true);
            expect((await staged()).every(row => row.dims === DIMS && row.model === NOMIC && row.text_current)).toBe(true);
            expect(await liveSpace()).toEqual(before);
          }
        } finally {
          await engine.setConfig('search_embedding_column', 'embedding');
        }
      });

      test('a target vector under another model is selected again; fresh pages are not', async () => {
        await runEmbedCore(engine, { stale: true, quiet: true, embeddingColumn: COLUMN });
        await engine.executeRaw(`UPDATE content_chunks cc SET ${COLUMN}_model = 'ollama:mxbai-embed-large'
          FROM pages p WHERE p.id = cc.page_id AND p.slug = 'notes/alpha'`);
        const before = await liveSpace();
        seen = [];
        const result = await runEmbedCore(engine, { stale: true, quiet: true, embeddingColumn: COLUMN });
        expect(result.embedded).toBe(1);
        expect((await staged()).every(row => row.model === NOMIC)).toBe(true);
        expect(await liveSpace()).toEqual(before);
      });

      test('slug lists and --all stage only the target column', async () => {
        const before = await liveSpace();
        const one = await runEmbedCore(engine, { slugs: ['notes/alpha'], quiet: true, embeddingColumn: COLUMN });
        expect(one.embedded).toBe(1);
        expect((await staged()).map(row => [row.slug, row.dims])).toEqual([['notes/alpha', DIMS], ['notes/bravo', null], ['notes/charlie', null]]);
        seen = [];
        const all = await runEmbedCore(engine, { all: true, quiet: true, embeddingColumn: COLUMN });
        expect(all.embedded).toBe(SLUGS.length);
        expect(seen.every(call => call.model === 'nomic-embed-text' && call.value.startsWith(PREFIX))).toBe(true);
        expect(await liveSpace()).toEqual(before);
      });

      test('staging provider overlength failures never heal chunks or learn a cap for the live model', async () => {
        const [original] = await engine.executeRaw<{ id: number; chunk_text: string }>(
          "SELECT cc.id,cc.chunk_text FROM content_chunks cc JOIN pages p ON p.id=cc.page_id WHERE p.slug='notes/alpha'");
        _resetLearnedChunkCapsForTest();
        _resetOverLengthHealForTest();
        try {
          await engine.executeRaw('UPDATE content_chunks SET chunk_text=$2 WHERE id=$1',
            [original!.id, 'An oversized input about thermal reuse. '.repeat(250)]);
          // A live local model with an undeclared input cap would normally heal
          // this error; staging may not invoke that mutation path.
          configureGateway({ embedding_model: NOMIC, embedding_dimensions: DIMS, env: {} });
          rejectNomic = true;
          const before = await liveSpace();
          for (const mode of [{ slug: 'notes/alpha' }, { all: true }, { stale: true }]) {
            const result = await runEmbedCore(engine, { ...mode, quiet: true, embeddingColumn: COLUMN });
            expect(result.failures).toBeGreaterThan(0);
            expect(await liveSpace()).toEqual(before);
            expect(learnedChunkCap(NOMIC)).toBeUndefined();
          }
        } finally {
          rejectNomic = false;
          await engine.executeRaw('UPDATE content_chunks SET chunk_text=$2 WHERE id=$1', [original!.id, original!.chunk_text]);
          _resetLearnedChunkCapsForTest();
          _resetOverLengthHealForTest();
          configureGateway({ embedding_model: PRIMARY, embedding_dimensions: 1536, env: { ...process.env, OPENAI_API_KEY: 'sk-test-fake' } });
        }
      });

      test('independent preview counts chunk-unit restamps and real input work without publishing or calling a provider', async () => {
        const multi = 'notes/preview-multi';
        await importFromContent(engine, multi, '---\ntitle: preview multi\n---\n\nFirst document.\n\nSecond document.\n', { noEmbed: true });
        try {
          await engine.upsertChunks(multi, [
            { chunk_index: 0, chunk_text: 'First document.', chunk_source: 'compiled_truth' },
            { chunk_index: 1, chunk_text: 'Second document.', chunk_source: 'compiled_truth' },
          ], { sourceId: 'default' });
          await engine.executeRaw("UPDATE pages SET text_projection_revision=knowledge_revision WHERE source_id='default' AND slug=$1", [multi]);
          await runEmbedCore(engine, { stale: true, quiet: true, embeddingColumn: COLUMN });
          await engine.executeRaw(`UPDATE pages SET ${COLUMN}_signature=NULL WHERE source_id='default' AND slug=$1`, [multi]);
          await engine.executeRaw(`UPDATE pages SET ${COLUMN}_signature='obsolete-space:obsolete-page' WHERE source_id='default' AND slug='notes/bravo'`);
          const ownSpace = () => engine.executeRaw(`SELECT p.id,p.${COLUMN}_signature,c.id AS chunk_id,c.${COLUMN}::text,c.${COLUMN}_model,
            c.${COLUMN}_embedded_text_hash,c.${COLUMN}_embedding_input_hash,c.${COLUMN}_embedded_at::text,c.${COLUMN}_pending_since::text
            FROM pages p JOIN content_chunks c ON c.page_id=p.id ORDER BY p.id,c.id`);
          const before = await liveSpace();
          const config = await liveConfig();
          const ownBefore = await ownSpace();
          seen = [];
          const preview = await runEmbedCore(engine, { stale: true, dryRun: true, quiet: true, sourceId: 'default', embeddingColumn: COLUMN });
          expect(preview).toMatchObject({ would_embed: 0, would_restamp: 3, total_chunks: 3 });
          expect(await ownSpace()).toEqual(ownBefore);
          expect(await liveSpace()).toEqual(before);
          expect(await liveConfig()).toEqual(config);
          expect(seen).toEqual([]);
          const drain = await runEmbedCore(engine, { stale: true, quiet: true, sourceId: 'default', embeddingColumn: COLUMN });
          expect(drain).toMatchObject({ embedded: 0, failures: 0 });
          expect(seen).toEqual([]);
          expect((await runEmbedCore(engine, { stale: true, dryRun: true, quiet: true, sourceId: 'default', embeddingColumn: COLUMN })).total_chunks).toBe(0);
          expect(await liveSpace()).toEqual(before);
          await engine.executeRaw(`UPDATE pages SET ${COLUMN}_signature=NULL WHERE source_id='default' AND slug=$1`, [multi]);
          await engine.executeRaw(`UPDATE content_chunks SET ${COLUMN}_embedding_input_hash='invalid-input-proof'
            WHERE page_id=(SELECT id FROM pages WHERE source_id='default' AND slug=$1) AND chunk_index=0`, [multi]);
          const staleBefore = await ownSpace();
          const realWork = await runEmbedCore(engine, { stale: true, dryRun: true, quiet: true, sourceId: 'default', embeddingColumn: COLUMN });
          expect(realWork).toMatchObject({ would_embed: 1, would_restamp: 1, total_chunks: 2 });
          expect(await ownSpace()).toEqual(staleBefore);
          expect(await liveSpace()).toEqual(before);
          expect(await liveConfig()).toEqual(config);
          expect(seen).toEqual([]);
        } finally {
          await engine.executeRaw("DELETE FROM pages WHERE source_id='default' AND slug=$1", [multi]);
        }
      });

      test('independent chunkless staging counts only active eligible sources and reports archived content once', async () => {
        const active = 'preview-active';
        const archived = 'preview-archived';
        await runEmbedCore(engine, { stale: true, quiet: true, embeddingColumn: COLUMN });
        try {
          for (const sourceId of [active, archived]) {
            await engine.executeRaw("INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)", [sourceId, `/private/tmp/${sourceId}`]);
            for (const kind of ['content', 'skip', 'quarantine']) {
              await importFromContent(engine, `notes/${kind}`, `---\ntitle: ${kind}\n---\n\nContentful ${kind} page.\n`, { noEmbed: true, sourceId });
            }
            await engine.executeRaw("UPDATE pages SET frontmatter=frontmatter || '{\"embed_skip\":true}'::jsonb WHERE source_id=$1 AND slug='notes/skip'", [sourceId]);
            await engine.executeRaw("UPDATE pages SET frontmatter=frontmatter || '{\"quarantine\":true}'::jsonb WHERE source_id=$1 AND slug='notes/quarantine'", [sourceId]);
            await engine.executeRaw("DELETE FROM content_chunks WHERE page_id IN (SELECT id FROM pages WHERE source_id=$1)", [sourceId]);
          }
          await engine.executeRaw("UPDATE sources SET archived=true WHERE id=$1", [archived]);
          const before = await liveSpace();
          const config = await liveConfig();
          const pagesBefore = await engine.executeRaw("SELECT id,source_id,slug,frontmatter,text_projection_revision::text FROM pages ORDER BY id");
          seen = [];
          const blocked = await runEmbedCore(engine, { stale: true, quiet: true, sourceId: archived, embeddingColumn: COLUMN });
          expect(blocked.failures).toBe(1);
          expect(blocked.failure_samples).toEqual([expect.stringContaining('1 archived page(s)')]);
          const live = await runEmbedCore(engine, { stale: true, quiet: true, sourceId: active, embeddingColumn: COLUMN });
          expect(live.failures).toBe(1);
          expect(live.failure_samples).toEqual([expect.stringContaining('1 page(s) with content have no chunks')]);
          const all = await runEmbedCore(engine, { stale: true, quiet: true, embeddingColumn: COLUMN });
          expect(all.failures).toBe(2);
          expect((await runEmbedCore(engine, { stale: true, quiet: true, sourceId: 'unrelated-source', embeddingColumn: COLUMN })).failures).toBe(0);
          expect(await engine.countChunklessPagesWithContent({ sourceId: archived })).toBe(1);
          expect(await liveSpace()).toEqual(before);
          expect(await liveConfig()).toEqual(config);
          expect(await engine.executeRaw("SELECT id,source_id,slug,frontmatter,text_projection_revision::text FROM pages ORDER BY id")).toEqual(pagesBefore);
          expect(seen).toEqual([]);
        } finally {
          await engine.executeRaw("DELETE FROM pages WHERE source_id IN ($1,$2)", [active, archived]);
          await engine.executeRaw("DELETE FROM sources WHERE id IN ($1,$2)", [active, archived]);
        }
      });

      test('an unsealed page is reported, not repaired, and its live vectors survive', async () => {
        await engine.executeRaw(`UPDATE pages SET text_projection_revision = NULL WHERE slug = 'notes/bravo'`);
        try {
          const before = await liveSpace();
          const result = await runEmbedCore(engine, { stale: true, quiet: true, embeddingColumn: COLUMN });
          expect(result.embedded).toBe(SLUGS.length - 1);
          const blocked = await runEmbedCore(engine, { slugs: ['notes/bravo'], quiet: true, embeddingColumn: COLUMN });
          expect(blocked.failures).toBe(1);
          expect(blocked.failure_samples.join('\n')).toContain('notes/bravo');
          expect((await staged()).find(row => row.slug === 'notes/bravo')?.dims).toBeNull();
          expect(seen.some(call => call.value.includes('bravo'))).toBe(false);
          expect(await liveSpace()).toEqual(before);
        } finally {
          await engine.executeRaw(`UPDATE pages SET text_projection_revision = knowledge_revision WHERE slug = 'notes/bravo'`);
        }
      });

      test('archived independent work counts missing and stale page stamps, preserves current stamps, and respects scope and exclusions', async () => {
        await runEmbedCore(engine, { stale: true, quiet: true, embeddingColumn: COLUMN });
        await engine.executeRaw(`UPDATE content_chunks SET modality='image', ${COLUMN}=NULL
          WHERE page_id=(SELECT id FROM pages WHERE slug='notes/charlie')`);
        await engine.executeRaw("UPDATE sources SET archived=true WHERE id='default'");
        seen = [];
        const archived = async (sourceId = 'default') => {
          const before = await liveSpace();
          const result = await runEmbedCore(engine, { stale: true, quiet: true, sourceId, embeddingColumn: COLUMN });
          expect(await liveSpace()).toEqual(before);
          return result;
        };
        try {
          expect((await archived()).failures).toBe(0);
          await engine.executeRaw(`UPDATE pages SET ${COLUMN}_signature=NULL WHERE slug='notes/alpha'`);
          expect((await archived()).failures).toBe(1);
          await engine.executeRaw(`UPDATE pages SET ${COLUMN}_signature='obsolete-space:obsolete-page' WHERE slug='notes/bravo'`);
          const blocked = await archived();
          expect(blocked.failures).toBe(2);
          expect(blocked.failure_samples.join('\n')).toContain('2 archived page(s)');
          expect((await archived('unrelated-source')).failures).toBe(0);
          await engine.executeRaw(`UPDATE pages SET frontmatter=frontmatter || '{"embed_skip":true}'::jsonb WHERE slug='notes/alpha'`);
          expect((await archived()).failures).toBe(1);
          await engine.executeRaw(`UPDATE pages SET frontmatter=frontmatter || '{"embed_skip":true}'::jsonb WHERE slug='notes/bravo'`);
          expect((await archived()).failures).toBe(0);
          expect(seen).toEqual([]);
        } finally {
          await engine.executeRaw("UPDATE sources SET archived=false WHERE id='default'");
          await engine.executeRaw("UPDATE content_chunks SET modality='text' WHERE page_id=(SELECT id FROM pages WHERE slug='notes/charlie')");
          await engine.executeRaw("UPDATE pages SET frontmatter=frontmatter - 'embed_skip' WHERE slug IN ('notes/alpha','notes/bravo')");
          // Frontmatter writes advance the page revision even when restoring embed_skip.
          // These fixtures deliberately retain unchanged text, so restore their sealed projection too.
          await engine.executeRaw("UPDATE pages SET text_projection_revision=knowledge_revision WHERE slug IN ('notes/alpha','notes/bravo')");
        }
      });

      test('single-page and --all staging exclude image chunks without changing primary vectors', async () => {
        await engine.executeRaw("UPDATE content_chunks SET modality='image' WHERE page_id=(SELECT id FROM pages WHERE slug='notes/alpha')");
        try {
          const before = await liveSpace();
          const result = await runEmbedCore(engine, { slugs: ['notes/alpha'], quiet: true, embeddingColumn: COLUMN });
          expect(result.embedded).toBe(0);
          expect(result.failures).toBe(0);
          expect(seen).toEqual([]);
          expect((await staged()).find(row => row.slug === 'notes/alpha')?.dims).toBeNull();
          expect(await liveSpace()).toEqual(before);
          const all = await runEmbedCore(engine, { all: true, quiet: true, embeddingColumn: COLUMN });
          expect(all.embedded).toBe(SLUGS.length - 1);
          expect(all.failures).toBe(0);
          expect((await staged()).find(row => row.slug === 'notes/alpha')?.dims).toBeNull();
          expect(await liveSpace()).toEqual(before);
        } finally {
          await engine.executeRaw("UPDATE content_chunks SET modality='text' WHERE page_id=(SELECT id FROM pages WHERE slug='notes/alpha')");
        }
      });

      if (backend === 'postgres') test('initialized registry updates need no DDL lock; blocked new layouts abort atomically', async () => {
        const holder = postgres(postgresDatabaseUrl!, { max: 1, prepare: false });
        const blockedName = 'embedding_blocked';
        const entry = REGISTRY[COLUMN]!;
        try {
          await holder.begin(async held => {
            await held.unsafe('LOCK TABLE content_chunks IN ROW EXCLUSIVE MODE');
            const before = await liveSpace();
            await initializeIndependentEmbeddingColumn(engine, COLUMN, entry);
            await engine.setConfig('embedding_columns', JSON.stringify(REGISTRY));
            for (const change of [
              () => initializeIndependentEmbeddingColumn(engine, blockedName, entry),
              () => engine.setConfig('embedding_columns', JSON.stringify({ ...REGISTRY, [blockedName]: entry })),
            ]) {
              await expect(change()).rejects.toMatchObject({ code: '55P03' });
              expect(await engine.getConfig('embedding_columns')).toBe(JSON.stringify(REGISTRY));
              const [layout] = await engine.executeRaw<{ exists: boolean }>(
                "SELECT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='content_chunks'::regclass AND attname=$1 AND NOT attisdropped) AS exists", [blockedName]);
              expect(layout?.exists).toBe(false);
              expect(await liveSpace()).toEqual(before);
            }
            await held.unsafe('SELECT 1');
          });
        } finally { await holder.end(); }
      }, 15_000);

      test('only a registered, initialized independent column can be targeted', async () => {
        const before = await liveSpace();
        await expect(runEmbedCore(engine, { stale: true, dryRun: true, embeddingColumn: 'embedding' })).rejects.toBeInstanceOf(EmbeddingStagingTargetError);
        await expect(runEmbedCore(engine, { stale: true, embeddingColumn: 'embedding_absent' })).rejects.toBeInstanceOf(EmbeddingColumnNotRegisteredError);
        await engine.executeRaw('ALTER TABLE content_chunks ADD COLUMN embedding_mxbai vector(2)');
        await expect(engine.setConfig('embedding_columns', JSON.stringify({
          ...REGISTRY,
          embedding_mxbai: { provider: 'ollama:mxbai-embed-large', dimensions: 1024, type: 'vector', provenance: 'independent' },
        }))).rejects.toThrow('must be vector(1024)');
        expect(await engine.getConfig('embedding_columns')).toBe(JSON.stringify(REGISTRY));
        expect(seen).toEqual([]);
        expect(await liveSpace()).toEqual(before);
      });

      test('registry replacement cannot erase, downgrade or relabel an independent space', async () => {
        await runEmbedCore(engine, { stale: true, quiet: true, embeddingColumn: COLUMN });
        const before = await liveSpace();
        const stagedBefore = await staged();
        for (const registry of [{}, { [COLUMN]: { provider: NOMIC, dimensions: DIMS, type: 'vector' } },
          { [COLUMN]: { ...REGISTRY[COLUMN], provider: 'ollama:mxbai-embed-large' } }]) {
          await expect(engine.setConfig('embedding_columns', JSON.stringify(registry))).rejects.toThrow('Refusing');
        }
        await expect(engine.unsetConfig('embedding_columns')).rejects.toThrow('Refusing');
        expect(await engine.getConfig('embedding_columns')).toBe(JSON.stringify(REGISTRY));
        expect(await staged()).toEqual(stagedBefore);
        expect(await liveSpace()).toEqual(before);
      });

      test('missing page publication proof is recovered without another provider call', async () => {
        await runEmbedCore(engine, { stale: true, quiet: true, embeddingColumn: COLUMN });
        const before = await liveSpace();
        await engine.executeRaw(`UPDATE pages SET ${COLUMN}_signature=NULL`);
        const ids = (await engine.executeRaw<{ id: number }>('SELECT id FROM content_chunks')).map(row => row.id);
        expect((await engine.getEmbeddingsByChunkIds(ids, COLUMN)).size).toBe(0);
        seen = [];
        const result = await runEmbedCore(engine, { stale: true, quiet: true, embeddingColumn: COLUMN });
        expect(result.embedded).toBe(0);
        expect(seen).toEqual([]);
        expect((await engine.getEmbeddingsByChunkIds(ids, COLUMN)).size).toBe(SLUGS.length);
        expect(await liveSpace()).toEqual(before);
      });
    });
  });
}

describe('parseEmbeddingColumnArg', () => {

  test('refuses a missing value, a repeat and flags a staging run cannot honor', () => {
    expect(() => parseEmbeddingColumnArg(['--stale', '--embedding-column'])).toThrow(EmbeddingStagingTargetError);
    expect(() => parseEmbeddingColumnArg(['--embedding-column', '--stale'])).toThrow(EmbeddingStagingTargetError);
    expect(() => parseEmbeddingColumnArg(['--embedding-column', COLUMN, '--embedding-column', 'x'])).toThrow(EmbeddingStagingTargetError);
    for (const flag of ['--facts', '--images', '--include-null-signature']) {
      expect(() => parseEmbeddingColumnArg(['--stale', flag, '--embedding-column', COLUMN])).toThrow(EmbeddingStagingTargetError);
    }
  });
});
