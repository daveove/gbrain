import { describe, expect, test } from 'bun:test';
import postgres from '#postgres';
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
});
