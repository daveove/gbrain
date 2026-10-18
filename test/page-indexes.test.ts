import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PAGE_ONLINE_INDEXES, PAGES_TITLE_LOWER_TRGM_INDEX, readPageIndexStates } from '../src/core/page-indexes.ts';
import { pageIndexesCheck } from '../src/commands/doctor/checks/page-indexes.ts';
import { WAVE_CHECKS } from '../src/commands/doctor/wave-checks.ts';
import { REPAIR_KINDS, resolveRepairScope, runRepair } from '../src/core/repair/core.ts';
import { AUTO_REPAIR_REGISTRY, repairForCheck } from '../src/core/repair/registry.ts';
import { pageIndexesRepair } from '../src/core/repair/page-indexes.ts';

const context = (engine: BrainEngine) => ({ engine, config: { engine: engine.kind }, remote: false, dryRun: false,
  logger: { info() {}, warn() {}, error() {} } }) as unknown as OperationContext;

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });

test('current-schema v240/v243 indexes have native doctor, preview, repair and idempotent resume on PGLite', async () => {
  expect(REPAIR_KINDS).toContain('page-indexes');
  expect(AUTO_REPAIR_REGISTRY.map(spec => spec.kind)).toContain('page-indexes');
  expect(repairForCheck('page_indexes')?.kind).toBe('page-indexes');
  expect(WAVE_CHECKS.find(spec => spec.id === 'page_indexes')).toMatchObject({ resolution: 'repair', registration: 'wave' });
  expect((await pageIndexesCheck(engine)).status).toBe('ok');
  // Both migrations are already stamped; neither handler will run again to recover a dropped index.
  const version = await engine.getConfig('version');
  expect(Number(version)).toBeGreaterThanOrEqual(243);
  for (const index of PAGE_ONLINE_INDEXES) await engine.executeRaw(`DROP INDEX ${index.name}`);
  const doctor = await pageIndexesCheck(engine);
  expect(doctor).toMatchObject({ name: 'page_indexes', status: 'warn', details: { count: 3, repair: 'page-indexes',
    command: 'gbrain repair page-indexes --apply', docs: 'docs/guides/repair.md#page-indexes' } });
  expect(doctor.message).toContain(`${PAGES_TITLE_LOWER_TRGM_INDEX.name} is missing`);
  expect(doctor.message).not.toContain('request-indexes');
  const repairScope = await resolveRepairScope(engine);
  const preview = await runRepair(context(engine), pageIndexesRepair, repairScope, { apply: false });
  expect(preview).toMatchObject({ affected: 3, applied: 0, apply_command: 'gbrain repair page-indexes --apply',
    cost: { lifetime_ids: 0, embedding_pages: 0 } });
  expect((await readPageIndexStates(engine)).map(index => index.state)).toEqual(['missing', 'missing', 'missing']);
  expect(await runRepair(context(engine), pageIndexesRepair, repairScope, { apply: true, limit: 1 })).toMatchObject({ applied: 1, complete: false });
  expect(await runRepair(context(engine), pageIndexesRepair, repairScope, { apply: true })).toMatchObject({ affected: 2, applied: 2, complete: true });
  expect(await engine.getConfig('version')).toBe(version);
  expect((await pageIndexesCheck(engine)).status).toBe('ok');
  expect(await runRepair(context(engine), pageIndexesRepair, repairScope, { apply: true })).toMatchObject({ affected: 0, applied: 0, complete: true });
}, 60_000);

