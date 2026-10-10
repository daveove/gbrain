import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { MIGRATIONS } from '../src/core/migrate.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine, version: string | null;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); version = await engine.getConfig('version'); }, 60_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); if (version) await engine.setConfig('version', version); });

test('v171 gives only queued 60 s daily-memory jobs the 10 minute timeout', async () => {
  const queue = new MinionQueue(engine);
  const day = (n: number) => ({ daily_memory_only: true, daily_memory_date: `2026-01-${10 + n}`, source_cycle_job_ids: [] });
  const waiting = await queue.add('autopilot-daily-memory', day(1), { timeout_ms: 60_000 });
  const delayed = await queue.add('autopilot-daily-memory', day(2), { timeout_ms: 60_000, delay: 60_000 });
  const done = await queue.add('autopilot-daily-memory', day(3), { timeout_ms: 60_000 });
  await engine.executeRaw("UPDATE minion_jobs SET status='completed' WHERE id=$1", [done.id]);
  const custom = await queue.add('autopilot-daily-memory', day(4), { timeout_ms: 30_000 });
  const other = await queue.add('extract', { unrelated: true }, { timeout_ms: 60_000 });

  const sql = MIGRATIONS.find(m => m.version === 171)!.sql!;
  await engine.executeRaw(sql);
  await engine.executeRaw(sql);

  const rows = await engine.executeRaw<{ id: number; timeout_ms: number }>(
    'SELECT id, timeout_ms FROM minion_jobs WHERE id=ANY($1::bigint[]) ORDER BY id',
    [[waiting.id, delayed.id, done.id, custom.id, other.id]]);
  expect(rows.map(row => Number(row.timeout_ms))).toEqual([600_000, 600_000, 60_000, 30_000, 60_000]);
});
