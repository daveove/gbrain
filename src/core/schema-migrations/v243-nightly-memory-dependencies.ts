import type { Migration } from './types.ts';
import { buildIndexOnline, migrationNotice } from './helpers.ts';
import { TRUST_STAMP_TIER_FUNCTION_SQL } from '../trust/schema.ts';
import { PAGES_TITLE_LOWER_TRGM_INDEX, PAGE_INDEXES_REPAIR_COMMAND } from '../page-indexes.ts';

/** Keep nightly dependencies live, index title lookup, and forward-update calendar provenance trust semantics. */
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
    // v242 brains already ran v226; changing its imported fragment is not an upgrade.
    // Replace only the function: no row rewrite, backfill, or table lock.
    await engine.runMigration(243, `${TRUST_STAMP_TIER_FUNCTION_SQL};`);
    // v240 already supplies the slug trigram and exact source/title indexes.
    // Fresh and upgraded brains build this online through the existing helper.
    await buildIndexOnline(engine, 243, PAGES_TITLE_LOWER_TRGM_INDEX,
      { notice: migrationNotice, repairCommand: PAGE_INDEXES_REPAIR_COMMAND });
  },
};
