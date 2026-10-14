/** #5370: an idle consumer probes once per tick, with a live-policy read, backs off to its cap, and wakes on same-process admission. */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { PersistenceConsumer } from '../src/core/persistence/consumer.ts';
import { admitWrite, getWriteRequestById } from '../src/core/persistence/journal.ts';
import { disposePersistenceConsumer, startPersistenceConsumer, waitForWrite } from '../src/core/persistence/service.ts';
import { admission, fixtures, initializeFixtures, prepared, selectFixtureHost, type HarnessConfig } from '../scripts/persistence/harness.ts';
import { withEnv } from './helpers/with-env.ts';
import { waitFor } from './helpers/wait-for.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-consumer-idle-'));
const config: HarnessConfig = {
  kind: 'pglite', root: home, dataDir: join(home, 'data'), hostId: randomUUID(),
  seed: 5370, schedules: 0, operations: 0, sourceIds: ['consumer-idle'], principalIds: [randomUUID()],
};
const env = { GBRAIN_HOME: home, GBRAIN_PERSISTENCE_FIXTURE_HOME: home };
let engine: PGLiteEngine;

beforeAll(async () => withEnv(env, async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  selectFixtureHost(config.hostId);
  await initializeFixtures(engine, config);
}), 120_000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

function counting(target: PGLiteEngine) {
  const statements: string[] = [];
  const proxy = new Proxy(target, { get(obj, key) {
    if (key === 'executeRaw') return (sql: string, ...rest: unknown[]) => {
      statements.push(sql);
      return (obj.executeRaw as (...args: unknown[]) => Promise<unknown>)(sql, ...rest);
    };
    const value = Reflect.get(obj, key);
    return typeof value === 'function' ? value.bind(obj) : value;
  } });
  return { proxy, statements };
}

async function settled(consumer: PersistenceConsumer): Promise<void> {
  const workers = consumer as unknown as Record<string, Promise<unknown> | undefined>;
  await Promise.all(['projectionWorker', 'effectsWorker', 'topologyWorker', 'maintenanceWorker'].map(name => workers[name]));
}

for (const route of ['reserved', 'direct', 'pool1'] as const) test(
  `live-policy and work probes share the ${route} route with one peak connection`, async () => withEnv(
    { GBRAIN_CONSUMER_DIRECT_LANE: '1' }, async () => {
      let held = 0, peak = 0, reservations = 0;
      const calls: { route: string; sql: string; signal?: AbortSignal }[] = [];
      const poolMax = route === 'reserved' ? 3 : 1;
      const query = async (kind: string, sql: string, opts?: { signal?: AbortSignal }) => {
        const checkout = kind !== 'reserved';
        if (checkout) { held++; peak = Math.max(peak, held); }
        try {
          calls.push({ route: kind, sql, signal: opts?.signal });
          await Promise.resolve();
          return sql.includes('AS work') ? [{ work: false }] : [];
        } finally { if (checkout) held--; }
      };
      // This routing fixture implements only the read-only probe's engine surface.
      const target = {
        kind: 'postgres',
        sql: { options: { max: poolMax } },
        connectionManager: { isDualPoolActive: () => route === 'direct', describeMode: () => ({}) },
        getPoolDiagnostics: () => ({ poolMax, tracked: {} }),
        executeRaw: (sql: string, _params?: unknown[], opts?: { signal?: AbortSignal }) => query('pool', sql, opts),
        executeRawDirect: (sql: string, _params?: unknown[], opts?: { signal?: AbortSignal }) => query('direct', sql, opts),
        async withReservedConnection(run: (conn: unknown) => Promise<void>) {
          reservations++;
          held++; peak = Math.max(peak, held);
          try { await run({ executeRaw: (sql: string) => query('reserved', sql) }); }
          finally { held--; }
        },
      } as unknown as BrainEngine;
      const consumer = new PersistenceConsumer(target, { engine: 'postgres' },
        async () => { throw new Error('no preparation expected'); }, { hostId: randomUUID() });
      // Test-only access to the scheduler's private read-only eligibility probe.
      const probe = consumer as unknown as { hasWork(): Promise<boolean> };
      try {
        expect(await probe.hasWork()).toBe(false);
        expect(calls).toHaveLength(2);
        expect(calls[0].sql).toContain("key IN ('search_embedding_column', 'embedding_columns')");
        expect(calls[1].sql).toContain('AS work');
        const expectedRoute = route === 'pool1' ? 'pool' : route;
        expect(calls.map(call => call.route)).toEqual([expectedRoute, expectedRoute]);
        expect(reservations).toBe(route === 'reserved' ? 1 : 0);
        expect(peak).toBe(1);
        if (route !== 'reserved') {
          expect(calls[0].signal).toBeInstanceOf(AbortSignal);
          expect(calls[1].signal).toBe(calls[0].signal);
        }
      } finally { await consumer.stop(); }
      expect(held).toBe(0);
    }));

