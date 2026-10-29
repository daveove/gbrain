import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { v243 } from '../src/core/schema-migrations/v243-nightly-memory-dependencies.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
afterAll(async () => { await engine.disconnect(); });

test('nightly dependency migration upgrades only pending old timeouts', async () => {
  const queue = new MinionQueue(engine);
  const pending = await queue.add('autopilot-daily-memory', {});
  const completed = await queue.add('autopilot-daily-memory', {});
  await engine.executeRaw("UPDATE minion_jobs SET timeout_ms=60000 WHERE id=ANY($1::bigint[])", [[pending.id, completed.id]]);
  await engine.executeRaw("UPDATE minion_jobs SET status='completed' WHERE id=$1", [completed.id]);
  await v243.handler!(engine);
  await v243.handler!(engine);
  const rows = await engine.executeRaw<{ id: number; timeout_ms: number }>(
    'SELECT id,timeout_ms FROM minion_jobs WHERE id=ANY($1::bigint[]) ORDER BY id', [[pending.id, completed.id]]);
  expect(rows).toEqual([{ id: pending.id, timeout_ms: 600000 }, { id: completed.id, timeout_ms: 60000 }]);
});
