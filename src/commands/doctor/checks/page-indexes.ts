import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { PAGE_INDEXES_REPAIR_COMMAND, readPageIndexStates } from '../../../core/page-indexes.ts';

/** Index health is independent of the numbered migration ledger. */
export async function pageIndexesCheck(engine: BrainEngine): Promise<Check> {
  const docs = 'docs/guides/repair.md#page-indexes';
  try {
    const indexes = await readPageIndexStates(engine);
    const broken = indexes.filter(index => index.state === 'missing' || index.state === 'invalid' || index.state === 'obsolete');
    const building = indexes.filter(index => index.state === 'building');
    const details = { count: broken.length, indexes, repair: 'page-indexes', command: PAGE_INDEXES_REPAIR_COMMAND, docs };
    if (broken.length) return { name: 'page_indexes', status: 'warn', details,
      message: `${broken.map(index => `${index.name} is ${index.state === 'invalid' ? 'INVALID' : index.state}`).join('; ')}: page lookup indexes need repair; obsolete unbounded indexes can reject long titles. Repair on the brain host: ${PAGE_INDEXES_REPAIR_COMMAND}` };
    if (building.length) return { name: 'page_indexes', status: 'warn', details,
      message: `Still building: ${building.map(index => index.name).join('; ')}. It is safe to leave running; rerun gbrain doctor to follow it.` };
    return { name: 'page_indexes', status: 'ok', message: 'Page lookup indexes are valid and ready.', details };
  } catch (error) {
    return { name: 'page_indexes', status: 'warn',
      message: `Page indexes could not be inspected: ${error instanceof Error ? error.message : String(error)}. Health is unknown.`,
      details: { count: 0, health: 'unknown', docs } };
  }
}
