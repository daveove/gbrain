import type { Migration } from './types.ts';
import { migrationNotice } from './helpers.ts';
import { buildPageIndexOnline, PAGES_NAME_LOOKUP_INDEXES, PAGE_INDEXES_REPAIR_COMMAND, retireLegacyPageTitleIndex } from '../page-indexes.ts';

/** Already-stamped v240..v243 brains must also stop rejecting oversized titles. */
export const v244: Migration = {
  version: 244,
  name: 'bounded_page_title_index',
  idempotent: true,
  transaction: false,
  sql: '',
  handler: async engine => {
    await buildPageIndexOnline(engine, 244, PAGES_NAME_LOOKUP_INDEXES[0],
      { notice: migrationNotice, repairCommand: PAGE_INDEXES_REPAIR_COMMAND });
    await retireLegacyPageTitleIndex(engine, 244);
  },
};
