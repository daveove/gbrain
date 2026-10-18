import type { BrainEngine } from './engine.ts';
import { buildIndexOnline, OnlineIndexInProgressError, readOnlineIndexState } from './schema-migrations/helpers.ts';

/** Bounded title keys retain full equality in readers to reject hash collisions. */
export const PAGES_NAME_LOOKUP_INDEXES = [
  { name: 'idx_pages_source_title_hash', table: 'pages',
    sql: 'CREATE INDEX IF NOT EXISTS idx_pages_source_title_hash ON pages (source_id, hashtext(lower(title)))' },
  { name: 'idx_pages_slug_trgm', table: 'pages',
    sql: 'CREATE INDEX IF NOT EXISTS idx_pages_slug_trgm ON pages USING GIN (slug gin_trgm_ops)' },
] as const;

/** v243 stays migration-only on both engines; never plain-build it during replay. */
export const PAGES_TITLE_LOWER_TRGM_INDEX = {
  name: 'idx_pages_title_lower_trgm', table: 'pages',
  sql: 'CREATE INDEX IF NOT EXISTS idx_pages_title_lower_trgm ON pages USING GIN (lower(title) gin_trgm_ops)',
} as const;

export const PAGE_ONLINE_INDEXES = [...PAGES_NAME_LOOKUP_INDEXES, PAGES_TITLE_LOWER_TRGM_INDEX] as const;
export const PAGE_INDEXES_REPAIR_COMMAND = 'gbrain repair page-indexes --apply';
export const LEGACY_PAGE_TITLE_INDEX = 'idx_pages_source_title_lower';

async function boundedTitleIndexShape(engine: BrainEngine): Promise<boolean | undefined> {
  const [index] = await engine.executeRaw<{ matches: boolean }>(
    `SELECT i.indrelid = to_regclass('pages') AND NOT i.indisunique AND i.indnkeyatts = 2
       AND i.indnatts = 2 AND i.indpred IS NULL AND am.amname = 'btree'
       AND pg_get_indexdef(i.indexrelid, 1, true) = 'source_id'
       AND pg_get_indexdef(i.indexrelid, 2, true) = 'hashtext(lower(title))' AS matches
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_am am ON am.oid = c.relam
       WHERE i.indexrelid = to_regclass($1)`, [PAGES_NAME_LOOKUP_INDEXES[0].name]);
  return index?.matches;
}

export async function buildPageIndexOnline(
  engine: BrainEngine, version: number, index: Parameters<typeof buildIndexOnline>[2],
  opts: Parameters<typeof buildIndexOnline>[3] = {},
) {
  if (index.name === PAGES_NAME_LOOKUP_INDEXES[0].name && await boundedTitleIndexShape(engine) === false) {
    throw new Error(`Conflicting page title index ${index.name}: expected pages (source_id, hashtext(lower(title)))`);
  }
  const outcome = await buildIndexOnline(engine, version, index, opts);
  if (index.name === PAGES_NAME_LOOKUP_INDEXES[0].name && await boundedTitleIndexShape(engine) !== true) {
    throw new Error(`Conflicting page title index ${index.name}: bounded replacement could not be verified`);
  }
  return outcome;
}

export async function retireLegacyPageTitleIndex(engine: BrainEngine, version: number): Promise<boolean> {
  const replacement = await readOnlineIndexState(engine, PAGES_NAME_LOOKUP_INDEXES[0].name);
  if (!replacement?.valid || !replacement.ready || await boundedTitleIndexShape(engine) !== true) {
    throw new Error(`Conflicting page title index ${PAGES_NAME_LOOKUP_INDEXES[0].name}: refusing to retire the legacy index without a valid bounded replacement`);
  }
  if (!await readOnlineIndexState(engine, LEGACY_PAGE_TITLE_INDEX)) return false;
  const [legacy] = await engine.executeRaw<{ owned: boolean }>(
    `SELECT i.indrelid = to_regclass('pages') AND NOT i.indisunique AND i.indnkeyatts = 2
       AND i.indnatts = 2 AND i.indpred IS NULL AND am.amname = 'btree'
       AND pg_get_indexdef(i.indexrelid, 1, true) = 'source_id'
       AND pg_get_indexdef(i.indexrelid, 2, true) = 'lower(title)' AS owned
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_am am ON am.oid = c.relam
       WHERE i.indexrelid = to_regclass($1)`, [LEGACY_PAGE_TITLE_INDEX]);
  if (!legacy?.owned) throw new Error(`Refusing to drop unrelated index ${LEGACY_PAGE_TITLE_INDEX}: expected pages (source_id, lower(title))`);
  const state = await readOnlineIndexState(engine, LEGACY_PAGE_TITLE_INDEX);
  if (!state) return false;
  if (state.building) throw new OnlineIndexInProgressError(LEGACY_PAGE_TITLE_INDEX, PAGE_INDEXES_REPAIR_COMMAND);
  await engine.runMigration(version,
    `DROP INDEX ${engine.kind === 'postgres' ? 'CONCURRENTLY ' : ''}IF EXISTS ${LEGACY_PAGE_TITLE_INDEX};`);
  return true;
}

export interface PageIndexState {
  name: string;
  state: 'valid' | 'missing' | 'invalid' | 'building' | 'obsolete' | 'conflicting';
}

/** A current schema stamp does not prove that an interrupted index build finished. */
export async function readPageIndexStates(engine: BrainEngine): Promise<PageIndexState[]> {
  const states: PageIndexState[] = [];
  for (const index of PAGE_ONLINE_INDEXES) {
    const row = await readOnlineIndexState(engine, index.name);
    const conflicting = row && index.name === PAGES_NAME_LOOKUP_INDEXES[0].name && await boundedTitleIndexShape(engine) !== true;
    states.push({ name: index.name, state: !row ? 'missing' : conflicting ? 'conflicting'
      : row.valid && row.ready ? 'valid' : row.building ? 'building' : 'invalid' });
  }
  const legacy = await readOnlineIndexState(engine, LEGACY_PAGE_TITLE_INDEX);
  if (legacy) states.push({ name: LEGACY_PAGE_TITLE_INDEX, state: legacy.building ? 'building' : 'obsolete' });
  return states;
}
