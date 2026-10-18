/** Current-schema recovery for bounded page lookup indexes. */
import { buildPageIndexOnline, LEGACY_PAGE_TITLE_INDEX, PAGE_ONLINE_INDEXES, PAGE_INDEXES_REPAIR_COMMAND, readPageIndexStates, retireLegacyPageTitleIndex } from '../page-indexes.ts';
import type { RepairHandler, RepairItem } from './core.ts';

export const pageIndexesRepair: RepairHandler = {
  kind: 'page-indexes',
  publication: 'projection',
  embeds: false,
  // Re-plan every index on resume: an earlier interruption can leave any one invalid.
  async plan(engine) {
    const states = await readPageIndexStates(engine);
    const items: RepairItem[] = states.flatMap((index, position) => index.state === 'missing' || index.state === 'invalid' || index.state === 'obsolete' || index.state === 'conflicting'
      ? [{ cursor: { phase: 0, id: position + 1 }, source_id: '(brain)', slug: index.name, chars: 0,
        action: index.state === 'obsolete' ? 'drop_obsolete' : index.state === 'invalid' ? 'drop_invalid_and_rebuild' : 'build' }] : []);
    return { items, residuals: { building: states.filter(index => index.state === 'building').length } };
  },
  async apply(ctx, item) {
    if (item.slug === LEGACY_PAGE_TITLE_INDEX) {
      for (const index of PAGE_ONLINE_INDEXES) await buildPageIndexOnline(ctx.engine, 0, index,
        { repairCommand: PAGE_INDEXES_REPAIR_COMMAND });
      return retireLegacyPageTitleIndex(ctx.engine, 0);
    }
    const index = PAGE_ONLINE_INDEXES.find(candidate => candidate.name === item.slug);
    if (!index) return false;
    const outcome = await buildPageIndexOnline(ctx.engine, 0, index,
      { notice: line => ctx.logger.info(line.trimEnd()), repairCommand: PAGE_INDEXES_REPAIR_COMMAND });
    return outcome === 'created' || outcome === 'rebuilt';
  },
};
