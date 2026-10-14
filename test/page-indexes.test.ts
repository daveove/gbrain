import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import type { OnlineIndexState } from '../src/core/schema-migrations/helpers.ts';
import { OnlineIndexInProgressError } from '../src/core/schema-migrations/helpers.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PAGE_ONLINE_INDEXES, PAGES_TITLE_LOWER_TRGM_INDEX, readPageIndexStates } from '../src/core/page-indexes.ts';
import { pageIndexesCheck } from '../src/commands/doctor/checks/page-indexes.ts';
import { WAVE_CHECKS } from '../src/commands/doctor/wave-checks.ts';
import { REPAIR_KINDS, resolveRepairScope, runRepair } from '../src/core/repair/core.ts';
import { AUTO_REPAIR_REGISTRY, repairForCheck } from '../src/core/repair/registry.ts';
import { pageIndexesRepair } from '../src/core/repair/page-indexes.ts';
import { v240 } from '../src/core/schema-migrations/v240-pages-name-lookup-indexes.ts';
import { v243 } from '../src/core/schema-migrations/v243-nightly-memory-dependencies.ts';

const scope = { brain_id: 'page-index-test', source_ids: ['default'] };
const context = (engine: BrainEngine) => ({ engine, config: { engine: engine.kind }, remote: false, dryRun: false,
  logger: { info() {}, warn() {}, error() {} } }) as unknown as OperationContext;

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });

test('current-schema v240/v243 indexes have native doctor, preview, repair and idempotent resume on PGLite', async () => {
  expect(REPAIR_KINDS).toContain('page-indexes');
  expect(AUTO_REPAIR_REGISTRY.map(spec => spec.kind)).toContain('page-indexes');
  expect(repairForCheck('page_indexes')?.kind).toBe('page-indexes');
  expect(WAVE_CHECKS.find(spec => spec.id === 'page_indexes')).toMatchObject({ resolution: 'repair', registration: 'wave' });
  expect((await pageIndexesCheck(engine)).status).toBe('ok');
  // Both migrations are already stamped; neither handler will run again to recover a dropped index.
  const version = await engine.getConfig('version');
  expect(Number(version)).toBeGreaterThanOrEqual(243);
  for (const index of PAGE_ONLINE_INDEXES) await engine.executeRaw(`DROP INDEX ${index.name}`);
  const doctor = await pageIndexesCheck(engine);
  expect(doctor).toMatchObject({ name: 'page_indexes', status: 'warn', details: { count: 3, repair: 'page-indexes',
    command: 'gbrain repair page-indexes --apply', docs: 'docs/guides/repair.md#page-indexes' } });
  expect(doctor.message).toContain(`${PAGES_TITLE_LOWER_TRGM_INDEX.name} is missing`);
  expect(doctor.message).not.toContain('request-indexes');
  const repairScope = await resolveRepairScope(engine);
  const preview = await runRepair(context(engine), pageIndexesRepair, repairScope, { apply: false });
  expect(preview).toMatchObject({ affected: 3, applied: 0, apply_command: 'gbrain repair page-indexes --apply',
    cost: { lifetime_ids: 0, embedding_pages: 0 } });
  expect((await readPageIndexStates(engine)).map(index => index.state)).toEqual(['missing', 'missing', 'missing']);
  expect(await runRepair(context(engine), pageIndexesRepair, repairScope, { apply: true, limit: 1 })).toMatchObject({ applied: 1, complete: false });
  expect(await runRepair(context(engine), pageIndexesRepair, repairScope, { apply: true })).toMatchObject({ affected: 2, applied: 2, complete: true });
  expect(await engine.getConfig('version')).toBe(version);
  expect((await pageIndexesCheck(engine)).status).toBe('ok');
  expect(await runRepair(context(engine), pageIndexesRepair, repairScope, { apply: true })).toMatchObject({ affected: 0, applied: 0, complete: true });
}, 60_000);

/** Exercise native repair against the real online helper, without a database service or catalog writes. */
function postgresFixture() {
  const states = new Map<string, OnlineIndexState>(PAGE_ONLINE_INDEXES.map(index => [index.name, { valid: true, ready: true, building: false }]));
  const statements: string[] = [];
  let acceptBuild = true;
  const executeRaw = async (sql: string, params: unknown[] = []) => {
    statements.push(sql);
    if (sql.includes('FROM pg_index')) {
      const state = states.get(String(params[0]));
      return state ? [{ ...state }] : [];
    }
    if (sql.includes('GREATEST(reltuples')) return [{ rows: 240_000 }];
    if (sql.startsWith('UPDATE minion_jobs') || sql.startsWith('CREATE OR REPLACE FUNCTION')) return [];
    const create = /CREATE INDEX CONCURRENTLY IF NOT EXISTS (\w+)/.exec(sql);
    if (create) { states.set(create[1]!, { valid: acceptBuild, ready: acceptBuild, building: false }); return []; }
    const drop = /DROP INDEX CONCURRENTLY IF EXISTS (\w+)/.exec(sql);
    if (drop) { states.delete(drop[1]!); return []; }
    throw new Error(`Unexpected fixture SQL: ${sql}`);
  };
  const pg = { kind: 'postgres', executeRaw, runMigration: async (_version: number, sql: string) => executeRaw(sql),
    withReservedConnection: async (fn: (connection: { executeRaw: typeof executeRaw }) => Promise<unknown>) => fn({ executeRaw }) } as unknown as BrainEngine;
  return { pg, states, statements, failBuild: () => { acceptBuild = false; } };
}

