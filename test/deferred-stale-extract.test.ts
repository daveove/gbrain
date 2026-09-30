import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { queueDeferredStaleSweep } from '../src/core/deferred-stale-extract.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
let schemaVersion: string | null;
beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  schemaVersion = await engine.getConfig('version');
}, 60_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  if (schemaVersion) await engine.setConfig('version', schemaVersion);
});
const pin = { sourceId: 'default', commit: 'same-pin', reason: 'fixture' };

test('parallel same-pin callers share one successor of each active sweep', async () => {
  const queue = new MinionQueue(engine), base = await queueDeferredStaleSweep(engine, pin);
  if (typeof base !== 'number') throw new Error('Expected accepted sweep ID');
  const active = (await queue.claim('base-lock', 60_000, 'default', ['extract']))!;
  expect(active.id).toBe(base);
  const firstWave = await Promise.all(Array.from({ length: 12 }, () => queueDeferredStaleSweep(engine, pin)));
  expect(new Set(firstWave).size).toBe(1);
  expect(firstWave[0]).not.toEqual(base);
  await queue.completeJob(active.id, 'base-lock', {});
  const successor = (await queue.claim('successor-lock', 60_000, 'default', ['extract']))!;
  const firstId = firstWave[0];
  if (typeof firstId !== 'number') throw new Error('Expected accepted successor ID');
  expect(successor.id).toBe(firstId);
  const secondWave = await Promise.all(Array.from({ length: 12 }, () => queueDeferredStaleSweep(engine, pin)));
  expect(new Set(secondWave).size).toBe(1);
  expect(secondWave[0]).not.toEqual(successor.id);
  expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE name='extract'")).toHaveLength(3);
  await queue.completeJob(successor.id, 'successor-lock', {});
  expect(await queueDeferredStaleSweep(engine, pin)).toBe(secondWave[0]);
});

test('completed base accepts fresh same-pin work through a deterministic successor', async () => {
  const queue = new MinionQueue(engine), base = await queueDeferredStaleSweep(engine, pin);
  const active = (await queue.claim('complete-lock', 60_000, 'default', ['extract']))!;
  await queue.completeJob(active.id, 'complete-lock', {});
  const next = await queueDeferredStaleSweep(engine, pin);
  expect(next).not.toBe(base);
  const [stored] = await engine.executeRaw<{ idempotency_key: string; status: string }>('SELECT idempotency_key,status FROM minion_jobs WHERE id=$1', [next]);
  expect(stored.status).toBe('waiting');
  expect(stored.idempotency_key).toBe(`extract-stale:default:same-pin:after:${base}`);
});

test('queue rejection and mismatched or unsupported returned jobs fail closed', async () => {
  const rejected = spyOn(MinionQueue.prototype, 'add').mockRejectedValue(new Error('Synthetic queue failure'));
  try { await expect(queueDeferredStaleSweep(engine, pin)).rejects.toThrow('Synthetic queue failure'); }
  finally { rejected.mockRestore(); }
  for (const returned of [null, { id: 1, status: 'waiting', data: { stale: false } },
    { id: 1, status: 'paused', data: { stale: true, sourceId: 'default', deferred_commit: pin.commit } }]) {
    const add = spyOn(MinionQueue.prototype, 'add').mockResolvedValue(returned as never);
    try { expect(await queueDeferredStaleSweep(engine, pin)).toBeNull(); expect(add).toHaveBeenCalledTimes(1); }
    finally { add.mockRestore(); }
  }
});

test('historical successor traversal is bounded and cannot create unlimited siblings', async () => {
  let id = 0;
  const add = spyOn(MinionQueue.prototype, 'add').mockImplementation(async () => ({
    id: ++id, status: 'completed', data: { stale: true, sourceId: 'default', deferred_commit: pin.commit },
  }) as never);
  try { expect(await queueDeferredStaleSweep(engine, pin)).toBeNull(); expect(add).toHaveBeenCalledTimes(64); }
  finally { add.mockRestore(); }
});
