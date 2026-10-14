import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { defaultTimeoutMsFor } from '../src/core/minions/handler-timeouts.ts';
import { v243 } from '../src/core/schema-migrations/v243-nightly-memory-dependencies.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
afterAll(async () => { await engine.disconnect(); });

test('nightly dependency migration retains online resolver indexes and upgrades only pending old timeouts', async () => {
  const queue = new MinionQueue(engine);
  const pending = await queue.add('autopilot-daily-memory', {});
  const completed = await queue.add('autopilot-daily-memory', {});
  await engine.executeRaw("UPDATE minion_jobs SET timeout_ms=60000 WHERE id=ANY($1::bigint[])", [[pending.id, completed.id]]);
  await engine.executeRaw("UPDATE minion_jobs SET status='completed' WHERE id=$1", [completed.id]);
  await v243.handler!(engine);
  await v243.handler!(engine);
  expect(defaultTimeoutMsFor('autopilot-daily-memory')).toBe(600000);
  const rows = await engine.executeRaw<{ id: number; timeout_ms: number }>(
    'SELECT id,timeout_ms FROM minion_jobs WHERE id=ANY($1::bigint[]) ORDER BY id', [[pending.id, completed.id]]);
  expect(rows).toEqual([{ id: pending.id, timeout_ms: 600000 }, { id: completed.id, timeout_ms: 60000 }]);
  const indexes = await engine.executeRaw<{ indexname: string }>(`SELECT indexname FROM pg_indexes
    WHERE tablename='pages' AND indexname=ANY($1::text[])`,
    [['idx_pages_title_lower_trgm', 'idx_pages_slug_trgm', 'idx_pages_source_title_lower']]);
  expect(indexes.map(row => row.indexname).sort()).toEqual(
    ['idx_pages_title_lower_trgm', 'idx_pages_slug_trgm', 'idx_pages_source_title_lower'].sort());
});
