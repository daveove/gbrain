import type { Migration } from './types.ts';
import { migrationNotice } from './helpers.ts';
import { buildPageIndexOnline, PAGES_NAME_LOOKUP_INDEXES, PAGE_INDEXES_REPAIR_COMMAND } from '../page-indexes.ts';

/** Build bounded exact-title and slug lookup indexes on both engines. */

export const v240: Migration = {
  version: 240,
  name: 'pages_name_lookup_indexes',
  idempotent: true,
  transaction: false,
  sql: '',
  handler: async engine => {
    for (const index of PAGES_NAME_LOOKUP_INDEXES) {
      await buildPageIndexOnline(engine, 240, index, { notice: migrationNotice, repairCommand: PAGE_INDEXES_REPAIR_COMMAND });
    }
  },
};
