import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from '#postgres';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { runMigrations } from '../src/core/migrate.ts';
import { buildIndexOnline, OnlineIndexInProgressError } from '../src/core/schema-migrations/helpers.ts';
import { PAGES_TITLE_LOWER_TRGM_INDEX } from '../src/core/page-indexes.ts';
import { pageIndexesCheck } from '../src/commands/doctor/checks/page-indexes.ts';
import { pageIndexesRepair } from '../src/core/repair/page-indexes.ts';
import { runRepair, resolveRepairScope } from '../src/core/repair/core.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { runMigrateOnlyCore, MIGRATE_ONLY_TIMEOUT_MS, MigrateOnlyError } from '../src/commands/migrations/in-process.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

// Real timers are intentional here: PostgreSQL's process clock and active
// statement cancellation cannot be exercised with JavaScript fake timers.
// Explicit opt-in, additionally guarded against every non-loopback target.
const url = process.env.DAV_6928_PROOF_DATABASE_URL;
if (url && (new URL(url).hostname !== '127.0.0.1' || !new URL(url).port)) {
  throw new Error('DAV-6928 proofs require an explicitly ported disposable loopback PostgreSQL');
}
const index = PAGES_TITLE_LOWER_TRGM_INDEX;

describe.skipIf(!url)('DAV-6928 disposable PostgreSQL acceptance', () => {
  let fixture: { engine: PostgresEngine; databaseUrl: string; close: () => Promise<void> };
  let observer: postgres.Sql;
  beforeAll(async () => {
    fixture = await isolatedPersistencePostgres(url!, 'instance', 1);
    observer = postgres(fixture.databaseUrl, { max: 1, onnotice() {} });
    const [version] = await observer`SHOW server_version_num`;
    expect(Number(version.server_version_num)).toBeGreaterThanOrEqual(170000);
    expect(Number(version.server_version_num)).toBeLessThan(180000);
  }, 120_000);
  afterAll(async () => { await observer?.end(); await fixture?.close(); });

  async function waitForBuild() {
    for (let n = 0; n < 200; n++) {
      const [row] = await observer`SELECT p.pid, p.phase FROM pg_stat_progress_create_index p
        JOIN pg_index i ON i.indexrelid = p.index_relid WHERE i.indexrelid = to_regclass(${index.name})`;
      if (row) return row;
      await Bun.sleep(10);
    }
    throw new Error('own foreign-build fixture did not reach concurrent index progress');
  }

  test('foreign concurrent build refuses migration stamp and remains untouched; completed valid index is a no-op', async () => {
    const { engine } = fixture;
    await engine.executeRaw(`DROP INDEX ${index.name}`);
    await engine.setConfig('version', '242');
    const holder = postgres(fixture.databaseUrl, { max: 1, onnotice() {} });
    const foreign = postgres(fixture.databaseUrl, { max: 1, onnotice() {} });
    let build: Promise<unknown> | undefined;
    try {
      await holder.unsafe('BEGIN; LOCK TABLE pages IN ROW EXCLUSIVE MODE');
      build = foreign.unsafe(index.sql.replace('CREATE INDEX', 'CREATE INDEX CONCURRENTLY')).then(rows => rows);
      const progress = await waitForBuild();
      const refusal = await runMigrations(engine).catch(error => error);
      expect(refusal).toBeInstanceOf(OnlineIndexInProgressError);
      expect(refusal.message).toContain(index.name);
      expect(await engine.getConfig('version')).toBe('242');
      const [still] = await observer`SELECT pid, state, query FROM pg_stat_activity WHERE pid=${progress.pid}`;
      expect(still.state).toBe('active');
      expect(still.query).toContain(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${index.name}`);
      const [registered] = await observer`SELECT indexrelid::text AS oid, indisvalid FROM pg_index WHERE indexrelid=to_regclass(${index.name})`;
      expect(registered).toBeDefined();
      expect(registered.indisvalid).toBe(false);
      await holder.unsafe('COMMIT');
      await build;
      const [before] = await observer`SELECT indexrelid::text AS oid FROM pg_index WHERE indexrelid=to_regclass(${index.name})`;
      expect(await buildIndexOnline(engine, 243, index)).toBe('present');
      await runMigrations(engine);
      expect(await engine.getConfig('version')).toBe('243');
      const [after] = await observer`SELECT indexrelid::text AS oid, indisvalid, indisready FROM pg_index WHERE indexrelid=to_regclass(${index.name})`;
      expect(after).toMatchObject({ oid: before.oid, indisvalid: true, indisready: true });
    } finally {
      await holder.unsafe('ROLLBACK').catch(() => {});
      await build?.catch(() => {});
      await Promise.all([holder.end(), foreign.end()]);
    }
  }, 60_000);

  test('failed owned build leaves INVALID; rerun drops and rebuilds before stamping', async () => {
    const { engine } = fixture;
    await engine.executeRaw(`DROP INDEX ${index.name}`);
    await engine.setConfig('version', '242');
    const failing = new PostgresEngine();
    const holder = postgres(fixture.databaseUrl, { max: 1, onnotice() {} });
    await failing.connect({ database_url: fixture.databaseUrl, poolSize: 1, migrationStatementTimeoutMs: 250 });
    try {
      await holder.unsafe('BEGIN; LOCK TABLE pages IN ROW EXCLUSIVE MODE');
      await expect(runMigrations(failing)).rejects.toThrow();
      expect(await engine.getConfig('version')).toBe('242');
      const [invalid] = await observer`SELECT indexrelid::text AS oid, indisvalid FROM pg_index WHERE indexrelid=to_regclass(${index.name})`;
      expect(invalid.indisvalid).toBe(false);
      await holder.unsafe('COMMIT');
      await runMigrations(engine);
      const [valid] = await observer`SELECT indexrelid::text AS oid, indisvalid, indisready FROM pg_index WHERE indexrelid=to_regclass(${index.name})`;
      expect(valid).toMatchObject({ indisvalid: true, indisready: true });
      expect(valid.oid).not.toBe(invalid.oid);
      expect(await engine.getConfig('version')).toBe('243');
    } finally {
      await holder.unsafe('ROLLBACK').catch(() => {});
      await Promise.all([failing.disconnect(), holder.end()]);
    }
  }, 60_000);

  test('native doctor diagnoses missing and invalid v243 index and page-indexes repairs online', async () => {
    const { engine } = fixture;
    const context = { engine, config: { engine: 'postgres' }, remote: false, dryRun: false,
      logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
    const scope = await resolveRepairScope(engine);
    await engine.executeRaw(`DROP INDEX ${index.name}`);
    expect(await pageIndexesCheck(engine)).toMatchObject({ status: 'warn', message: expect.stringContaining('gbrain repair page-indexes --apply') });
    expect(await runRepair(context, pageIndexesRepair, scope, { apply: true })).toMatchObject({ applied: 1, complete: true });
    const holder = postgres(fixture.databaseUrl, { max: 1, onnotice() {} });
    const failing = new PostgresEngine();
    await failing.connect({ database_url: fixture.databaseUrl, poolSize: 1, migrationStatementTimeoutMs: 250 });
    try {
      await engine.executeRaw(`DROP INDEX ${index.name}`);
      await holder.unsafe('BEGIN; LOCK TABLE pages IN ROW EXCLUSIVE MODE');
      await expect(buildIndexOnline(failing, 243, index)).rejects.toThrow();
      await holder.unsafe('COMMIT');
      const diagnosis = await pageIndexesCheck(engine);
      expect(diagnosis.status).toBe('warn');
      expect(diagnosis.message).toContain('INVALID');
      expect(diagnosis.message).toContain('gbrain repair page-indexes --apply');
      expect(await runRepair(context, pageIndexesRepair, scope, { apply: true })).toMatchObject({ applied: 1, complete: true });
      expect((await pageIndexesCheck(engine)).status).toBe('ok');
    } finally {
      await holder.unsafe('ROLLBACK').catch(() => {});
      await Promise.all([failing.disconnect(), holder.end()]);
    }
  }, 60_000);

  test('stamped v240 replay never builds page lookup indexes inline; native repair builds them online', async () => {
    const { engine } = fixture;
    for (const name of ['idx_pages_source_title_lower', 'idx_pages_slug_trgm']) await engine.executeRaw(`DROP INDEX ${name}`);
    await engine.initSchema();
    for (const name of ['idx_pages_source_title_lower', 'idx_pages_slug_trgm']) {
      const [row] = await engine.executeRaw<{ missing: boolean }>('SELECT to_regclass($1) IS NULL AS missing', [name]);
      expect(row.missing).toBe(true);
    }
    const context = { engine, config: { engine: 'postgres' }, remote: false, dryRun: false,
      logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
    expect(await runRepair(context, pageIndexesRepair, await resolveRepairScope(engine), { apply: true }))
      .toMatchObject({ applied: 2, complete: true });
    expect((await pageIndexesCheck(engine)).status).toBe('ok');
  }, 60_000);

  test('migrate-only read and existing DDL routes share the 30-minute budget at pool one', async () => {
    const migrated = new PostgresEngine();
    try {
      await withEnv({ GBRAIN_DIRECT_DATABASE_URL: fixture.databaseUrl }, () =>
        migrated.connect({ database_url: fixture.databaseUrl, poolSize: 1, migrationStatementTimeoutMs: MIGRATE_ONLY_TIMEOUT_MS }));
      const [read] = await migrated.executeRaw<{ pid: number; timeout: string }>(
        "SELECT pg_backend_pid() AS pid, current_setting('statement_timeout') AS timeout");
      const direct = await migrated.withReservedConnection(async conn => {
        const [row] = await conn.executeRaw<{ pid: number; timeout: string }>(
          "SELECT pg_backend_pid() AS pid, current_setting('statement_timeout') AS timeout");
        return row;
      }, { selfContained: true });
      expect(read.timeout).toBe('30min');
      expect(direct.timeout).toBe('30min');
      expect(direct.pid).not.toBe(read.pid);
      expect(migrated.connectionManager?.describeMode().direct_pool_size).toBe(1);
      const [clients] = await observer`SELECT count(*)::int AS count FROM pg_stat_activity WHERE pid IN (${read.pid}, ${direct.pid})`;
      expect(clients.count).toBe(2);
    } finally { await migrated.disconnect(); }
  }, 10_000);

  test('migrate-only explicit off disables disconnect checks on both existing routes', async () => {
    const migrated = new PostgresEngine();
    try {
      await withEnv({ GBRAIN_DIRECT_DATABASE_URL: fixture.databaseUrl, GBRAIN_CLIENT_CHECK_INTERVAL: 'off' }, async () => {
        await migrated.connect({ database_url: fixture.databaseUrl, poolSize: 1, migrationStatementTimeoutMs: MIGRATE_ONLY_TIMEOUT_MS });
        const [read] = await migrated.executeRaw<{ interval: string }>(
          "SELECT current_setting('client_connection_check_interval') AS interval");
        const direct = await migrated.withReservedConnection(async conn => {
          const [row] = await conn.executeRaw<{ interval: string }>(
            "SELECT current_setting('client_connection_check_interval') AS interval");
          return row;
        }, { selfContained: true });
        expect(read.interval).toBe('0');
        expect(direct.interval).toBe('0');
      });
    } finally { await migrated.disconnect(); }
  }, 10_000);

  test('migrate-only deadline cancels a real late statement without an extra client; ordinary timeout stays five minutes', async () => {
    const { engine } = fixture;
    const [ordinary] = await engine.executeRaw<{ statement_timeout: string }>('SHOW statement_timeout');
    expect(ordinary.statement_timeout).toBe('5min');
    expect(MIGRATE_ONLY_TIMEOUT_MS).toBe(1_800_000);
    const home = mkdtempSync(join(tmpdir(), 'dav-6928-deadline-'));
    mkdirSync(join(home, '.gbrain'));
    writeFileSync(join(home, '.gbrain/config.json'), JSON.stringify({ engine: 'postgres', database_url: fixture.databaseUrl }));
    const original = PostgresEngine.prototype.initSchema;
    let targetPid = 0, statementTimeout = '', peak = 0;
    let sample: NodeJS.Timeout | undefined;
    PostgresEngine.prototype.initSchema = async function () {
      const [settings] = await this.executeRaw<{ pid: number; timeout: string }>("SELECT pg_backend_pid() AS pid, current_setting('statement_timeout') AS timeout");
      targetPid = settings.pid; statementTimeout = settings.timeout;
      // Make SQL's fallback deliberately much later than the application
      // deadline: only real socket cancellation can retire it within this test.
      await this.executeRaw("SET statement_timeout = '30s'");
      // Start the statement late: its own SQL timeout is later than the outer
      // deadline, so merely raising statement_timeout cannot pass this proof.
      await Bun.sleep(350);
      await this.executeRaw("SELECT pg_sleep(30) /* dav_6928_deadline */");
    };
    try {
      sample = setInterval(() => {
        void observer`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database()`
          .then(([row]) => { peak = Math.max(peak, row.count); });
      }, 10);
      await expect(withEnv({ GBRAIN_HOME: home, GBRAIN_DIRECT_DATABASE_URL: undefined },
        () => runMigrateOnlyCore({ timeoutMs: 700 }))).rejects.toBeInstanceOf(MigrateOnlyError);
      expect(statementTimeout).toBe('700ms');
      for (let n = 0; n < 200; n++) {
        const [row] = await observer`SELECT state FROM pg_stat_activity WHERE pid=${targetPid}`;
        if (!row) break;
        await Bun.sleep(10);
      }
      expect(await observer`SELECT pid FROM pg_stat_activity WHERE pid=${targetPid}`).toHaveLength(0);
      // Existing fixture + observer + one migrate-only client; no CancelRequest
      // socket or replacement connection is admitted on deadline.
      expect(peak).toBeLessThanOrEqual(3);
      expect(peak).toBe(3);
    } finally {
      clearInterval(sample);
      PostgresEngine.prototype.initSchema = original;
    }
  }, 10_000);
});
