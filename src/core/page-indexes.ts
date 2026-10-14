import type { BrainEngine } from './engine.ts';
import { readOnlineIndexState } from './schema-migrations/helpers.ts';

/** v240: Postgres builds these online; fresh PGLite creates them inline. */
export const PAGES_NAME_LOOKUP_INDEXES = [
  { name: 'idx_pages_source_title_lower', table: 'pages',
    sql: 'CREATE INDEX IF NOT EXISTS idx_pages_source_title_lower ON pages (source_id, lower(title))' },
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

export interface PageIndexState {
  name: string;
  state: 'valid' | 'missing' | 'invalid' | 'building';
}

/** A current schema stamp does not prove that an interrupted index build finished. */
export async function readPageIndexStates(engine: BrainEngine): Promise<PageIndexState[]> {
  const states: PageIndexState[] = [];
  for (const index of PAGE_ONLINE_INDEXES) {
    const row = await readOnlineIndexState(engine, index.name);
    states.push({ name: index.name, state: !row ? 'missing' : row.valid && row.ready ? 'valid'
      : row.building ? 'building' : 'invalid' });
  }
  return states;
}
