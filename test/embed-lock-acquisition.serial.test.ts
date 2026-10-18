import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { runEmbedCore } from '../src/commands/embed.ts';
import { tryAcquireDbLock } from '../src/core/db-lock.ts';
import { embedBackfillLockId } from '../src/core/embed-backfill-lock.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { initializeIndependentEmbeddingColumn } from '../src/core/embedding-column-schema.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

for (const backend of testBackends()) {
  describe(`single-flight acquisition fails closed (${backend})`, () => {
    let engine: BrainEngine;
    let closePostgres: (() => Promise<void>) | undefined;
    let scratch: string;
    let savedHome: string | undefined;
    let providerCalls = 0;
    const opts = { stale: true, singleFlight: true, quiet: true, embeddingColumn: 'embedding_nomic' };
    const guardedLock = embedBackfillLockId('default');

    const protectedRows = () => engine.executeRaw(`SELECT p.id,p.slug,p.knowledge_revision,p.text_projection_revision,
      p.embedding_signature,c.id AS chunk_id,c.chunk_text,c.embedding::text,c.model,c.embedding_input_hash,
      c.embedding_nomic::text AS nomic,c.embedding_nomic_model,c.embedding_nomic_embedding_input_hash
      FROM pages p JOIN content_chunks c ON c.page_id=p.id ORDER BY c.id`);
    const leases = () => engine.executeRaw('SELECT id,holder_pid,acquisition_token FROM gbrain_cycle_locks ORDER BY id');

    beforeAll(async () => {
      savedHome = process.env.GBRAIN_HOME;
      scratch = mkdtempSync(join(tmpdir(), 'gbrain-embed-acquisition-'));
      process.env.GBRAIN_HOME = scratch;
      configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536,
        env: { OPENAI_API_KEY: 'sk-test-fake' } });
      __setEmbedTransportForTests(async ({ values }: { values: string[] }) => {
        providerCalls++;
        return { embeddings: values.map(() => Array.from({ length: 768 }, (_, i) => i === 0 ? 1 : 0)),
          usage: { tokens: values.length } } as never;
      });
      if (backend === 'postgres') ({ engine, close: closePostgres } = await isolatedPersistencePostgres(process.env.DATABASE_URL!, 'instance', 1));
      else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
      await importFromContent(engine, 'notes/acquisition', '---\ntype: note\ntitle: Synthetic lease fixture\n---\n\nSynthetic lease admission content.\n', { noEmbed: true });
      await initializeIndependentEmbeddingColumn(engine, 'embedding_nomic', {
        provider: 'ollama:nomic-embed-text', dimensions: 768, type: 'vector', provenance: 'independent',
        documentPrefix: 'search_document: ', queryPrefix: 'search_query: ',
      });
    }, 120_000);

    afterAll(async () => {
      __setEmbedTransportForTests(null);
      resetGateway();
      if (closePostgres) await closePostgres();
      else await engine?.disconnect();
      if (savedHome === undefined) delete process.env.GBRAIN_HOME;
      else process.env.GBRAIN_HOME = savedHome;
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    }, 60_000);

    test('source discovery failure rejects without entering the drain or changing vectors', async () => {
      const before = await protectedRows();
      const fault = new Error('synthetic source census failure');
      const census = spyOn(engine, 'listAllSources').mockRejectedValueOnce(fault);
      const drain = spyOn(engine, 'countStaleChunks');
      try {
        await expect(runEmbedCore(engine, opts)).rejects.toBe(fault);
        expect(drain).not.toHaveBeenCalled();
        expect(providerCalls).toBe(0);
        expect(await protectedRows()).toEqual(before);
        expect(await leases()).toEqual([]);
      } finally { census.mockRestore(); drain.mockRestore(); }
    });

    for (const partial of [false, true]) {
      test(`database acquisition error rejects and releases partial ownership (${partial})`, async () => {
        const before = await protectedRows();
        const sources = await engine.listAllSources();
        const census = partial ? spyOn(engine, 'listAllSources').mockResolvedValue([
          { ...sources[0]!, id: 'aaa-before-fault' }, ...sources,
        ]) : undefined;
        await engine.executeRaw(`ALTER TABLE gbrain_cycle_locks ADD CONSTRAINT embed_acquisition_fault CHECK (id <> '${guardedLock}')`);
        const drain = spyOn(engine, 'countStaleChunks');
        try {
          await expect(runEmbedCore(engine, opts)).rejects.toThrow('embed_acquisition_fault');
          expect(drain).not.toHaveBeenCalled();
          expect(providerCalls).toBe(0);
          expect(await protectedRows()).toEqual(before);
          expect(await leases()).toEqual([]);
        } finally {
          drain.mockRestore();
          census?.mockRestore();
          await engine.executeRaw('ALTER TABLE gbrain_cycle_locks DROP CONSTRAINT embed_acquisition_fault');
        }
      });
    }

    test('busy source remains an incomplete lock skip and preserves its owner', async () => {
      const owner = await tryAcquireDbLock(engine, guardedLock, 60);
      expect(owner).not.toBeNull();
      const before = await protectedRows();
      const beforeLeases = await leases();
      const sources = await engine.listAllSources();
      const census = spyOn(engine, 'listAllSources').mockResolvedValue([
        { ...sources[0]!, id: 'aaa-before-busy' }, ...sources,
      ]);
      try {
        const result = await runEmbedCore(engine, opts);
        expect(result.lock_skipped).toBe(true);
        expect(result.embedded).toBe(0);
        expect(providerCalls).toBe(0);
        expect(await protectedRows()).toEqual(before);
        expect(await leases()).toEqual(beforeLeases);
      } finally { census.mockRestore(); await owner?.release(); }
    });

    test('owned source can stage normally and releases its lease on completion', async () => {
      const result = await runEmbedCore(engine, { ...opts, sourceId: 'default' });
      expect(result.lock_skipped).toBeFalsy();
      expect(result.lock_lost).toBeFalsy();
      expect(result.failures).toBe(0);
      expect(result.embedded).toBe(1);
      expect(providerCalls).toBe(1);
      expect(await leases()).toEqual([]);
      const [row] = await engine.executeRaw<{ dims: number; model: string }>(
        'SELECT vector_dims(embedding_nomic) AS dims,embedding_nomic_model AS model FROM content_chunks');
      expect(row).toEqual({ dims: 768, model: 'ollama:nomic-embed-text' });
    });
  });
}
