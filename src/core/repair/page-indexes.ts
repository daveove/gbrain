/** Current-schema recovery for the online v240/v243 page lookup indexes. */
import { PAGE_ONLINE_INDEXES, PAGE_INDEXES_REPAIR_COMMAND, readPageIndexStates } from '../page-indexes.ts';
import { buildIndexOnline } from '../schema-migrations/helpers.ts';
import type { RepairHandler, RepairItem } from './core.ts';

export const pageIndexesRepair: RepairHandler = {
  kind: 'page-indexes',
  publication: 'projection',
  embeds: false,
  // Re-plan every index on resume: an earlier interruption can leave any one invalid.
  async plan(engine) {
    const states = await readPageIndexStates(engine);
    const items: RepairItem[] = states.flatMap((index, position) => index.state === 'missing' || index.state === 'invalid'
      ? [{ cursor: { phase: 0, id: position + 1 }, source_id: '(brain)', slug: index.name, chars: 0,
        action: index.state === 'invalid' ? 'drop_invalid_and_rebuild' : 'build' }] : []);
    return { items, residuals: { building: states.filter(index => index.state === 'building').length } };
  },
  async apply(ctx, item) {
    const index = PAGE_ONLINE_INDEXES.find(candidate => candidate.name === item.slug);
    if (!index) return false;
    const outcome = await buildIndexOnline(ctx.engine, 0, index,
      { notice: line => ctx.logger.info(line.trimEnd()), repairCommand: PAGE_INDEXES_REPAIR_COMMAND });
    return outcome === 'created' || outcome === 'rebuilt';
  },
};
