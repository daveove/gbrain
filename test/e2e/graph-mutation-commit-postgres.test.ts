import { describe, expect, test } from 'bun:test';
import postgres from '#postgres';
import { mkdtempSync, mkdirSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyRelationManifest, parseRelationManifest, _setBeforeReceiptCommitForTests } from '../../src/core/graph-usefulness/relation-manifest.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { runMigrations } from '../../src/core/migrate.ts';
import { runRetrievalProof, _setRetrievalProofSearchForTests } from '../../src/core/graph-usefulness/retrieval-proof.ts';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl) assertSafeE2eDatabaseUrl(databaseUrl);
const native = databaseUrl ? describe : describe.skip;

native('graph epochs follow native PostgreSQL commit order', () => {
  for (const kind of ['alias', 'take', 'search-config'] as const) {
    test(`lower-XID late ${kind} ABA commit refuses an otherwise identical proof`, async () => {
      const brain = await isolatedPersistencePostgres(databaseUrl!);
      const slow = postgres(brain.databaseUrl, { max: 1, prepare: false });
      const fast = postgres(brain.databaseUrl, { max: 1, prepare: false });
      let slowOpen = false;
      let fastOpen = false;
      try {
        await runMigrations(brain.engine);
        await brain.engine.executeRaw("INSERT INTO sources(id,name) VALUES('proof-native','Synthetic source')");
        await brain.engine.executeRaw("INSERT INTO pages(source_id,slug,type,title,compiled_truth) VALUES('proof-native','notes/target','note','Synthetic page','Synthetic content')");
        if (kind === 'alias') await brain.engine.executeRaw("INSERT INTO page_aliases(source_id,alias_norm,slug) VALUES('proof-native','slow alias','notes/target'),('proof-native','fast alias','notes/target')");
        if (kind === 'take') await brain.engine.executeRaw("INSERT INTO takes(page_id,row_num,claim,kind,holder) SELECT id,n,'Synthetic claim','fact','Synthetic holder' FROM pages CROSS JOIN generate_series(1,2) n WHERE source_id='proof-native'");
        if (kind === 'search-config') {
          await brain.engine.setConfig('search.adaptive_return', 'false');
          await brain.engine.setConfig('search.adaptive_return_min_keep', '3');
        }
        for (const client of [slow, fast]) {
          await client.unsafe("SET statement_timeout='5s'");
          await client.unsafe("SET idle_in_transaction_session_timeout='10s'");
        }
        await slow.unsafe('BEGIN'); slowOpen = true;
        const slowXid = BigInt((await slow.unsafe('SELECT txid_current()::text AS xid'))[0]!.xid);
        const writeABA = async (client: typeof slow, second: boolean) => {
          if (kind === 'alias') {
            const original = second ? 'fast alias' : 'slow alias';
            await client.unsafe('UPDATE page_aliases SET alias_norm=$1 WHERE source_id=$2 AND alias_norm=$3', [`${original} changed`, 'proof-native', original]);
            await client.unsafe('UPDATE page_aliases SET alias_norm=$1 WHERE source_id=$2 AND alias_norm=$3', [original, 'proof-native', `${original} changed`]);
          } else if (kind === 'take') {
            const row = second ? 2 : 1;
            await client.unsafe('UPDATE takes SET active=false WHERE row_num=$1', [row]);
            await client.unsafe('UPDATE takes SET active=true WHERE row_num=$1', [row]);
          } else {
            const key = second ? 'search.adaptive_return_min_keep' : 'search.adaptive_return';
            const original = second ? '3' : 'false';
            await client.unsafe('UPDATE config SET value=$1 WHERE key=$2', [second ? '4' : 'true', key]);
            await client.unsafe('UPDATE config SET value=$1 WHERE key=$2', [original, key]);
          }
        };
        await writeABA(slow, false);
        await fast.unsafe('BEGIN'); fastOpen = true;
        const fastXid = BigInt((await fast.unsafe('SELECT txid_current()::text AS xid'))[0]!.xid);
        expect(slowXid < fastXid).toBe(true);
        await writeABA(fast, true);
        await fast.unsafe('COMMIT'); fastOpen = false;
        const table = kind === 'alias' ? 'page_aliases' : kind === 'take' ? 'takes' : 'config';
        const maxXmin = async () => (await brain.engine.executeRaw<{ xid: string }>(`SELECT max(xmin::text::bigint)::text AS xid FROM ${table}`))[0]!.xid;
        const beforeXmin = await maxXmin();
        expect(beforeXmin).toBe(fastXid.toString());
        const epochSql = kind === 'search-config'
          ? 'SELECT generation::text AS generation FROM graph_search_mutation_generation WHERE singleton=1'
          : "SELECT generation::text AS generation FROM source_mutation_generation WHERE source_id='proof-native'";
        const beforeEpoch = (await brain.engine.executeRaw<{ generation: string }>(epochSql))[0]!.generation;
        _setRetrievalProofSearchForTests(async () => {
          await slow.unsafe('COMMIT'); slowOpen = false;
          return [{ source_id: 'proof-native', slug: 'notes/target' }];
        });
        const result = await runRetrievalProof(brain.engine, { proof_version: 2, questions: [{ id: `native-${kind}`, query: 'Synthetic page', relevant_pages: [{ source_id: 'proof-native', slug: 'notes/target' }] }] }, { sourceId: 'proof-native' });
        expect(await maxXmin()).toBe(beforeXmin);
        const afterEpoch = (await brain.engine.executeRaw<{ generation: string }>(epochSql))[0]!.generation;
        expect(BigInt(afterEpoch)).toBe(BigInt(beforeEpoch) + 1n);
        expect(result.fingerprint_after.sha256).toBe(result.fingerprint_before.sha256);
        expect(result.checks.production_mutations).toBeGreaterThan(0);
        expect(result.passed).toBe(false);
      } finally {
        _setRetrievalProofSearchForTests(null);
        if (slowOpen) await slow.unsafe('ROLLBACK').catch(() => {});
        if (fastOpen) await fast.unsafe('ROLLBACK').catch(() => {});
        await Promise.all([slow.end({ timeout: 1 }), fast.end({ timeout: 1 })]);
        await brain.close();
      }
    }, 30_000);
  }

  test('opposite source write order commits without deferred epoch deadlock', async () => {
    const brain = await isolatedPersistencePostgres(databaseUrl!);
    const left = postgres(brain.databaseUrl, { max: 1, prepare: false });
    const right = postgres(brain.databaseUrl, { max: 1, prepare: false });
    let leftOpen = false;
    let rightOpen = false;
    try {
      await runMigrations(brain.engine);
      await brain.engine.executeRaw("INSERT INTO sources(id,name) VALUES('native-a','Synthetic A'),('native-b','Synthetic B')");
      await brain.engine.executeRaw("INSERT INTO pages(source_id,slug,type,title) SELECT source_id,slug,'note','Synthetic page' FROM (VALUES ('native-a','notes/left'),('native-b','notes/left'),('native-a','notes/right'),('native-b','notes/right')) AS fixture(source_id,slug)");
      const epochs = () => brain.engine.executeRaw<{ source_id: string; generation: string }>("SELECT source_id,generation::text AS generation FROM source_mutation_generation WHERE source_id IN ('native-a','native-b') ORDER BY source_id");
      const before = await epochs();
      for (const client of [left, right]) {
        await client.unsafe("SET statement_timeout='5s'");
        await client.unsafe("SET idle_in_transaction_session_timeout='10s'");
      }
      await left.unsafe('BEGIN'); leftOpen = true;
      await right.unsafe('BEGIN'); rightOpen = true;
      // Distinct page rows avoid parent-writer row locks; only deferred epoch keys overlap.
      for (const source of ['native-a', 'native-b']) await left.unsafe("UPDATE pages SET title='Left change' WHERE source_id=$1 AND slug='notes/left'", [source]);
      for (const source of ['native-b', 'native-a']) await right.unsafe("UPDATE pages SET title='Right change' WHERE source_id=$1 AND slug='notes/right'", [source]);
      await Promise.all([left.unsafe('COMMIT').then(() => { leftOpen = false; }), right.unsafe('COMMIT').then(() => { rightOpen = false; })]);
      const after = await epochs();
      expect(after.map(row => row.source_id)).toEqual(before.map(row => row.source_id));
      for (let index = 0; index < before.length; index++) expect(BigInt(after[index]!.generation)).toBe(BigInt(before[index]!.generation) + 2n);
      expect(await brain.engine.executeRaw('SELECT id FROM source_mutation_pending')).toEqual([]);
    } finally {
      if (leftOpen) await left.unsafe('ROLLBACK').catch(() => {});
      if (rightOpen) await right.unsafe('ROLLBACK').catch(() => {});
      await Promise.all([left.end({ timeout: 1 }), right.end({ timeout: 1 })]);
      await brain.close();
    }
  }, 30_000);

  for (const independentUpdate of [false, true]) {
    test(independentUpdate
      ? 'receipt compensation preserves independently committed same-value link update'
      : 'receipt compensation removes an untouched applied link', async () => {
      const brain = await isolatedPersistencePostgres(databaseUrl!);
      const writer = postgres(brain.databaseUrl, { max: 1, prepare: false });
      const dir = mkdtempSync(join(tmpdir(), 'gbrain-native-receipt-'));
      const receiptPath = join(dir, 'receipt.json');
      type LinkIdentity = { id: number; xmin: string; context: string };
      let applied: LinkIdentity | undefined;
      let committed: LinkIdentity | undefined;
      try {
        await runMigrations(brain.engine);
        await writer.unsafe("SET statement_timeout='5s'");
        await writer.unsafe("SET idle_in_transaction_session_timeout='10s'");
        await brain.engine.executeRaw("INSERT INTO sources(id,name) VALUES('receipt-native','Synthetic receipt source')");
        for (const slug of ['notes/from', 'notes/to']) {
          await brain.engine.putPage(slug, { type: 'note', title: 'Synthetic receipt page', compiled_truth: 'Synthetic content' }, { sourceId: 'receipt-native' });
        }
        const raw = JSON.stringify({ manifest_version: 1, rows: [{
          id: 'native-receipt-row', from_slug: 'notes/from', to_slug: 'notes/to',
          from_source_id: 'receipt-native', to_source_id: 'receipt-native',
          link_type: 'related_to', link_source: 'tana-relation-r2', context: 'same context',
          guards: { exact_endpoint_match: true, source_relation_current: true, no_incident_edge: true, readwise_clear: true },
        }] });
        const rows = () => brain.engine.executeRaw<LinkIdentity>(
          "SELECT l.id,l.xmin::text AS xmin,l.context FROM links l JOIN pages p ON p.id=l.from_page_id WHERE p.source_id='receipt-native'");
        _setBeforeReceiptCommitForTests(async () => {
          const inserted = await rows();
          expect(inserted).toHaveLength(1); applied = inserted[0];
          if (independentUpdate) {
            // A separate connection commits a new physical row version with identical values.
            const updated = await writer.unsafe<LinkIdentity[]>(
              'UPDATE links SET context=context WHERE id=$1 RETURNING id,xmin::text AS xmin,context', [applied!.id]);
            expect(updated).toHaveLength(1); committed = updated[0];
            expect(committed!.id).toBe(applied!.id);
            expect(committed!.xmin).not.toBe(applied!.xmin);
            expect(committed!.context).toBe(applied!.context);
          }
          unlinkSync(receiptPath); mkdirSync(receiptPath);
        });
        await expect(applyRelationManifest(brain.engine, parseRelationManifest(raw), raw, {
          apply: true, receiptPath, defaultSourceId: 'receipt-native',
        })).rejects.toThrow(independentUpdate ? /left 1 concurrently updated link/ : /rolled back 1 applied link/);
        expect(applied).toBeDefined();
        const remaining = await rows();
        if (independentUpdate) {
          expect(committed).toBeDefined();
          if (!committed) throw new Error('Expected independently committed link identity');
          expect(remaining).toHaveLength(1);
          expect(remaining[0]).toEqual(committed);
          expect(remaining[0].id).toBe(applied!.id);
          expect(remaining[0].xmin).not.toBe(applied!.xmin);
        } else expect(remaining).toEqual([]);
      } finally {
        _setBeforeReceiptCommitForTests(null);
        try { await writer.end({ timeout: 1 }); }
        finally {
          try { rmSync(dir, { recursive: true, force: true }); }
          finally { await brain.close(); }
        }
      }
    }, 30_000);
  }

});
