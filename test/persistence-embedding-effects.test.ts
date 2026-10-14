import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { EFFECT_RENEWAL_INTERVAL_MS, __setEffectRenewalIntervalForTests, effectRenewalInterval, runPersistenceEffects, type EffectWorkerOptions } from '../src/core/persistence/effects.ts';
import { claimPersistenceEffect, publicEffectsForRequest } from '../src/core/persistence/effect-journal.ts';
import { localHostId, registerLocalWriter } from '../src/core/persistence/identity.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite, claimNextWrite, getWriteRequestById } from '../src/core/persistence/journal.ts';
import { publishMutation } from '../src/core/persistence/coordinator.ts';
import { installPageEmbeddings, installPageProjection, readProjectionSnapshot, rebuildPendingPageProjections } from '../src/core/page-state/projections.ts';
import { MAX_RATE_LIMIT_RETRIES } from '../src/core/embed-retry.ts';
import { AIConfigError } from '../src/core/ai/errors.ts';
import { EmbeddingZeroNormError } from '../src/core/ai/embedding-guard.ts';
import { initializeIndependentEmbeddingColumn } from '../src/core/embedding-column-schema.ts';
import { embeddingColumnSignature } from '../src/core/search/embedding-column.ts';
import { PersistenceConsumer } from '../src/core/persistence/consumer.ts';
import { embeddingInputHash } from '../src/core/embedding-input-hash.ts';
import { invokeAI, isAIInvocationPolicyError, withAIInvocationGuard } from '../src/core/ai/invocation-guard.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { saveConfig } from '../src/core/config.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { testWaitMs } from './helpers/wait-for.ts';

const databaseUrl = process.env.DATABASE_URL;
/**
 * Claim renewal runs at this interval instead of the production 10 s. Every
 * renewal-timing case below is expressed in renewal intervals, including the
 * fixture lease (1.5 intervals, as 15 s is to 10 s), so the takeover attempts
 * still land after the unrenewed lease would have expired.
 */
