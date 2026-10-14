/**
 * Shared helpers for schema migrations (src/core/schema-migrations/v<NNN>-*.ts).
 *
 * Leaf module: migration files and the runner in src/core/migrate.ts import
 * from here; nothing under src/core/schema-migrations/ may import migrate.ts
 * (ESM import cycle -> TDZ at module load, including in the compiled binary).
 */
import type { BrainEngine } from '../engine.ts';

/**
 * When true, per-migration explanatory notices (e.g. the v123/v124 "here is
 * what this migration changed" lines that specific handlers write to stderr)
 * are suppressed. Set by runMigrations for a FRESH-install full replay — those
 * notices are useful diagnostics on an UPGRADE but pure noise as a new user's
 * first-run output. Module-level (not threaded through the Migration type)
 * because only a couple of handlers emit them. Guarded via `migrationNotice`.
 * Known limitation: concurrent runMigrations calls in one process (two engines
 * migrating simultaneously) share this flag — worst case is a suppressed or
 * extra stderr NOTICE line; migration execution/stamping is unaffected.
 */
let quietMigrationNotices = false;

/** Write a per-migration explanatory notice unless fresh-install quiet mode is
 *  on. Handlers should route their "what changed" lines through this. */
export function migrationNotice(line: string): void {
  if (quietMigrationNotices) return;
  process.stderr.write(line);
}

/** Runner-only: toggles fresh-install quiet mode for `migrationNotice`. */
export function setQuietMigrationNotices(quiet: boolean): void {
  quietMigrationNotices = quiet;
}

/**
 * Postgres-only: drops `indexName` iff it currently exists AND is invalid or
 * not ready — the leftover of a failed `CREATE INDEX CONCURRENTLY`. A fresh
 * progress probe protects a foreign active build, including one that started
 * after the caller's initial probe. Callers MUST already be inside an
 * `engine.kind === 'postgres'` branch and run this before their own
 * `CREATE INDEX CONCURRENTLY IF NOT EXISTS`.
 *
 * Deliberately does NOT wrap the drop in `DO $$ ... EXECUTE '...' END $$`
 * (#1178): Postgres rejects `CONCURRENTLY` from any function/EXECUTE context —
 * the guard condition works, but the EXECUTE that follows always throws
 * "DROP INDEX CONCURRENTLY cannot be executed from a function". The validity
 * probe runs as a plain application-level SELECT instead, and the DROP (when
 * needed) runs as its own top-level `runMigration` call.
 */
export async function dropInvalidConcurrentIndex(
  engine: BrainEngine,
  version: number,
  indexName: string,
  repairCommand?: string,
): Promise<boolean> {
  const state = await readOnlineIndexState(engine, indexName);
  if (!state || (state.valid && state.ready)) return false;
  if (state.building) throw new OnlineIndexInProgressError(indexName, repairCommand);
  await engine.runMigration(version, `DROP INDEX CONCURRENTLY IF EXISTS ${indexName};`);
  return true;
}

export type OnlineIndexOutcome = 'present' | 'created' | 'rebuilt';

const MIGRATION_REPAIR_COMMAND = 'gbrain init --migrate-only';

/** An unusable index with a foreign builder cannot be accepted or dropped. */
export class OnlineIndexInProgressError extends Error {
  constructor(public readonly indexName: string, repairCommand = MIGRATION_REPAIR_COMMAND) {
    super(`Index ${indexName} is being built by another session; rerun after the builder completes: ${repairCommand}`);
    this.name = 'OnlineIndexInProgressError';
  }
}

export type OnlineIndexState = { valid: boolean; ready: boolean; building: boolean };

/** Resolve through search_path, just like the unqualified CREATE/DROP statements. */
export async function readOnlineIndexState(engine: BrainEngine, indexName: string): Promise<OnlineIndexState | undefined> {
  const [state] = await engine.executeRaw<OnlineIndexState>(
    `SELECT i.indisvalid AS valid, i.indisready AS ready, ${engine.kind === 'postgres'
      ? `EXISTS (SELECT 1 FROM pg_stat_progress_create_index p
          WHERE p.relid = i.indrelid AND p.index_relid IN (i.indexrelid, 0)
            AND p.pid <> pg_backend_pid())`
      : 'false'} AS building
       FROM pg_index i WHERE i.indexrelid = to_regclass($1)`,
    [indexName],
  );
  return state;
}

/**
 * #5762: build one index without blocking writers. Only a VALID + READY index
 * succeeds; complete targets are accepted even when another same-table build
 * has not yet published its index OID. An unusable foreign active build throws
 * rather than allowing a migration stamp; inactive failed leftovers can be rebuilt.
 * Postgres builds CONCURRENTLY under the session's startup timeouts with no
 * session SET; PGLite builds inline. Every create is checked again because
 * IF NOT EXISTS can skip an unusable index left by a competing caller.
 */
export async function buildIndexOnline(
  engine: BrainEngine,
  version: number,
  index: { name: string; table: string; sql: string },
  opts: { notice?: (line: string) => void; repairCommand?: string } = {},
): Promise<OnlineIndexOutcome> {
  const repairCommand = opts.repairCommand ?? MIGRATION_REPAIR_COMMAND;
  const row = await readOnlineIndexState(engine, index.name);
  if (row?.valid && row.ready) return 'present';
  if (row?.building) throw new OnlineIndexInProgressError(index.name, repairCommand);
  let rebuilt = false;
  if (row) {
    // Probe again immediately before destructive DDL: the builder may have
    // started (or completed) since the first catalog snapshot.
    const beforeDrop = engine.kind === 'postgres' ? await readOnlineIndexState(engine, index.name) : row;
    if (beforeDrop?.valid && beforeDrop.ready) return 'present';
    if (beforeDrop?.building) throw new OnlineIndexInProgressError(index.name, repairCommand);
    if (beforeDrop) {
      await engine.runMigration(version, `DROP INDEX ${engine.kind === 'postgres' ? 'CONCURRENTLY ' : ''}IF EXISTS ${index.name};`);
      rebuilt = true;
    }
  }
  if (engine.kind === 'postgres' && opts.notice) {
    const [size] = await engine.executeRaw<{ rows: number }>(
      'SELECT GREATEST(reltuples, 0)::bigint AS rows FROM pg_class WHERE oid = to_regclass($1)', [index.table]);
    opts.notice(`  building ${index.name} on ~${Number(size?.rows ?? 0)} rows; this can take minutes; it is safe to leave running; `
      + `if interrupted, rerun: ${repairCommand}\n`);
  }
  // No session SET: a reservation can fall back to a transaction-pooled connection, where a SET or RESET
  // reaches another client's backend. The build runs under the session's startup timeouts; one that times
  // out leaves an INVALID index, which the next call drops and rebuilds.
  if (engine.kind === 'postgres') {
    await engine.withReservedConnection(conn => conn.executeRaw(index.sql.replace('CREATE INDEX', 'CREATE INDEX CONCURRENTLY')), { selfContained: true });
  } else {
    await engine.runMigration(version, index.sql);
  }
  const built = await readOnlineIndexState(engine, index.name);
  if (built?.valid && built.ready) return rebuilt ? 'rebuilt' : 'created';
  if (built?.building) throw new OnlineIndexInProgressError(index.name, repairCommand);
  throw new Error(`Index ${index.name} is not valid after its ${engine.kind === 'postgres' ? 'concurrent ' : ''}build (requires VALID and READY); rerun: ${repairCommand}`);
}