test('valid and ready page indexes stay healthy despite an unrelated unknown-OID table builder', async () => {
  const f = postgresFixture();
  for (const index of PAGE_ONLINE_INDEXES) f.states.set(index.name, { valid: true, ready: true, building: true });
  expect((await readPageIndexStates(f.pg)).map(index => index.state)).toEqual(['valid', 'valid', 'valid']);
  expect(await pageIndexesCheck(f.pg)).toMatchObject({ status: 'ok', details: { count: 0 } });
  const plan = await pageIndexesRepair.plan(f.pg, scope, null);
  expect(plan).toMatchObject({ items: [], residuals: { building: 0 } });
  expect(f.statements.every(sql => sql.startsWith('SELECT'))).toBe(true);
});

test('Postgres doctor distinguishes missing, INVALID/not-ready and foreign building page indexes', async () => {
  const f = postgresFixture();
  f.states.delete(PAGE_ONLINE_INDEXES[0].name);
  f.states.set(PAGE_ONLINE_INDEXES[1].name, { valid: true, ready: false, building: false });
  f.states.set(PAGES_TITLE_LOWER_TRGM_INDEX.name, { valid: false, ready: false, building: true });
  expect((await pageIndexesCheck(f.pg))).toMatchObject({ status: 'warn', details: { count: 2, indexes: [
    { name: PAGE_ONLINE_INDEXES[0].name, state: 'missing' },
    { name: PAGE_ONLINE_INDEXES[1].name, state: 'invalid' },
    { name: PAGES_TITLE_LOWER_TRGM_INDEX.name, state: 'building' },
  ] } });
  const plan = await pageIndexesRepair.plan(f.pg, scope, null);
  expect(plan.items.map(item => item.action)).toEqual(['build', 'drop_invalid_and_rebuild']);
  expect(plan.residuals).toEqual({ building: 1 });
  expect(f.statements.every(sql => sql.startsWith('SELECT'))).toBe(true);
  // A builder can appear between preview and apply; the helper refuses it without any DROP/CREATE.
  f.states.set(plan.items[0]!.slug, { valid: false, ready: false, building: true });
  await expect(pageIndexesRepair.apply(context(f.pg), plan.items[0]!)).rejects.toBeInstanceOf(OnlineIndexInProgressError);
  expect(f.statements.every(sql => sql.startsWith('SELECT'))).toBe(true);
});

test('Postgres page-indexes repairs missing and INVALID v243 indexes online and never hints request-indexes', async () => {
  for (const initial of [undefined, { valid: false, ready: true, building: false }, { valid: true, ready: false, building: false }]) {
    const f = postgresFixture();
    if (initial) f.states.set(PAGES_TITLE_LOWER_TRGM_INDEX.name, initial);
    else f.states.delete(PAGES_TITLE_LOWER_TRGM_INDEX.name);
    const plan = await pageIndexesRepair.plan(f.pg, scope, null);
    expect(plan.items).toHaveLength(1);
    expect(await pageIndexesRepair.apply(context(f.pg), plan.items[0]!)).toBe(true);
    expect(f.statements.filter(sql => sql.startsWith('CREATE'))).toEqual([
      PAGES_TITLE_LOWER_TRGM_INDEX.sql.replace('CREATE INDEX', 'CREATE INDEX CONCURRENTLY'),
    ]);
    expect(f.statements.some(sql => sql.startsWith('DROP INDEX CONCURRENTLY'))).toBe(Boolean(initial));
    expect((await pageIndexesCheck(f.pg)).status).toBe('ok');
    expect((await pageIndexesRepair.plan(f.pg, scope, null)).items).toEqual([]);
  }
  const f = postgresFixture();
  f.states.delete(PAGES_TITLE_LOWER_TRGM_INDEX.name);
  f.failBuild();
  const plan = await pageIndexesRepair.plan(f.pg, scope, null);
  let message = '';
  try { await pageIndexesRepair.apply(context(f.pg), plan.items[0]!); } catch (error) { message = String(error); }
  expect(message).toContain('gbrain repair page-indexes --apply');
  expect(message).not.toContain('request-indexes');
});

test('v240 handler builds both deferred indexes online; a failed build names the page repair', async () => {
  const f = postgresFixture();
  for (const index of PAGE_ONLINE_INDEXES.slice(0, 2)) f.states.delete(index.name);
  await v240.handler!(f.pg);
  expect(f.statements.filter(sql => sql.startsWith('CREATE'))).toEqual(PAGE_ONLINE_INDEXES.slice(0, 2)
    .map(index => index.sql.replace('CREATE INDEX', 'CREATE INDEX CONCURRENTLY')));
  f.states.delete(PAGE_ONLINE_INDEXES[0].name);
  f.failBuild();
  await expect(v240.handler!(f.pg)).rejects.toThrow('gbrain repair page-indexes --apply');
});

test('v243 handler failure carries page repair guidance', async () => {
  const f = postgresFixture();
  f.states.delete(PAGES_TITLE_LOWER_TRGM_INDEX.name);
  f.failBuild();
  // The dependency migration has two non-index statements, covered behaviorally by migrations-v243-nightly-memory.test.ts.
  await expect(v243.handler!(f.pg)).rejects.toThrow('gbrain repair page-indexes --apply');
});