const renewalMs = testWaitMs(1_500);
let restoreRenewal: () => void = () => {};
beforeEach(() => { restoreRenewal = __setEffectRenewalIntervalForTests(renewalMs); });
afterEach(() => { restoreRenewal(); expect(effectRenewalInterval()).toBe(EFFECT_RENEWAL_INTERVAL_MS); });
for (const kind of testBackends()) {
  describe(`embedding effects ${kind}`, () => {
    let engine: BrainEngine;
    let scratch: string;
    let close: (() => Promise<void>) | undefined;
    const page = (body: string) => ({ type: 'note', title: 'Example', compiled_truth: body, timeline: '', frontmatter: {} });
    const signature = 'test:model:1536';
    const model = 'test:model';
    const vectors = () => [new Float32Array(1536).fill(0.1)];
    beforeAll(async () => {
      scratch = mkdtempSync(join(tmpdir(), 'gbrain-embedding-effects-'));
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(databaseUrl!));
      else {
        engine = new PGLiteEngine();
        await engine.connect({ database_path: join(scratch, 'brain') }); await engine.initSchema();
      }
    }, 120_000);
    afterAll(async () => {
      await engine?.disconnect();
      if (close) await close();
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    });
    const check = (name: string, fn: () => Promise<void>) => test(name, () => withEnv({ GBRAIN_HOME: scratch }, fn), 120_000);
    async function fixture() {
      await registerLocalWriter(engine, 'cli');
      const sourceId = `embedding-${randomUUID()}`;
      const [source] = await engine.executeRaw<{ incarnation: string }>('INSERT INTO sources(id,name) VALUES($1,$1) RETURNING incarnation', [sourceId]);
      const ctx: OperationContext = { engine, config: { engine: engine.kind }, remote: false, dryRun: false, sourceId,
        logger: { info() {}, warn() {}, error() {} } };
      const authority = await submissionAuthority(ctx, 'put_page', sourceId, source.incarnation, 'page');
      const admitted = await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId,
        sourceIncarnation: source.incarnation, slug: 'page', requestId: randomUUID(), callerIntent: { body: 'Current' }, intent: { body: 'Current' } });
      const row = (await claimNextWrite(engine, localHostId()))!;
      expect(row.id).toBe(admitted.id);
      await publishMutation(engine, row, { observedRevision: null, apply: async tx => {
        await tx.putPage('page', page('Current'), { sourceId }); return {};
      } }, localHostId());
      const prepared = (await readProjectionSnapshot(engine, 'page', sourceId, { allowUnsealed: true }))!;
      await installPageProjection(engine, prepared, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'Current' }], { seal: true });
      await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now()+interval '1 hour'");
      const [effect] = await engine.executeRaw<{ id: string }>("UPDATE persistence_effects SET next_attempt_at=now() WHERE request_id=$1::uuid AND kind='embedding' RETURNING id", [row.id]);
      return { sourceId, row, effectId: effect.id, snapshot: prepared.snapshot };
    }
    async function run(embed: NonNullable<EffectWorkerOptions['embedding']>['embed'], signal?: AbortSignal, disabled = false) {
      await runPersistenceEffects(engine, { engine: engine.kind, embedding_disabled: disabled },
        { hostId: localHostId(), limit: 1, embedding: { signature, model, embed }, signal });
    }
    async function due(effectId: string) {
      await engine.executeRaw('UPDATE persistence_effects SET next_attempt_at=now() WHERE id=$1', [effectId]);
    }
    async function reopen() {
      const [database] = await engine.executeRaw<{ name: string }>('SELECT current_database() AS name');
      await engine.disconnect();
      if (kind === 'postgres') {
        const url = new URL(databaseUrl!); url.pathname = `/${database.name}`;
        engine = new PostgresEngine();
        await engine.connect({ database_url: url.toString() });
      } else {
        engine = new PGLiteEngine();
        await engine.connect({ database_path: join(scratch, 'brain') });
      }
    }
    async function state(effectId: string) {
      return (await engine.executeRaw<{ state: string; attempts: number; error_code: string | null; wait_ms: number }>(
        'SELECT state,attempts,error_code,EXTRACT(EPOCH FROM next_attempt_at-now())*1000 AS wait_ms FROM persistence_effects WHERE id=$1', [effectId]))[0];
    }

    check('already-complete projection uses provenance without reading vectors or calling the provider', async () => {
      const f = await fixture();
      const prepared = (await readProjectionSnapshot(engine, 'page', f.sourceId))!;
      expect(await installPageEmbeddings(engine, prepared, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'Current', embedding: vectors()[0], model }], signature)).toBe(true);
      expect((await readProjectionSnapshot(engine, 'page', f.sourceId))!.chunks[0].embedding).toBeNull();
      let calls = 0;
      await run(async () => { calls++; return vectors(); });
      expect(calls).toBe(0);
      expect((await state(f.effectId)).state).toBe('committed');
      expect((await getWriteRequestById(engine, f.row.id))!.state).toBe('committed');
    });

    for (const stale of ['null-vector', 'text-hash', 'model', 'signature'] as const) {
      check(`stale ${stale} is not mistaken for a complete projection`, async () => {
        const f = await fixture();
        const prepared = (await readProjectionSnapshot(engine, 'page', f.sourceId))!;
        await installPageEmbeddings(engine, prepared, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'Current', embedding: vectors()[0], model }], signature);
        if (stale === 'null-vector') await engine.executeRaw('UPDATE content_chunks SET embedding=NULL WHERE page_id=$1', [f.snapshot.page.id]);
        else if (stale === 'text-hash') await engine.executeRaw("UPDATE content_chunks SET embedded_text_hash='stale' WHERE page_id=$1", [f.snapshot.page.id]);
        else if (stale === 'model') await engine.executeRaw("UPDATE content_chunks SET model='old:model' WHERE page_id=$1", [f.snapshot.page.id]);
        else await engine.executeRaw("UPDATE pages SET embedding_signature='old' WHERE id=$1", [f.snapshot.page.id]);
        let calls = 0;
        await run(async () => { calls++; return vectors(); });
        expect(calls).toBe(1);
        expect((await state(f.effectId)).state).toBe('committed');
      });
    }

    check('a partially complete page sends only stale chunks and preserves valid sibling vectors', async () => {
      const f = await fixture();
      const prepared = (await readProjectionSnapshot(engine, 'page', f.sourceId))!;
      await installPageProjection(engine, prepared, [
        { chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'Current', embedding: vectors()[0], model },
        { chunk_index: 1, chunk_source: 'compiled_truth', chunk_text: 'Missing' },
      ], { seal: true, signature });
      const [before] = await engine.executeRaw<{ embedded_at: string }>('SELECT embedded_at::text FROM content_chunks WHERE page_id=$1 AND chunk_index=0', [f.snapshot.page.id]);
      let sent: string[] = [];
      await run(async texts => { sent = texts; return [new Float32Array(1536).fill(0.75)]; });
      expect(sent).toEqual(['Missing']);
      expect((await state(f.effectId)).state).toBe('committed');
      const chunks = await engine.getChunks('page', { sourceId: f.sourceId, includeEmbedding: true });
      expect(chunks[0].embedding?.[0]).toBeCloseTo(0.1);
      expect(chunks[1].embedding?.[0]).toBe(0.75);
      expect((await engine.executeRaw<{ embedded_at: string }>('SELECT embedded_at::text FROM content_chunks WHERE page_id=$1 AND chunk_index=0', [f.snapshot.page.id]))[0].embedded_at).toBe(before.embedded_at);
    });

    // CLI staging never claims a durable effect. This case protects the effect's
    // partial-refusal publication: a target refusal must clear its stale vector
    // and proof, install the usable sibling and preserve every primary byte.
    // Uses the existing embed seam; no provider request or new production seam.
    check('an independent target zero-norm refusal clears only its own vector and provenance', async () => {
      const f = await fixture();
      const name = 'embedding_refusal_effect';
      const targetModel = 'ollama:nomic-embed-text';
      const previousColumn = await engine.getConfig('search_embedding_column');
      const previousRegistry = await engine.getConfig('embedding_columns');
      const prepared = (await readProjectionSnapshot(engine, 'page', f.sourceId))!;
      await installPageProjection(engine, prepared, [
        { chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'Current', embedding: vectors()[0], model },
        { chunk_index: 1, chunk_source: 'compiled_truth', chunk_text: 'Missing', embedding: new Float32Array(1536).fill(0.2), model },
      ], { seal: true, signature });
      const primary = () => engine.executeRaw(`SELECT cc.id,cc.chunk_index,cc.chunk_source,cc.chunk_text,
          cc.embedding::text AS vector,cc.model,cc.embedded_text_hash,cc.embedding_input_hash,
          cc.embedded_at::text AS embedded_at,cc.embedding_pending_since::text AS pending_since,
          p.embedding_signature,p.contextual_retrieval_mode,p.text_projection_revision::text AS projection,p.chunker_version
        FROM content_chunks cc JOIN pages p ON p.id=cc.page_id WHERE p.id=$1 ORDER BY cc.chunk_index`, [f.snapshot.page.id]);
      const before = await primary();
      const column = await initializeIndependentEmbeddingColumn(engine, name, { provider: targetModel, dimensions: 768,
        type: 'vector', provenance: 'independent', documentPrefix: 'search_document: ' });
      try {
        await engine.setConfig('search_embedding_column', name);
        const target = (await readProjectionSnapshot(engine, 'page', f.sourceId))!;
        expect(await installPageEmbeddings(engine, target, target.chunks.map(chunk => ({ chunk_index: chunk.chunk_index,
          chunk_source: chunk.chunk_source, chunk_text: chunk.chunk_text, embedding: new Float32Array(768).fill(0.5),
          model: targetModel })), 'target-seed')).toBe(true);
        const [seed] = await engine.executeRaw<{ vectors: number; stamped: boolean }>(
          `SELECT count(cc.${name})::int AS vectors,bool_and(p.${name}_signature IS NOT NULL) AS stamped
            FROM content_chunks cc JOIN pages p ON p.id=cc.page_id WHERE p.id=$1`, [f.snapshot.page.id]);
        expect(seed).toEqual({ vectors: 2, stamped: true });
        // The old target vectors must be replaced or cleared, not mistaken for
        // current work simply because the primary space remains fully embedded.
        await engine.executeRaw(`UPDATE content_chunks SET ${name}_embedding_input_hash='obsolete-input'
          WHERE page_id=$1`, [f.snapshot.page.id]);
        let calls = 0;
        await run(async (texts, options) => {
          calls++;
          expect(texts).toEqual(['search_document: Current', 'search_document: Missing']);
          expect(options).toMatchObject({ embeddingModel: targetModel, dimensions: column.dimensions, maxRetries: 0 });
          throw new EmbeddingZeroNormError([{ index: 0, reason: 'zero_norm' }],
            [null, new Float32Array(768).fill(0.75)], targetModel);
        });
        expect(calls).toBe(1);
        expect(await state(f.effectId)).toMatchObject({ state: 'failed', attempts: 1, error_code: 'embedding_zero_norm' });
        const rows = await engine.executeRaw(`SELECT cc.chunk_index,cc.${name}::text AS vector,
            vector_dims(cc.${name}) AS dims,cc.${name}_model AS model,
            cc.${name}_embedded_text_hash AS text_hash,cc.${name}_embedding_input_hash AS input_hash,
            cc.${name}_embedded_at IS NOT NULL AS stamped,cc.${name}_pending_since IS NOT NULL AS pending,
            p.${name}_signature AS signature
          FROM content_chunks cc JOIN pages p ON p.id=cc.page_id WHERE p.id=$1 ORDER BY cc.chunk_index`, [f.snapshot.page.id]);
        expect(rows).toHaveLength(2);
        expect(rows[0]).toEqual({ chunk_index: 0, vector: null, dims: null, model: targetModel,
          text_hash: null, input_hash: null, stamped: false, pending: true, signature: null });
        expect(rows[1]).toMatchObject({ chunk_index: 1, dims: 768, model: targetModel,
          stamped: true, pending: false, signature: null });
        expect(rows[1]!.vector).toBe(`[${Array(768).fill(0.75).join(',')}]`);
        expect(rows[1]!.text_hash).toMatch(/^[0-9a-f]{32}$/);
        expect(rows[1]!.input_hash).toBe(embeddingInputHash({ column: name, model: targetModel, dimensions: 768,
          title: 'Example', corpusGeneration: null, bodyHash: '', documentPrefix: 'search_document: ', independent: true },
        'none', { chunk_text: 'Missing', chunk_source: 'compiled_truth' }));
        expect(await primary()).toEqual(before);
        expect((await getWriteRequestById(engine, f.row.id))!.state).toBe('committed');
      } finally {
        if (previousColumn === null) await engine.executeRaw("DELETE FROM config WHERE key='search_embedding_column'");
        else await engine.setConfig('search_embedding_column', previousColumn);
        await engine.executeRaw(`ALTER TABLE content_chunks DROP COLUMN ${name},DROP COLUMN ${name}_model,
          DROP COLUMN ${name}_embedded_text_hash,DROP COLUMN ${name}_embedding_input_hash,
          DROP COLUMN ${name}_embedded_at,DROP COLUMN ${name}_pending_since`);
        await engine.executeRaw(`ALTER TABLE pages DROP COLUMN ${name}_signature`);
        // Remove only this disposable fixture's registry entry; normal registry
        // writes intentionally refuse deleting an independent model space.
        if (previousRegistry === null) await engine.executeRaw("DELETE FROM config WHERE key='embedding_columns'");
        else await engine.executeRaw("UPDATE config SET value=$1 WHERE key='embedding_columns'", [previousRegistry]);
      }
    });

    check('a partial synopsis projection rebuilds every chunk before demoting the page to title context', async () => {
      const f = await fixture();
      await engine.updatePageContextualRetrievalState('page', f.sourceId, 'per_chunk_synopsis', 'old-synopsis');
      const prepared = (await readProjectionSnapshot(engine, 'page', f.sourceId))!;
      await installPageProjection(engine, prepared, [
        { chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'Current', embedding: vectors()[0], model },
        { chunk_index: 1, chunk_source: 'compiled_truth', chunk_text: 'Missing' },
      ], { seal: true, signature });
      let sent: string[] = [];
      await run(async texts => { sent = texts; return texts.map(() => new Float32Array(1536).fill(0.75)); });
      expect(sent).toHaveLength(2);
      expect((await state(f.effectId)).state).toBe('committed');
      expect((await engine.readPageSnapshot('page', { sourceId: f.sourceId }))!.page.contextual_retrieval_mode).toBe('title');
      const chunks = await engine.getChunks('page', { sourceId: f.sourceId, includeEmbedding: true });
      expect(chunks.every(chunk => chunk.embedding?.[0] === 0.75)).toBe(true);
    });

    check('durable failures back off, exhaust visibly, and never change the canonical receipt', async () => {
      const f = await fixture();
      let calls = 0;
      for (let attempt = 1; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
        await due(f.effectId);
        await run(async () => { calls++; throw new Error('network timeout'); });
        const current = await state(f.effectId);
        expect(current.attempts).toBe(attempt);
        expect(current.state).toBe(attempt === MAX_RATE_LIMIT_RETRIES ? 'failed' : 'queued');
        if (attempt < MAX_RATE_LIMIT_RETRIES) expect(Number(current.wait_ms)).toBeGreaterThan(400 * 2 ** (attempt - 1));
        if (attempt === 2) await reopen();
      }
      await due(f.effectId); await run(async () => { calls++; return vectors(); });
      expect(calls).toBe(MAX_RATE_LIMIT_RETRIES);
      expect(await publicEffectsForRequest(engine, f.row.id)).toEqual([{ kind: 'embedding', state: 'failed', reason: 'embedding_attempts_exhausted' }]);
      expect((await getWriteRequestById(engine, f.row.id))!.state).toBe('committed');
      expect((await engine.readPageSnapshot('page', { sourceId: f.sourceId }))!.revision).toBe(f.snapshot.revision);
    });

    check('expired final claim does not buy another provider attempt', async () => {
      const f = await fixture();
      await engine.executeRaw('UPDATE persistence_effects SET attempts=$2 WHERE id=$1', [f.effectId, MAX_RATE_LIMIT_RETRIES - 1]);
      expect((await claimPersistenceEffect(engine, localHostId()))!.attempts).toBe(MAX_RATE_LIMIT_RETRIES);
      await reopen();
      await engine.executeRaw("UPDATE persistence_effects SET claim_expires_at=now()-interval '1 second' WHERE id=$1", [f.effectId]);
      let calls = 0;
      await run(async () => { calls++; return vectors(); });
      expect(calls).toBe(0);
      expect((await state(f.effectId)).state).toBe('failed');
    });

    check('keyless work is skipped once rather than permanent retry noise', async () => {
      const f = await fixture();
      let calls = 0;
      await run(async () => { calls++; return vectors(); }, undefined, true);
      await due(f.effectId); await run(async () => { calls++; return vectors(); }, undefined, true);
      expect(calls).toBe(0);
      expect(await publicEffectsForRequest(engine, f.row.id)).toEqual([{ kind: 'embedding', state: 'skipped', reason: 'embedding_disabled' }]);
      expect((await state(f.effectId)).attempts).toBe(1);
    });

    check('an unconfigured embedding signature is a terminal skip without provider work', async () => {
      const f = await fixture();
      let calls = 0;
      await runPersistenceEffects(engine, { engine: engine.kind }, { hostId: localHostId(), limit: 1,
        embedding: { signature: '', model, embed: async () => { calls++; return vectors(); } } });
      expect(calls).toBe(0);
      expect(await publicEffectsForRequest(engine, f.row.id)).toEqual([{ kind: 'embedding', state: 'skipped', reason: 'embedding_unconfigured' }]);
    });

    check('provider work happens outside transactions and uses the caller budget signal unchanged', async () => {
      const f = await fixture();
      let depth = 0;
      const observed = new Proxy(engine, { get(target, key) {
        if (key === 'transaction' || key === 'transactionDirect') return async <T>(work: (tx: BrainEngine) => Promise<T>) => {
          depth++;
          try { return await target[key](work); } finally { depth--; }
        };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      const controller = new AbortController();
      let calls = 0;
      await runPersistenceEffects(observed, { engine: engine.kind }, { hostId: localHostId(), limit: 1, signal: controller.signal,
        embedding: { signature, model, embed: async (_texts, options) => {
          calls++;
          expect(depth).toBe(0);
          expect(options?.abortSignal?.aborted).toBe(false);
          return vectors();
        } } });
      expect(calls).toBe(1);
      expect((await state(f.effectId)).state).toBe('committed');
    });

    check('permanent provider configuration failure stops after one attempt', async () => {
      const f = await fixture();
      await run(async () => { throw new AIConfigError('invalid credentials'); });
      expect(await state(f.effectId)).toMatchObject({ state: 'failed', attempts: 1, error_code: 'embedding_configuration' });
    });

    check('existing budget admission refusal cannot be retried as a provider outage', async () => {
      const f = await fixture();
      let calls = 0;
      await withAIInvocationGuard(async () => { throw new Error('budget refused'); }, () => run(async () =>
        invokeAI({ operation: 'embed', kind: 'embedding', model }, async () => { calls++; return vectors(); }, () => null)));
      expect(calls).toBe(0);
      expect(await state(f.effectId)).toMatchObject({ state: 'failed', attempts: 1, error_code: 'embedding_budget_refused' });
    });

    check('rate-limit failures retain the existing provider-hint backoff', async () => {
      const f = await fixture();
      await run(async () => { throw Object.assign(new Error('Please try again in 120s'), { status: 429 }); });
      const current = await state(f.effectId);
      expect(current.state).toBe('queued');
      expect(Number(current.wait_ms)).toBeGreaterThan(80_000);
      expect(Number(current.wait_ms)).toBeLessThan(160_000);
    });

    check('caller abort discards even a provider that returns vectors after cancellation', async () => {
      const f = await fixture();
      const controller = new AbortController();
      const reason = new Error('caller budget cancelled');
      await run(async (_texts, options) => {
        expect(options?.maxRetries).toBe(0);
        controller.abort(reason);
        expect(options?.abortSignal?.aborted).toBe(true);
        expect(options?.abortSignal?.reason).toBe(reason);
        return vectors();
      }, controller.signal);
      expect(await engine.executeRaw('SELECT id FROM content_chunks WHERE page_id=$1 AND embedding IS NOT NULL', [f.snapshot.page.id])).toHaveLength(0);
      expect((await state(f.effectId)).state).toBe('queued');
      await due(f.effectId); await run(async () => vectors());
      expect((await state(f.effectId)).state).toBe('committed');
    });

    check('caller cancellation reaches an in-flight provider with the exact reason', async () => {
      const f = await fixture();
      const controller = new AbortController();
      const reason = new Error('caller deadline');
      const started = Promise.withResolvers<void>();
      let observed: unknown;
      const worker = run(async (_texts, options) => {
        started.resolve();
        return new Promise((_resolve, reject) => options!.abortSignal!.addEventListener('abort', () => {
          observed = options!.abortSignal!.reason;
          reject(observed);
        }, { once: true }));
      }, controller.signal);
      await started.promise;
      controller.abort(reason);
      await worker;
      expect(observed).toBe(reason);
      expect(await state(f.effectId)).toMatchObject({ state: 'queued', attempts: 1, error_code: 'embedding_aborted' });
      expect(await engine.executeRaw('SELECT id FROM content_chunks WHERE page_id=$1 AND embedding IS NOT NULL', [f.snapshot.page.id])).toHaveLength(0);
      await due(f.effectId);
      await run(async () => { throw new Error('Aborted caller must never invoke provider'); }, controller.signal);
      expect(await state(f.effectId)).toMatchObject({ state: 'queued', attempts: 1 });
    });

    check('lost lease aborts the provider and stops renewals without overwriting the successor claim', async () => {
      const f = await fixture();
      const successor = randomUUID();
      let renewals = 0;
      const observed = new Proxy(engine, { get(target, key) {
        if (key === 'executeRawDirect') return async (...args: Parameters<BrainEngine['executeRawDirect']>) => {
          if (args[0].includes('UPDATE persistence_effects SET claim_expires_at')) renewals++;
          return target.executeRawDirect(...args);
        };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      let reason: unknown;
      await runPersistenceEffects(observed, { engine: engine.kind }, { hostId: localHostId(), limit: 1,
        embedding: { signature, model, embed: async (_texts, options) => {
          await engine.executeRaw('UPDATE persistence_effects SET execution_token=$2::uuid WHERE id=$1', [f.effectId, successor]);
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Lost lease did not cancel the provider')), 20_000);
            options!.abortSignal!.addEventListener('abort', () => { clearTimeout(timeout); reason = options!.abortSignal!.reason; resolve(); }, { once: true });
          });
          return vectors();
        } } });
      expect(reason).toMatchObject({ code: 'write_claim_lost' });
      const stoppedAt = renewals;
      await Bun.sleep(renewalMs * 1.1);
      expect(renewals).toBe(stoppedAt);
      expect((await engine.executeRaw('SELECT state,execution_token FROM persistence_effects WHERE id=$1', [f.effectId]))[0])
        .toMatchObject({ state: 'running', execution_token: successor });
      expect(await engine.executeRaw('SELECT id FROM content_chunks WHERE page_id=$1 AND embedding IS NOT NULL', [f.snapshot.page.id])).toHaveLength(0);
    });

    check('a DB policy disabled during provider work prevents vector installation', async () => {
      const f = await fixture();
      try {
        await run(async () => { await engine.setConfig('embedding_disabled', 'true'); return vectors(); });
        expect(await engine.executeRaw('SELECT id FROM content_chunks WHERE page_id=$1 AND embedding IS NOT NULL', [f.snapshot.page.id])).toHaveLength(0);
        expect(await publicEffectsForRequest(engine, f.row.id)).toEqual([{ kind: 'embedding', state: 'skipped', reason: 'embedding_disabled' }]);
      } finally { await engine.executeRaw("DELETE FROM config WHERE key='embedding_disabled'"); }
    });

    check('malformed selected DB policy parks the effect without a provider call', async () => {
      const f = await fixture();
      await engine.setConfig('embedding_disabled', 'TRUE');
      let calls = 0;
      try {
        await run(async () => { calls++; return vectors(); });
        expect(calls).toBe(0);
        expect(await state(f.effectId)).toMatchObject({ state: 'failed', error_code: 'embedding_configuration', attempts: 1 });
      } finally { await engine.executeRaw("DELETE FROM config WHERE key='embedding_disabled'"); }
    });

    for (const plane of ['db', 'file'] as const) check(`${plane} disable between provider sub-batches preserves caller budget admission and stops further spend`, async () => {
      const f = await fixture();
      const config = { engine: engine.kind, embedding_disabled: false };
      let calls = 0, permits = 0, settlements = 0;
      try {
        await withAIInvocationGuard(async () => { permits++; return { settle: async () => { settlements++; } }; }, () =>
          runPersistenceEffects(engine, config, { hostId: localHostId(), limit: 1, embedding: { signature, model, embed: async () => {
            const call = () => invokeAI({ operation: 'embed', kind: 'embedding' as const, model }, async () => { calls++; return vectors(); }, () => null);
            await call();
            if (plane === 'db') await engine.setConfig('embedding_disabled', 'true');
            else config.embedding_disabled = true;
            return call();
          } } }));
        expect(calls).toBe(1);
        expect(permits).toBe(1);
        expect(settlements).toBe(1);
        expect(await engine.executeRaw('SELECT id FROM content_chunks WHERE page_id=$1 AND embedding IS NOT NULL', [f.snapshot.page.id])).toHaveLength(0);
        expect(await publicEffectsForRequest(engine, f.row.id)).toEqual([{ kind: 'embedding', state: 'skipped', reason: 'embedding_disabled' }]);
      } finally { await engine.executeRaw("DELETE FROM config WHERE key='embedding_disabled'"); }
    });

    check('lease loss between provider sub-batches stops spend before another parent budget admission', async () => {
      const f = await fixture();
      const successor = randomUUID();
      let calls = 0, permits = 0, settlements = 0;
      await withAIInvocationGuard(async () => { permits++; return { settle: async () => { settlements++; } }; }, () =>
        run(async () => {
          const call = () => invokeAI({ operation: 'embed', kind: 'embedding' as const, model }, async () => { calls++; return vectors(); }, () => null);
          await call();
          await engine.executeRaw('UPDATE persistence_effects SET execution_token=$2::uuid WHERE id=$1', [f.effectId, successor]);
          return call();
        }));
      expect(calls).toBe(1);
      expect(permits).toBe(1);
      expect(settlements).toBe(1);
      expect((await engine.executeRaw('SELECT state,execution_token FROM persistence_effects WHERE id=$1', [f.effectId]))[0])
        .toMatchObject({ state: 'running', execution_token: successor });
      expect(await engine.executeRaw('SELECT id FROM content_chunks WHERE page_id=$1 AND embedding IS NOT NULL', [f.snapshot.page.id])).toHaveLength(0);
    });

    for (const boundary of ['policy', 'renewal'] as const) for (const sqlstate of ['08006', '55P03', '40001']) {
      check(`transient ${sqlstate} at ${boundary} preflight stops sub-batches but permits bounded recovery`, async () => {
        const f = await fixture();
        let inject = false, calls = 0, permits = 0, settlements = 0;
        let failure: unknown;
        const storageFailure = () => { inject = false; throw Object.assign(new Error('private fixture database payload'), { code: sqlstate }); };
        const observed = new Proxy(engine, { get(target, key) {
          if (key === 'getConfig') return async (name: string) => {
            if (boundary === 'policy' && inject && name === 'embedding_disabled') storageFailure();
            return target.getConfig(name);
          };
          if (key === 'executeRawDirect') return async (...args: Parameters<BrainEngine['executeRawDirect']>) => {
            if (boundary === 'renewal' && inject && args[0].includes('UPDATE persistence_effects SET claim_expires_at')) storageFailure();
            return target.executeRawDirect(...args);
          };
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        } });
        await withAIInvocationGuard(async () => { permits++; return { settle: async () => { settlements++; } }; }, () =>
          runPersistenceEffects(observed, { engine: engine.kind }, { hostId: localHostId(), limit: 1,
            embedding: { signature, model, embed: async () => {
              const call = () => invokeAI({ operation: 'embed', kind: 'embedding' as const, model }, async () => { calls++; return vectors(); }, () => null);
              await call();
              inject = true;
              try { return await call(); } catch (error) { failure = error; throw error; }
            } } }));
        expect(calls).toBe(1);
        expect(permits).toBe(1);
        expect(settlements).toBe(1);
        expect(isAIInvocationPolicyError(failure)).toBe(true);
        expect(await state(f.effectId)).toMatchObject({ state: 'queued', attempts: 1, error_code: 'embedding_storage_unavailable' });
        expect(Number((await state(f.effectId)).wait_ms)).toBeGreaterThan(400);
        expect(String(failure)).not.toContain('private fixture database payload');
        expect(await publicEffectsForRequest(engine, f.row.id)).toEqual([{ kind: 'embedding', state: 'queued', reason: 'embedding_storage_unavailable' }]);
        expect(await engine.executeRaw('SELECT id FROM content_chunks WHERE page_id=$1 AND embedding IS NOT NULL', [f.snapshot.page.id])).toHaveLength(0);
        await due(f.effectId);
        await runPersistenceEffects(observed, { engine: engine.kind }, { hostId: localHostId(), limit: 1,
          embedding: { signature, model, embed: async () => { calls++; return vectors(); } } });
        expect(calls).toBe(2);
        expect(await state(f.effectId)).toMatchObject({ state: 'committed', attempts: 2, error_code: null });
      });
    }

    check('transient preflight storage failures cannot extend the final allowed attempt', async () => {
      const f = await fixture();
      await engine.executeRaw('UPDATE persistence_effects SET attempts=$2 WHERE id=$1', [f.effectId, MAX_RATE_LIMIT_RETRIES - 1]);
      let inject = false, calls = 0;
      const observed = new Proxy(engine, { get(target, key) {
        if (key === 'getConfig') return async (name: string) => {
          if (inject && name === 'embedding_disabled') { inject = false; throw Object.assign(new Error('private fixture database payload'), { code: '08006' }); }
          return target.getConfig(name);
        };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      await runPersistenceEffects(observed, { engine: engine.kind }, { hostId: localHostId(), limit: 1,
        embedding: { signature, model, embed: async () => {
          const call = () => invokeAI({ operation: 'embed', kind: 'embedding' as const, model }, async () => { calls++; return vectors(); }, () => null);
          await call();
          inject = true;
          return call();
        } } });
      expect(calls).toBe(1);
      expect(await state(f.effectId)).toMatchObject({ state: 'failed', attempts: MAX_RATE_LIMIT_RETRIES, error_code: 'embedding_attempts_exhausted' });
      await due(f.effectId);
      await run(async () => { calls++; return vectors(); });
      expect(calls).toBe(1);
    });

    check('a superseded lease discards late vectors before installation', async () => {
      const f = await fixture();
      await run(async () => {
        await engine.executeRaw('UPDATE persistence_effects SET execution_token=$2::uuid WHERE id=$1', [f.effectId, randomUUID()]);
        return vectors();
      });
      expect(await engine.executeRaw('SELECT id FROM content_chunks WHERE page_id=$1 AND embedding IS NOT NULL', [f.snapshot.page.id])).toHaveLength(0);
    });

    if (kind === 'postgres') check('two independent consumers retain one healthy multi-batch provider past the fixture lease', async () => {
      const f = await fixture();
      const [database] = await engine.executeRaw<{ name: string }>('SELECT current_database() AS name');
      const url = new URL(databaseUrl!); url.pathname = `/${database.name}`;
      const competitor = new PostgresEngine();
      await competitor.connect({ database_url: url.toString(), poolSize: 2 });
      await engine.executeRaw(`CREATE FUNCTION shorten_embedding_claim() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.kind='embedding' AND NEW.state='running' AND NEW.claim_expires_at IS DISTINCT FROM OLD.claim_expires_at THEN
            NEW.claim_expires_at=clock_timestamp()+interval '${renewalMs * 1.5} milliseconds';
          END IF;
          RETURN NEW;
        END $$`);
      await engine.executeRaw(`CREATE TRIGGER shorten_embedding_claim BEFORE UPDATE ON persistence_effects
        FOR EACH ROW EXECUTE FUNCTION shorten_embedding_claim()`);
      let calls = 0, batches = 0;
      const started = Promise.withResolvers<void>();
      const options = { hostId: localHostId(), limit: 1, embedding: { signature, model, embed: async () => {
        calls++; started.resolve();
        for (let n = 0; n < 3; n++) { await Bun.sleep(renewalMs * 1.1); batches++; }
        return vectors();
      } } };
      const worker = runPersistenceEffects(engine, { engine: engine.kind }, options);
      try {
        await started.promise;
        await Bun.sleep(renewalMs * 1.7);
        await runPersistenceEffects(competitor, { engine: competitor.kind }, { ...options,
          embedding: { signature, model, embed: async () => { calls++; return vectors(); } } });
        await Bun.sleep(renewalMs * 1.1);
        await runPersistenceEffects(competitor, { engine: competitor.kind }, { ...options,
          embedding: { signature, model, embed: async () => { calls++; return vectors(); } } });
        await worker;
        expect(calls).toBe(1);
        expect(batches).toBe(3);
        expect(await state(f.effectId)).toMatchObject({ state: 'committed', attempts: 1 });
        expect(await engine.executeRaw('SELECT id FROM content_chunks WHERE page_id=$1 AND embedding IS NOT NULL', [f.snapshot.page.id])).toHaveLength(1);
      } finally {
        await worker;
        await engine.executeRaw('DROP TRIGGER shorten_embedding_claim ON persistence_effects');
        await engine.executeRaw('DROP FUNCTION shorten_embedding_claim()');
        await competitor.disconnect();
      }
    });

    if (kind === 'postgres') check('success, provider failure, cancellation and invalid vectors all stop the heartbeat', async () => {
      let renewals = 0;
      const observed = new Proxy(engine, { get(target, key) {
        if (key === 'executeRawDirect') return async (...args: Parameters<BrainEngine['executeRawDirect']>) => {
          if (args[0].includes('UPDATE persistence_effects SET claim_expires_at')) renewals++;
          return target.executeRawDirect(...args);
        };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      for (const outcome of ['success', 'failure', 'cancelled', 'incomplete'] as const) {
        const f = await fixture();
        const controller = new AbortController();
        await runPersistenceEffects(observed, { engine: engine.kind }, { hostId: localHostId(), limit: 1, signal: controller.signal,
          embedding: { signature, model, embed: async () => {
            if (outcome === 'failure') throw new Error('temporary network timeout');
            if (outcome === 'cancelled') controller.abort(new Error('caller deadline'));
            return outcome === 'incomplete' ? [] : vectors();
          } } });
        expect((await state(f.effectId)).state).toBe(outcome === 'success' ? 'committed' : 'queued');
      }
      const stoppedAt = renewals;
      expect(stoppedAt).toBe(4);
      await Bun.sleep(renewalMs * 1.1);
      expect(renewals).toBe(stoppedAt);
    });

    check('partial batches do not stamp completion or install any vectors', async () => {
      const f = await fixture();
      await run(async () => []);
      expect((await state(f.effectId)).state).toBe('queued');
      expect(await engine.executeRaw('SELECT id FROM content_chunks WHERE page_id=$1 AND embedding IS NOT NULL', [f.snapshot.page.id])).toHaveLength(0);
      expect((await engine.executeRaw<{ embedding_signature: string | null }>('SELECT embedding_signature FROM pages WHERE id=$1', [f.snapshot.page.id]))[0].embedding_signature).toBeNull();
    });

    check('successful source-scan progress resets only the per-page attempt budget', async () => {
      const f = await fixture();
      await engine.executeRaw("UPDATE persistence_effects SET data=data||'{\"source_scan\":true}'::jsonb,attempts=$2 WHERE id=$1", [f.effectId, MAX_RATE_LIMIT_RETRIES - 1]);
      await run(async () => vectors());
      expect(await state(f.effectId)).toMatchObject({ state: 'queued', attempts: MAX_RATE_LIMIT_RETRIES, error_code: null });
      expect((await engine.executeRaw<{ data: { embedding_attempt_base: number } }>('SELECT data FROM persistence_effects WHERE id=$1', [f.effectId]))[0].data.embedding_attempt_base).toBe(MAX_RATE_LIMIT_RETRIES);
      const [cursor] = await engine.executeRaw<{ after_slug: string }>("SELECT data->>'after_slug' AS after_slug FROM persistence_effects WHERE id=$1", [f.effectId]);
      expect(cursor.after_slug).toBe('page');
      await run(async () => { throw new Error('No next page requires a provider call'); });
      expect((await state(f.effectId)).state).toBe('committed');
    });

    check('canonical edit during provider work wins and a later edit invalidates installed vectors', async () => {
      const f = await fixture();
      await run(async () => {
        await engine.putPage('page', page('Newer'), { sourceId: f.sourceId });
        return vectors();
      });
      expect(await engine.executeRaw('SELECT id FROM content_chunks WHERE page_id=$1 AND embedding IS NOT NULL', [f.snapshot.page.id])).toHaveLength(0);
      expect((await engine.readPageSnapshot('page', { sourceId: f.sourceId }))!.page.compiled_truth).toBe('Newer');
      expect((await state(f.effectId)).state).toBe('committed');
      const later = await fixture();
      await run(async () => vectors());
      expect(await engine.executeRaw('SELECT id FROM content_chunks WHERE page_id=$1 AND embedding IS NOT NULL', [later.snapshot.page.id])).toHaveLength(1);
      await engine.putPage('page', page('Later'), { sourceId: later.sourceId });
      expect(await engine.getChunks('page', { sourceId: later.sourceId, includeEmbedding: true })).toHaveLength(0);
    });

    check('source archival during provider work cannot publish delayed vectors', async () => {
      const f = await fixture();
      await run(async () => {
        await engine.executeRaw('UPDATE sources SET archived=true WHERE id=$1', [f.sourceId]);
        return vectors();
      });
      expect(await engine.executeRaw('SELECT id FROM content_chunks WHERE page_id=$1 AND embedding IS NOT NULL', [f.snapshot.page.id])).toHaveLength(0);
      expect(await state(f.effectId)).toMatchObject({ state: 'failed', error_code: 'source_changed' });
    });

    check('embedding-model changes during provider work discard the old-model result', async () => {
      const f = await fixture();
      const previous = await engine.getConfig('embedding_model');
      try {
        await run(async () => {
          await engine.setConfig('embedding_model', 'test:new-model');
          return vectors();
        });
        expect(await engine.executeRaw('SELECT id FROM content_chunks WHERE page_id=$1 AND embedding IS NOT NULL', [f.snapshot.page.id])).toHaveLength(0);
      } finally {
        if (previous === null) await engine.executeRaw("DELETE FROM config WHERE key='embedding_model'");
        else await engine.setConfig('embedding_model', previous);
      }
    });

    check('completion checks the active vector column rather than the legacy column', async () => {
      const f = await fixture();
      const previousColumn = await engine.getConfig('search_embedding_column');
      const previousRegistry = await engine.getConfig('embedding_columns');
      await engine.executeRaw('ALTER TABLE content_chunks ADD COLUMN embedding_effect_test vector(1536)');
      try {
        await engine.setConfig('embedding_columns', JSON.stringify({ embedding_effect_test: { type: 'vector', dimensions: 1536, provider: model } }));
        await engine.setConfig('search_embedding_column', 'embedding_effect_test');
        const prepared = (await readProjectionSnapshot(engine, 'page', f.sourceId))!;
        await installPageEmbeddings(engine, prepared, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'Current', embedding: vectors()[0], model }], signature);
        expect(await engine.executeRaw('SELECT id FROM content_chunks WHERE page_id=$1 AND embedding IS NOT NULL', [f.snapshot.page.id])).toHaveLength(0);
        let calls = 0;
        await run(async () => { calls++; return vectors(); });
        expect(calls).toBe(0);
        expect((await state(f.effectId)).state).toBe('committed');
      } finally {
        if (previousColumn === null) await engine.executeRaw("DELETE FROM config WHERE key='search_embedding_column'");
        else await engine.setConfig('search_embedding_column', previousColumn);
        if (previousRegistry === null) await engine.executeRaw("DELETE FROM config WHERE key='embedding_columns'");
        else await engine.setConfig('embedding_columns', previousRegistry);
        await engine.executeRaw('ALTER TABLE content_chunks DROP COLUMN embedding_effect_test');
      }
    });

    check('billing opt-out after claim preserves the queued effect and its retry allowance', async () => {
      const f = await fixture();
      const fileConfig = { engine: 'pglite' as const, database_path: join(scratch, 'unused') };
      saveConfig({ ...fileConfig, ai_billing: 'api' });
      configureGateway({ ai_billing: 'api', env: {} });
      let requests = 0;
      try {
        await run(async () => {
          saveConfig({ ...fileConfig, ai_billing: 'subscription' });
          return invokeAI({ operation: 'embed', kind: 'embedding', model: 'openai:text-embedding-3-large' },
            async () => { requests++; return vectors(); }, () => null);
        });
        expect(await state(f.effectId)).toMatchObject({ state: 'queued', attempts: 0, error_code: null });
        expect(requests).toBe(0);
        expect(await engine.executeRaw('SELECT id FROM content_chunks WHERE page_id=$1 AND embedding IS NOT NULL', [f.snapshot.page.id])).toEqual([]);
      } finally {
        resetGateway();
        rmSync(join(scratch, '.gbrain', 'config.json'), { force: true });
      }
    });

    for (const localColumn of [true, false]) check(
      `subscription idle probe and worker use the live ${localColumn ? 'local' : 'paid'} column, not the inverse gateway policy`, async () => {
        const f = await fixture();
        // hasWork probes the whole shared engine. Earlier canonical-edit cases
        // leave real projection jobs; finish them before isolating effect policy.
        await rebuildPendingPageProjections(engine);
        expect(await engine.executeRaw('SELECT slug FROM page_projection_jobs')).toEqual([]);
        const name = localColumn ? 'embedding_policy_local' : 'embedding_policy_paid';
        const targetModel = localColumn ? 'ollama:nomic-embed-text' : 'openai:text-embedding-3-large';
        const gatewayModel = localColumn ? 'openai:text-embedding-3-large' : 'ollama:nomic-embed-text';
        const previousColumn = await engine.getConfig('search_embedding_column');
        const previousRegistry = await engine.getConfig('embedding_columns');
        const column = await initializeIndependentEmbeddingColumn(engine, name, {
          provider: targetModel, dimensions: 768, type: 'vector', provenance: 'independent',
        });
        const consumer = new PersistenceConsumer(engine, { engine: engine.kind, embedding_model: gatewayModel },
          async () => { throw new Error('no preparation expected'); }, { hostId: localHostId() });
        const realFetch = globalThis.fetch;
        let fetches = 0;
        globalThis.fetch = (async () => { fetches++; throw new Error('no provider may be invoked'); }) as unknown as typeof fetch;
        configureGateway({ embedding_model: gatewayModel, embedding_dimensions: 1536,
          env: { OPENAI_API_KEY: 'sk-test-not-real' }, ai_billing: 'subscription' });
        try {
          await engine.setConfig('search_embedding_column', name);
          // Complete local provenance lets the real worker claim and finish
          // without calling a provider or using the embedding test override.
          if (localColumn) {
            const projection = (await readProjectionSnapshot(engine, 'page', f.sourceId))!;
            expect(await installPageEmbeddings(engine, projection, projection.chunks.map(chunk => ({
              chunk_index: chunk.chunk_index, chunk_source: chunk.chunk_source, chunk_text: chunk.chunk_text,
              embedding: new Float32Array(768).fill(0.5), model: targetModel,
            })), embeddingColumnSignature(column))).toBe(true);
          }
          // Test-only access to the scheduler's private read-only eligibility probe.
          const probe = consumer as unknown as { hasWork(): Promise<boolean> };
          const before = await state(f.effectId);
          expect(await probe.hasWork()).toBe(localColumn);
          expect(await state(f.effectId)).toMatchObject({
            state: before.state, attempts: before.attempts, error_code: before.error_code,
          });
          expect(await runPersistenceEffects(engine, { engine: engine.kind }, { hostId: localHostId(), limit: 1 }))
            .toBe(localColumn ? 1 : 0);
          expect(await state(f.effectId)).toMatchObject(localColumn
            ? { state: 'committed', attempts: before.attempts + 1, error_code: null }
            : { state: 'queued', attempts: before.attempts, error_code: null });
          expect(await probe.hasWork()).toBe(false);
          expect(fetches).toBe(0);
        } finally {
          await consumer.stop();
          globalThis.fetch = realFetch;
          resetGateway();
          if (previousColumn === null) await engine.executeRaw("DELETE FROM config WHERE key='search_embedding_column'");
          else await engine.setConfig('search_embedding_column', previousColumn);
          await engine.executeRaw(`ALTER TABLE content_chunks DROP COLUMN ${name},DROP COLUMN ${name}_model,
            DROP COLUMN ${name}_embedded_text_hash,DROP COLUMN ${name}_embedding_input_hash,
            DROP COLUMN ${name}_embedded_at,DROP COLUMN ${name}_pending_since`);
          await engine.executeRaw(`ALTER TABLE pages DROP COLUMN ${name}_signature`);
          // Only the disposable test registry bypasses the production removal guard.
          if (previousRegistry === null) await engine.executeRaw("DELETE FROM config WHERE key='embedding_columns'");
          else await engine.executeRaw("UPDATE config SET value=$1 WHERE key='embedding_columns'", [previousRegistry]);
        }
      });

    check('ai_billing=subscription leaves a paid embedding effect queued, unclaimed, with no request', async () => {
      const f = await fixture();
      const before = await state(f.effectId);
      const realFetch = globalThis.fetch;
      let fetches = 0;
      globalThis.fetch = (async () => { fetches++; throw new Error('network must not be reached'); }) as unknown as typeof fetch;
      configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536,
        env: { OPENAI_API_KEY: 'sk-test-not-real' }, ai_billing: 'subscription' });
      try {
        await runPersistenceEffects(engine, { engine: engine.kind }, { hostId: localHostId(), limit: 1 });
        const after = await state(f.effectId);
        expect(after.state).toBe(before.state);
        expect(after.attempts).toBe(before.attempts);
        expect(after.error_code).toBeNull();
        expect(fetches).toBe(0);
      } finally {
        globalThis.fetch = realFetch;
        resetGateway();
      }
    });
  });
}