test('an idle tick runs a policy read and one work probe instead of the worker fan-out', async () => withEnv(env, async () => {
  const { proxy, statements } = counting(engine);
  const consumer = new PersistenceConsumer(proxy, { engine: 'pglite' }, async () => { throw new Error('no work expected'); },
    { hostId: config.hostId, onError: () => {} });
  try {
    await consumer.tick();
    await settled(consumer);
    await consumer.tick();
    await settled(consumer);
    statements.length = 0;
    for (let i = 0; i < 5; i++) { await consumer.tick(); await settled(consumer); }
    expect(statements.length).toBe(10);
    expect(statements.filter(sql => sql.startsWith('SELECT key, value FROM config')).length).toBe(5);
  } finally { await consumer.stop(); }
}));

test('a queued request behind another process\'s running head does not trigger the fan-out', async () => withEnv(env, async () => {
  const sources = await fixtures(engine, config);
  const head = await admitWrite(engine, admission(config, sources[0], `fifo-head-${randomUUID().slice(0, 8)}`, 'head'));
  const follower = await admitWrite(engine, admission(config, sources[0], `fifo-follower-${randomUUID().slice(0, 8)}`, 'follower'));
  await engine.executeRaw(`UPDATE persistence_requests SET state='running', execution_token=gen_random_uuid(),
    claim_expires_at=now()+interval '10 minutes' WHERE id=$1::uuid`, [head.id]);
  const { proxy, statements } = counting(engine);
  const consumer = new PersistenceConsumer(proxy, { engine: 'pglite' }, async () => { throw new Error('the follower is not claimable'); },
    { hostId: config.hostId, onError: () => {} });
  try {
    await consumer.tick();
    await settled(consumer);
    statements.length = 0;
    for (let i = 0; i < 3; i++) { await consumer.tick(); await settled(consumer); }
    expect(statements.length).toBe(6);
  } finally {
    await consumer.stop();
    await engine.executeRaw(`UPDATE persistence_requests SET state='cancelled', execution_token=NULL, claim_expires_at=NULL
      WHERE id = ANY($1::uuid[])`, [[head.id, follower.id]]);
  }
}));

test('idle polling backs off to the cap, then a wake runs a full tick immediately', async () => withEnv(env, async () => {
  const { proxy, statements } = counting(engine);
  const consumer = new PersistenceConsumer(proxy, { engine: 'pglite' }, async () => { throw new Error('no work expected'); },
    { hostId: config.hostId, pollMs: 20, idleMaxMs: 160, onError: () => {} });
  const refreshes = () => statements.filter(sql => sql.startsWith('SELECT brain_id,enabled,')).length;
  consumer.start();
  try {
    await Bun.sleep(2_000);
    // 20 ms polling for 2 s would be ~100 ticks; doubling to a 160 ms cap is ~15.
    const ticks = statements.filter(sql => sql.includes('AS work')).length;
    expect(ticks).toBeLessThan(40);
    const full = refreshes();
    consumer.wake();
    await waitFor(() => refreshes() > full, { timeoutMs: 1_000 });
  } finally { await consumer.stop(); }
}));

test('concurrent wakes during a tick coalesce into one follow-up tick', async () => {
  const release = Promise.withResolvers<void>();
  const consumer = new PersistenceConsumer(engine, { engine: 'pglite' }, async () => { throw new Error('no work expected'); },
    { hostId: config.hostId, pollMs: 60_000 });
  const scheduler = consumer as unknown as { doTick(): Promise<void> };
  let ticks = 0;
  scheduler.doTick = async () => { if (++ticks === 1) await release.promise; };
  try {
    const active = consumer.tick();
    for (let i = 0; i < 10; i++) consumer.wake();
    release.resolve();
    await active;
    await waitFor(() => ticks === 2, { timeoutMs: 5_000 });
    await Bun.sleep(100);
    expect(ticks).toBe(2);
  } finally { await consumer.stop(); }
});

test('a write admitted by another process is published within the idle cap', async () => withEnv(env, async () => {
  const sources = await fixtures(engine, config);
  const consumer = new PersistenceConsumer(engine, { engine: 'pglite' }, async (_e, row) => prepared(row, sources),
    { hostId: config.hostId, pollMs: 20, idleMaxMs: 300 });
  consumer.start();
  try {
    await Bun.sleep(1_000);
    const started = performance.now();
    const row = await admitWrite(engine, admission(config, sources[0], `cross-process-${randomUUID().slice(0, 8)}`, 'body'));
    await waitFor(async () => (await getWriteRequestById(engine, row.id))?.state === 'committed', { timeoutMs: 5_000 });
    expect(performance.now() - started).toBeLessThan(300 + 3_000);
  } finally { await consumer.stop(); }
}));

test('waiting on an admitted write wakes the resident consumer', async () => withEnv(env, async () => {
  const consumer = startPersistenceConsumer(engine, { engine: 'pglite' });
  let wakes = 0;
  const wake = consumer.wake.bind(consumer);
  consumer.wake = () => { wakes++; wake(); };
  const row = { id: randomUUID(), request_id: randomUUID(), state: 'queued' } as import('../src/core/persistence/model.ts').WriteRequest;
  try {
    await waitForWrite(engine, row, { engine: 'pglite' }, 50);
    expect(wakes).toBe(1);
  } finally { await disposePersistenceConsumer(engine); }
}));
