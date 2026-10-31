import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { defaultTimeoutMsFor } from '../src/core/minions/handler-timeouts.ts';
import { v245 } from '../src/core/schema-migrations/v245-daily-memory-job-timeout.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
afterAll(async () => { await engine.disconnect(); });

test('daily memory timeout migration raises only pending jobs at the old 10-minute default', async () => {
  const queue = new MinionQueue(engine);
  const pending = await queue.add('autopilot-daily-memory', {});
  const delayed = await queue.add('autopilot-daily-memory', {});
  const completed = await queue.add('autopilot-daily-memory', {});
  const custom = await queue.add('autopilot-daily-memory', {});
  const other = await queue.add('sync', {});
  await engine.executeRaw('UPDATE minion_jobs SET timeout_ms=600000 WHERE id=ANY($1::bigint[])',
    [[pending.id, delayed.id, completed.id, other.id]]);
  await engine.executeRaw('UPDATE minion_jobs SET timeout_ms=300000 WHERE id=$1', [custom.id]);
  await engine.executeRaw("UPDATE minion_jobs SET status='delayed' WHERE id=$1", [delayed.id]);
  await engine.executeRaw("UPDATE minion_jobs SET status='completed' WHERE id=$1", [completed.id]);
  await engine.runMigration(245, v245.sql);
  await engine.runMigration(245, v245.sql);
  expect(defaultTimeoutMsFor('autopilot-daily-memory')).toBe(1_200_000);
  const rows = await engine.executeRaw<{ id: number; timeout_ms: number }>(
    'SELECT id,timeout_ms FROM minion_jobs WHERE id=ANY($1::bigint[]) ORDER BY id',
    [[pending.id, delayed.id, completed.id, custom.id, other.id]]);
  expect(rows).toEqual([
    { id: pending.id, timeout_ms: 1_200_000 },
    { id: delayed.id, timeout_ms: 1_200_000 },
    { id: completed.id, timeout_ms: 600000 },
    { id: custom.id, timeout_ms: 300000 },
    { id: other.id, timeout_ms: 600000 },
  ]);
});
