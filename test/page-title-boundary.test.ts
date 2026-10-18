import { describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import postgres from '#postgres';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { LATEST_VERSION, runMigrations } from '../src/core/migrate.ts';
import { LEGACY_PAGE_TITLE_INDEX, PAGE_ONLINE_INDEXES, readPageIndexStates } from '../src/core/page-indexes.ts';
import { pageIndexesCheck } from '../src/commands/doctor/checks/page-indexes.ts';
import { pageIndexesRepair } from '../src/core/repair/page-indexes.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { selectEntityCandidates, type EntityLookupScope } from '../src/core/verbs/entity-card.ts';
import { resolveEntitiesToPointers } from '../src/core/context/retrieval-reflex.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';
import { testBackends, type TestBackend } from './helpers/test-backends.ts';

const title = Array.from({ length: 8192 }, (_, i) => String.fromCodePoint(19968 +
  (createHash('sha256').update(String(i)).digest().readUInt16BE(0) % 20000))).join('');
const lookupScope: EntityLookupScope = { excludePrivate: false, entityTypes: new Set(), policy: undefined, pack: null };

async function withFixture(backend: TestBackend, fn: (engine: BrainEngine) => Promise<void>) {
  if (backend === 'pglite') {
    const engine = new PGLiteEngine();
    try { await engine.connect({}); await engine.initSchema(); await fn(engine); }
    finally { await engine.disconnect(); }
    return;
  }
  const url = process.env.DATABASE_URL!;
  assertSafeE2eDatabaseUrl(url);
  const database = `index_test_title_${randomUUID().replace(/-/g, '')}`;
  const admin = postgres(url, { max: 1, prepare: false, onnotice() {} });
  const target = new URL(url);
  target.pathname = `/${database}`;
  const engine = new PostgresEngine();
  try {
    await admin.unsafe(`CREATE DATABASE ${database}`);
    try {
      await engine.connect({ database_url: target.toString(), poolSize: 2 });
      await engine.initSchema();
      await fn(engine);
    } finally {
      await engine.disconnect();
      await admin.unsafe(`DROP DATABASE ${database}`);
    }
  } finally { await admin.end({ timeout: 5 }); }
}

async function insertPage(engine: BrainEngine, source: string, slug: string, name: string) {
  await engine.putPage(slug, { title: name, type: 'note', compiled_truth: 'Title boundary fixture.', frontmatter: {} }, { sourceId: source });
}

async function assertConsumers(engine: BrainEngine) {
  await engine.executeRaw("INSERT INTO sources(id, name) VALUES ('title-other', 'Other title source') ON CONFLICT DO NOTHING");
  await insertPage(engine, 'default', 'long/exact', title);
  await insertPage(engine, 'default', 'long/prefix', `${title}別`);
  await insertPage(engine, 'title-other', 'long/exact', title);
  const exact = await selectEntityCandidates(engine, 'default', title, lookupScope);
  expect(exact.kind).toBe('hit');
  if (exact.kind === 'hit') {
    expect(exact.row.slug).toBe('long/exact');
    expect(exact.row.source_id).toBe('default');
    expect(exact.row.title).toBe(title);
    expect(exact.runnersUp).toEqual([]);
  }
  expect((await engine.getPage('long/prefix', { sourceId: 'default' }))?.title).toBe(`${title}別`);
  const collisionA = 'collision-184278';
  const collisionB = 'collision-2216';
  const [collision] = await engine.executeRaw<{ same: boolean }>('SELECT hashtext($1) = hashtext($2) AS same', [collisionA, collisionB]);
  expect(collision?.same).toBe(true);
  await insertPage(engine, 'default', 'hash/a', collisionA);
  await insertPage(engine, 'default', 'hash/b', collisionB);
  const hit = await selectEntityCandidates(engine, 'default', collisionA, lookupScope);
  expect(hit.kind).toBe('hit');
  if (hit.kind === 'hit') { expect(hit.row.slug).toBe('hash/a'); expect(hit.runnersUp).toEqual([]); }
  const pointers = await resolveEntitiesToPointers(engine, 'default', [{ display: collisionA, query: collisionA }],
    { excludePrivate: false });
  expect(pointers?.pointers.map(pointer => pointer.slug)).toEqual(['hash/a']);
  await insertPage(engine, 'default', 'alias/derived', 'A derived alias holder');
  await engine.executeRaw(`INSERT INTO page_aliases(source_id, alias_norm, slug, origin)
    VALUES ('default', $1, 'alias/derived', 'declared')`, [collisionA]);
  expect(await engine.resolveAliases([collisionA], { sourceId: 'default' })).toEqual(new Map());
  await engine.executeRaw("DELETE FROM pages WHERE source_id = 'default' AND slug = 'hash/a'");
  expect(await engine.resolveAliases([collisionA], { sourceId: 'default' })).toEqual(new Map([
    [collisionA, [{ source_id: 'default', slug: 'alias/derived' }]],
  ]));
  await insertPage(engine, 'title-other', 'hash/a', collisionA);
  expect((await engine.resolveAliases([collisionA], { sourceId: 'default' })).get(collisionA)).toEqual([
    { source_id: 'default', slug: 'alias/derived' },
  ]);
}

for (const backend of testBackends()) describe(`page title boundaries (${backend})`, () => {
  test('native full-schema replay and v239 checkpoint preserve oversized titles and exact consumers', async () => {
    await withFixture(backend, async engine => {
      // This disposable checkpoint removes only post-239 indexes, never production history.
      for (const index of PAGE_ONLINE_INDEXES) await engine.executeRaw(`DROP INDEX ${index.name}`);
      await insertPage(engine, 'default', 'long/before-upgrade', `${title}前`);
      await engine.setConfig('version', '239');
      await engine.initSchema();
      expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
      expect((await engine.getPage('long/before-upgrade', { sourceId: 'default' }))?.title).toBe(`${title}前`);
      expect((await readPageIndexStates(engine)).map(index => index.state)).toEqual(['valid', 'valid', 'valid']);
      expect((await pageIndexesCheck(engine)).status).toBe('ok');
      await assertConsumers(engine);
    });
  }, 120_000);

  test('v243 forward migration retires the unbounded index and accepts long writes without a reset', async () => {
    await withFixture(backend, async engine => {
      await engine.executeRaw(`DROP INDEX ${PAGE_ONLINE_INDEXES[0].name}`);
      await engine.executeRaw(`CREATE INDEX ${LEGACY_PAGE_TITLE_INDEX} ON pages (source_id, lower(title))`);
      await engine.setConfig('version', '243');
      expect((await pageIndexesCheck(engine)).status).toBe('warn');
      expect(await runMigrations(engine)).toEqual({ applied: 1, current: LATEST_VERSION });
      expect((await readPageIndexStates(engine)).map(index => index.state)).toEqual(['valid', 'valid', 'valid']);
      await assertConsumers(engine);
      expect(await runMigrations(engine)).toEqual({ applied: 0, current: LATEST_VERSION });
    });
  }, 120_000);

  test('current-schema page repair removes obsolete indexes and repairs missing bounded keys', async () => {
    await withFixture(backend, async engine => {
      await engine.executeRaw(`CREATE INDEX ${LEGACY_PAGE_TITLE_INDEX} ON pages (source_id, lower(title))`);
      await engine.executeRaw(`DROP INDEX ${PAGE_ONLINE_INDEXES[0].name}`);
      const ctx = { engine, logger: { info() {} } } as unknown as OperationContext;
      const plan = await pageIndexesRepair.plan(engine, { brain_id: 'title-test', source_ids: ['default'] }, null);
      expect(plan.items.map(item => item.action)).toEqual(['build', 'drop_obsolete']);
      for (const item of plan.items) expect(await pageIndexesRepair.apply(ctx, item)).toBe(true);
      expect((await pageIndexesCheck(engine)).status).toBe('ok');
      await assertConsumers(engine);
      expect((await pageIndexesRepair.plan(engine, { brain_id: 'title-test', source_ids: ['default'] }, null)).items).toEqual([]);
    });
  }, 120_000);

  test('page repair refuses an unrelated index that reuses the legacy name', async () => {
    await withFixture(backend, async engine => {
      await engine.executeRaw('CREATE TABLE unrelated_title_fixture (source_id text, title text)');
      await engine.executeRaw(`CREATE INDEX ${LEGACY_PAGE_TITLE_INDEX} ON unrelated_title_fixture (source_id, lower(title))`);
      const ctx = { engine, logger: { info() {} } } as unknown as OperationContext;
      const plan = await pageIndexesRepair.plan(engine, { brain_id: 'title-test', source_ids: ['default'] }, null);
      expect(plan.items).toHaveLength(1);
      await expect(pageIndexesRepair.apply(ctx, plan.items[0]!)).rejects.toThrow('Refusing to drop unrelated index');
      const [retained] = await engine.executeRaw<{ present: boolean }>('SELECT to_regclass($1) IS NOT NULL AS present', [LEGACY_PAGE_TITLE_INDEX]);
      expect(retained?.present).toBe(true);
    });
  }, 120_000);
  for (const table of ['pages', 'unrelated_title_fixture']) test(`replacement index collision on ${table} blocks migration and repair without retiring the legacy index`, async () => {
    await withFixture(backend, async engine => {
      if (table !== 'pages') await engine.executeRaw(`CREATE TABLE ${table} (source_id text, title text)`);
      await engine.executeRaw(`CREATE INDEX ${LEGACY_PAGE_TITLE_INDEX} ON pages (source_id, lower(title))`);
      await engine.executeRaw(`DROP INDEX ${PAGE_ONLINE_INDEXES[0].name}`);
      await engine.executeRaw(`CREATE INDEX ${PAGE_ONLINE_INDEXES[0].name} ON ${table} (source_id, lower(title))`);
      await engine.setConfig('version', '243');
      await expect(runMigrations(engine)).rejects.toThrow('Conflicting page title index');
      expect(await engine.getConfig('version')).toBe('243');
      expect((await pageIndexesCheck(engine)).status).toBe('warn');
      expect(await readPageIndexStates(engine)).toContainEqual({ name: PAGE_ONLINE_INDEXES[0].name, state: 'conflicting' });
      const ctx = { engine, logger: { info() {} } } as unknown as OperationContext;
      const plan = await pageIndexesRepair.plan(engine, { brain_id: 'title-test', source_ids: ['default'] }, null);
      for (const item of plan.items) await expect(pageIndexesRepair.apply(ctx, item)).rejects.toThrow('Conflicting page title index');
      const [retained] = await engine.executeRaw<{ present: boolean }>('SELECT to_regclass($1) IS NOT NULL AS present', [LEGACY_PAGE_TITLE_INDEX]);
      expect(retained?.present).toBe(true);
    });
  }, 120_000);
  test('covering legacy title index is retained by migration and repair', async () => {
    await withFixture(backend, async engine => {
      await engine.executeRaw(`CREATE INDEX ${LEGACY_PAGE_TITLE_INDEX} ON pages (source_id, lower(title)) INCLUDE (compiled_truth)`);
      await engine.setConfig('version', '243');
      await expect(runMigrations(engine)).rejects.toThrow('Refusing to drop unrelated index');
      expect(await engine.getConfig('version')).toBe('243');
      const ctx = { engine, logger: { info() {} } } as unknown as OperationContext;
      const plan = await pageIndexesRepair.plan(engine, { brain_id: 'title-test', source_ids: ['default'] }, null);
      expect(plan.items).toHaveLength(1);
      await expect(pageIndexesRepair.apply(ctx, plan.items[0]!)).rejects.toThrow('Refusing to drop unrelated index');
      const [retained] = await engine.executeRaw<{ definition: string }>('SELECT pg_get_indexdef(to_regclass($1)) AS definition', [LEGACY_PAGE_TITLE_INDEX]);
      expect(retained?.definition).toContain('INCLUDE (compiled_truth)');
    });
  }, 120_000);
});
