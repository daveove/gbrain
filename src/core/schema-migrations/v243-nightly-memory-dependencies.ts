import type { Migration } from './types.ts';
import { buildIndexOnline, migrationNotice } from './helpers.ts';

/** Keep imported nightly jobs live and index the resolver's lower(title) trigram arm. */
export const v243: Migration = {
  version: 243,
  name: 'nightly_memory_dependencies',
  idempotent: true,
  transaction: false,
  sql: '',
  handler: async engine => {
    await engine.runMigration(243, `UPDATE minion_jobs SET timeout_ms=600000
      WHERE name='autopilot-daily-memory' AND timeout_ms=60000
        AND status IN ('waiting','delayed','active','waiting-children','paused')`);
    // v240 already supplies the slug trigram and exact source/title indexes.
    // Fresh and upgraded brains build this online through the existing helper.
    await buildIndexOnline(engine, 243, {
      name: 'idx_pages_title_lower_trgm', table: 'pages',
      sql: 'CREATE INDEX IF NOT EXISTS idx_pages_title_lower_trgm ON pages USING GIN (lower(title) gin_trgm_ops)',
    }, { notice: migrationNotice });
  },
};
