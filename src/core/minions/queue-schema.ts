import type { BrainEngine } from '../engine.ts';

/** Columns that migrations v5 to v7 add to minion_jobs. */
const QUEUE_REQUIRED_COLUMNS = ['id', 'name', 'queue', 'status', 'data', 'lock_token', 'tokens_input', 'depth', 'max_children', 'timeout_ms', 'remove_on_complete'];

/**
 * The config version row can be missing or stale. The table and its migration
 * v5 to v7 columns are the source of truth.
 */
export async function hasQueueSchema(engine: BrainEngine): Promise<boolean> {
  const rows = await engine.executeRaw<{ found: number | string }>(
    `SELECT count(*) AS found
       FROM pg_attribute
      WHERE attrelid = to_regclass('minion_jobs')
        AND NOT attisdropped
        AND attname = ANY($1::text[])`,
    [QUEUE_REQUIRED_COLUMNS],
  );
  return Number(rows[0]?.found ?? 0) === QUEUE_REQUIRED_COLUMNS.length;
}
