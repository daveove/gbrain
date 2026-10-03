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

test('concurrent claim races are bounded independently of retained history', async () => {
  const data = { stale: true, sourceId: 'default', deferred_commit: pin.commit };
  let calls = 0;
  // The retained tip is far beyond the former 64-generation lifetime cap.
  const metadata = spyOn(engine, 'executeRaw').mockResolvedValue([
    { id: 1000, status: 'completed', data, idempotency_key: 'extract-stale:default:same-pin:after:999' },
  ] as never);
  const add = spyOn(MinionQueue.prototype, 'add').mockImplementation(async () => ({
    id: ++calls === 1 ? 1 : 999 + calls, status: 'active', data,
  }) as never);
  try {
    expect(await queueDeferredStaleSweep(engine, pin)).toBeNull();
    expect(add).toHaveBeenCalledTimes(8);
    expect(metadata).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[1]?.[2]?.idempotency_key).toBe('extract-stale:default:same-pin:after:1000');
  } finally { add.mockRestore(); metadata.mockRestore(); }
});

test('a retained tip from another source cannot accept this source handoff', async () => {
  const add = spyOn(MinionQueue.prototype, 'add').mockResolvedValue({
    id: 1, status: 'completed', data: { stale: true, sourceId: 'default', deferred_commit: pin.commit },
  } as never);
  const metadata = spyOn(engine, 'executeRaw').mockResolvedValue([
    { id: 1000, status: 'waiting', data: { stale: true, sourceId: 'other', deferred_commit: pin.commit },
      idempotency_key: 'extract-stale:default:same-pin:after:999' },
  ] as never);
  try {
    expect(await queueDeferredStaleSweep(engine, pin)).toBeNull();
    expect(add).toHaveBeenCalledTimes(1);
  } finally { add.mockRestore(); metadata.mockRestore(); }
});

test('pending scan continuation refuses a returned sweep with another cursor', async () => {
  const add = spyOn(MinionQueue.prototype, 'add').mockResolvedValue({
    id: 1, status: 'waiting', data: { stale: true, sourceId: 'default', deferred_commit: pin.commit, pending_after: 'internal.pending-links.other' },
  } as never);
  try { expect(await queueDeferredStaleSweep(engine, { ...pin, pendingAfter: 'internal.pending-links.requested' })).toBeNull(); }
  finally { add.mockRestore(); }
});


test('active pending cursor handoff accepts one durable successor for new arrivals', async () => {
  const queue = new MinionQueue(engine), opts = { ...pin, pendingAfter: 'internal.pending-links.cursor' };
  const first = await queueDeferredStaleSweep(engine,opts);
  if (typeof first !== 'number' || first <= 0) throw new Error('Expected accepted numeric queue ID');
  const active = (await queue.claim('pending-cursor-lock',60_000,'default',['extract']))!;
  expect(active.id).toBe(first);
  const successor = await queueDeferredStaleSweep(engine,opts);
  if (typeof successor !== 'number' || successor <= 0) throw new Error('Expected accepted numeric successor ID');
  expect(successor).not.toBe(first);
  expect(await queueDeferredStaleSweep(engine,opts)).toBe(successor);
  const [stored] = await engine.executeRaw<{ status: string; data: Record<string,unknown> }>('SELECT status,data FROM minion_jobs WHERE id=$1',[successor]);
  expect(stored?.status).toBe('waiting'); expect(stored?.data.pending_after).toBe(opts.pendingAfter);
});
