/**
 * #5401: the projection drain command and the budgeted resident drain. Clock
 * and per-page cost are injected; no assertion depends on wall-clock time.
 * PGLite here; test/e2e/projection-drain-postgres.test.ts runs the same file on
 * PostgreSQL, where the concurrent owner schedules also run.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { rebuildPendingPageProjections, projectionBacklog } from '../src/core/page-state/projections.ts';
import { runResidentProjectionInvocation } from '../src/core/persistence/consumer.ts';
import { claimNextWrite, hasClaimableWrite } from '../src/core/persistence/journal.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { drainProjections } from '../src/commands/projections.ts';
import { checkProjectionReadiness } from '../src/commands/doctor/checks/projection-readiness.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { requestFixture } from './helpers/persistence-request-fixture.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
let sourceSeq = 0;

beforeAll(async () => {
  if (backends.includes('pglite')) {
    const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  }
  if (backends.includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) if (engine.kind === 'pglite') await engine.disconnect();
  await closePostgres?.();
});

/** Each test drains its own source: earlier tests' rows are gone or out of scope. */
async function clearQueue(engine: BrainEngine) {
  await engine.executeRaw('DELETE FROM page_projection_jobs');
  await engine.executeRaw("DELETE FROM persistence_requests WHERE state IN ('queued','running')");
}

async function backlog(engine: BrainEngine, pages: number): Promise<string> {
  await clearQueue(engine);
  const sourceId = `drain-${++sourceSeq}`;
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
  for (let i = 0; i < pages; i++) {
    await engine.putPage(`notes/n-${String(i).padStart(4, '0')}`, { type: 'note', title: `Note ${i}`, compiled_truth: `Example note ${i} about a sample topic.` }, { sourceId });
  }
  await engine.executeRaw('UPDATE pages SET text_projection_revision=NULL WHERE source_id=$1', [sourceId]);
  await engine.executeRaw(`INSERT INTO page_projection_jobs(source_incarnation,slug,revision,reason)
    SELECT s.incarnation,p.slug,p.knowledge_revision,'test_backlog' FROM pages p JOIN sources s ON s.id=p.source_id WHERE p.source_id=$1
    ON CONFLICT(source_incarnation,slug) DO UPDATE SET revision=EXCLUDED.revision,reason=EXCLUDED.reason,updated_at=now()`, [sourceId]);
  return sourceId;
}

/** A clock that advances by the injected per-page cost (half per transaction: lock, then install). */
function costed(engine: BrainEngine, costMs: number) {
  const clock = { t: 0, now: () => clock.t };
  const transaction = engine.transaction.bind(engine);
  const executeRaw = engine.executeRaw.bind(engine);
  const fetched = { rows: 0, batches: [] as number[], columns: [] as string[] };
  const proxy = new Proxy(engine, { get(target, key) {
    if (key === 'transaction') return <T>(run: (tx: BrainEngine) => Promise<T>) => { clock.t += costMs / 2; return transaction(run); };
    if (key === 'executeRaw') return async (...args: Parameters<BrainEngine['executeRaw']>) => {
      const rows = await executeRaw(...args);
      if (args[0].startsWith('SELECT s.id AS source_id,j.source_incarnation,j.slug,j.revision')) {
        fetched.rows += rows.length;
        fetched.batches.push(rows.length);
        if (rows.length) fetched.columns = Object.keys(rows[0]).sort();
      }
      return rows;
    };
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { engine: proxy, clock, fetched };
}

const pending = async (engine: BrainEngine) => (await projectionBacklog(engine)).pending;

test('a budgeted rebuild starts no page after the deadline, and the resident invocation uses the 250 ms budget', async () => {
  for (const engine of engines) {
    const sourceId = await backlog(engine, 40);
    const queue = () => engine.executeRaw(`SELECT j.slug,j.revision::text,j.reason,j.updated_at::text
      FROM page_projection_jobs j JOIN sources s ON s.incarnation=j.source_incarnation WHERE s.id=$1 ORDER BY j.slug`, [sourceId]);
    const pages = () => engine.executeRaw(`SELECT slug,knowledge_revision::text,text_projection_revision::text,compiled_truth,timeline
      FROM pages WHERE source_id=$1 ORDER BY slug`, [sourceId]);
    const beforeQueue = await queue();
    const beforePages = await pages();
    const direct = costed(engine, 40);
    expect(await rebuildPendingPageProjections(direct.engine, 100, { deadlineMs: 250, now: direct.clock.now })).toEqual({ rebuilt: 7, superseded: 0 });
    expect(direct.clock.t - 40).toBeLessThan(250);
    expect(direct.fetched.rows).toBe(8);
    expect(direct.fetched.batches).toEqual([4, 4]);
    expect(direct.fetched.columns).toEqual(['revision', 'slug', 'source_id', 'source_incarnation']);
    expect(await queue()).toEqual(beforeQueue.slice(7));
    expect((await pages()).slice(7)).toEqual(beforePages.slice(7));
    const resident = costed(engine, 40);
    expect(await runResidentProjectionInvocation(resident.engine, localHostId(), [], resident.clock.now)).toEqual({ rebuilt: 7, superseded: 0 });
    expect(resident.fetched.rows).toBe(8);
    expect(resident.fetched.batches).toEqual([4, 4]);
    expect(await queue()).toEqual(beforeQueue.slice(14));
    expect((await pages()).slice(14)).toEqual(beforePages.slice(14));
    expect(await pending(engine)).toBe(26);
  }
}, 120_000);

test('deadline windows retain the first-page guarantee and the full 100-page cap for fast rebuilds', async () => {
  for (const engine of engines) {
    await backlog(engine, 110);
    const first = costed(engine, 40);
    expect(await rebuildPendingPageProjections(first.engine, 100, { deadlineMs: 0, now: first.clock.now })).toEqual({ rebuilt: 1, superseded: 0 });
    expect(first.fetched.rows).toBe(4);
    expect(await pending(engine)).toBe(109);
    const fast = costed(engine, 0);
    expect(await rebuildPendingPageProjections(fast.engine, 150, { deadlineMs: 250, now: fast.clock.now })).toEqual({ rebuilt: 100, superseded: 0 });
    expect(fast.fetched.rows).toBe(100);
    expect(fast.fetched.batches).toEqual(Array(25).fill(4));
    const drain = costed(engine, 0);
    expect(await rebuildPendingPageProjections(drain.engine, 100)).toEqual({ rebuilt: 9, superseded: 0 });
    expect(drain.fetched.batches).toEqual([9]);
    expect(await pending(engine)).toBe(0);
  }
}, 120_000);

test('a later candidate fetch that crosses the deadline starts no additional page', async () => {
  for (const engine of engines) {
    await backlog(engine, 10);
    const timed = costed(engine, 10);
    const delayed = new Proxy(timed.engine, { get(target, key) {
      if (key === 'executeRaw') return async (...args: Parameters<BrainEngine['executeRaw']>) => {
        const rows = await target.executeRaw(...args);
        if (timed.fetched.batches.length === 2) timed.clock.t += 250;
        return rows;
      };
      const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    expect(await rebuildPendingPageProjections(delayed, 100, { deadlineMs: 250, now: timed.clock.now })).toEqual({ rebuilt: 4, superseded: 0 });
    expect(timed.fetched.batches).toEqual([4, 4]);
    expect(await pending(engine)).toBe(6);
  }
}, 120_000);

test('deadline windows do not retry a failed page and still heal stale rows before later candidates', async () => {
  for (const engine of engines) {
    const sourceId = await backlog(engine, 10);
    await engine.executeRaw("UPDATE page_projection_jobs SET revision=gen_random_uuid() WHERE slug='notes/n-0001'");
    const timed = costed(engine, 0);
    const transaction = timed.engine.transaction.bind(timed.engine);
    let attempts = 0;
    const broken = new Proxy(timed.engine, { get(target, key) {
      if (key === 'transaction') return <T>(run: (tx: BrainEngine) => Promise<T>) => {
        if (attempts++ === 0) return Promise.reject(new Error('simulated preparation failure'));
        return transaction(run);
      };
      const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const failures: Array<{ slug: string; reason: string }> = [];
    expect(await rebuildPendingPageProjections(broken, 100, {
      deadlineMs: 250, now: timed.clock.now, onFailure: failure => failures.push(failure),
    })).toEqual({ rebuilt: 9, superseded: 0 });
    expect(timed.fetched.batches).toEqual([4, 4, 2]);
    expect(failures).toEqual([expect.objectContaining({ slug: 'notes/n-0000', reason: 'simulated preparation failure' })]);
    expect(await engine.executeRaw('SELECT slug,reason FROM page_projection_jobs')).toEqual([{ slug: 'notes/n-0000', reason: 'rebuild_failed' }]);
    const repaired = (await engine.readPageSnapshot('notes/n-0001', { sourceId }))!;
    expect(repaired.page.text_projection_revision).toBe(repaired.revision);
  }
}, 120_000);

test('each deadline window preserves source, page, reason, and microsecond run-start filters', async () => {
  for (const engine of engines) {
    const sourceId = await backlog(engine, 12);
    const otherSource = `drain-${++sourceSeq}`;
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [otherSource]);
    await engine.putPage('notes/n-0000', { type: 'note', title: 'Other source', compiled_truth: 'Keep this queued.' }, { sourceId: otherSource });
    await engine.executeRaw("UPDATE page_projection_jobs SET updated_at='2026-01-01 00:00:00.000400+00'");
    await engine.executeRaw("UPDATE page_projection_jobs SET reason='other_reason' WHERE slug='notes/n-0007'");
    await engine.executeRaw("UPDATE page_projection_jobs SET updated_at='2026-01-01 00:00:00.000500+00' WHERE slug='notes/n-0008'");
    const before = await engine.executeRaw('SELECT source_incarnation,slug,revision,reason,updated_at::text FROM page_projection_jobs ORDER BY source_incarnation,slug');
    const timed = costed(engine, 0);
    const slugs = Array.from({ length: 9 }, (_, i) => `notes/n-${String(i).padStart(4, '0')}`);
    expect(await rebuildPendingPageProjections(timed.engine, 5, {
      deadlineMs: 250, now: timed.clock.now, notAfter: '2026-01-01 00:00:00.000400+00',
      reasons: ['test_backlog'], pages: { sourceId, slugs },
    })).toEqual({ rebuilt: 5, superseded: 0 });
    expect(timed.fetched.batches).toEqual([4, 1]);
    const rest = costed(engine, 0);
    expect(await rebuildPendingPageProjections(rest.engine, 100, {
      deadlineMs: 250, now: rest.clock.now, notAfter: '2026-01-01 00:00:00.000400+00',
      reasons: ['test_backlog'], pages: { sourceId, slugs },
    })).toEqual({ rebuilt: 2, superseded: 0 });
    const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [sourceId]);
    expect(await engine.executeRaw('SELECT source_incarnation,slug,revision,reason,updated_at::text FROM page_projection_jobs ORDER BY source_incarnation,slug'))
      .toEqual(before.filter(row => row.source_incarnation !== source.incarnation || !slugs.slice(0, 7).includes(String(row.slug))));
  }
}, 120_000);

test('a claimable write drops the resident invocation to two pages; a blocked or excluded write does not', async () => {
  for (const engine of engines) {
    await backlog(engine, 30);
    const f = await requestFixture(engine);
    const head = await f.admit('head');
    const invoke = (excluded: string[]) => { const timed = costed(engine, 20); return runResidentProjectionInvocation(timed.engine, localHostId(), excluded, timed.clock.now); };
    expect(await hasClaimableWrite(engine, localHostId())).toBe(true);
    const waiting = costed(engine, 20);
    expect((await runResidentProjectionInvocation(waiting.engine, localHostId(), [], waiting.clock.now)).rebuilt).toBe(2);
    expect(waiting.fetched.batches).toEqual([2]);
    const root = `db:${head.source_incarnation}`;
    expect(await hasClaimableWrite(engine, localHostId(), [root])).toBe(false);
    expect((await invoke([root])).rebuilt).toBe(13);
    expect((await claimNextWrite(engine, localHostId()))?.id).toBe(head.id);
    await f.admit('behind-running-head');
    expect(await hasClaimableWrite(engine, localHostId())).toBe(false);
    expect((await invoke([])).rebuilt).toBe(13);
    expect(await pending(engine)).toBe(2);
  }
}, 120_000);

test('a 1,000-page backlog drains in the invocation count the injected per-page cost predicts', async () => {
  for (const engine of engines) {
    await backlog(engine, 1000);
    const { engine: timed, clock, fetched } = costed(engine, 10);
    let invocations = 0;
    for (;;) {
      const startedAt = clock.t;
      const rowsBefore = fetched.rows;
      const result = await runResidentProjectionInvocation(timed, localHostId(), [], clock.now);
      if (result.rebuilt + result.superseded === 0) break;
      invocations++;
      expect(result.rebuilt).toBe(25);
      expect(clock.t - 10 - startedAt).toBeLessThan(250);
      expect(fetched.rows - rowsBefore).toBeLessThanOrEqual(result.rebuilt + 3);
    }
    expect(invocations).toBe(40);
    expect(await pending(engine)).toBe(0);
  }
}, 300_000);

test('a drain run tries a failing page once, keeps rebuilding the rest, and reports it with its reason', async () => {
  for (const engine of engines) {
    const sourceId = await backlog(engine, 3);
    await engine.putPage('broken-code', { type: 'code', page_kind: 'code', title: 'Missing origin', compiled_truth: 'export const example = 1;' }, { sourceId });
    const result = await drainProjections(engine);
    expect(result).toMatchObject({ rebuilt: 3, superseded: 0, remaining: 1, limited: false });
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ source_id: sourceId, slug: 'broken-code' });
    expect(result.failed[0].reason).toContain('recorded source path');
    expect(await engine.executeRaw("SELECT reason FROM page_projection_jobs WHERE slug='broken-code'")).toEqual([{ reason: 'rebuild_failed' }]);
  }
}, 120_000);

test('the resident selector waits 30 seconds before retrying a failed page; the drain command does not', async () => {
  for (const engine of engines) {
    const sourceId = await backlog(engine, 0);
    await engine.putPage('broken-code', { type: 'code', page_kind: 'code', title: 'Missing origin', compiled_truth: 'export const example = 1;' }, { sourceId });
    await engine.executeRaw("UPDATE page_projection_jobs SET reason='rebuild_failed',updated_at=now()-interval '10 seconds'");
    const stamp = async () => (await engine.executeRaw<{ at: string }>('SELECT updated_at::text AS at FROM page_projection_jobs'))[0].at;
    const cooling = await stamp();
    expect(await runResidentProjectionInvocation(engine, localHostId(), [])).toEqual({ rebuilt: 0, superseded: 0 });
    expect(await stamp()).toBe(cooling);
    await engine.executeRaw("UPDATE page_projection_jobs SET updated_at=now()-interval '1 minute'");
    const due = await stamp();
    await runResidentProjectionInvocation(engine, localHostId(), []);
    expect(await stamp()).not.toBe(due);
    await engine.executeRaw("UPDATE page_projection_jobs SET updated_at=now()-interval '10 seconds'");
    expect((await drainProjections(engine)).failed.map(failure => failure.slug)).toEqual(['broken-code']);
  }
}, 120_000);

test('the run-start bound keeps microseconds: a row queued at the bound is tried, one queued 100 microseconds after it is not', async () => {
  for (const engine of engines) {
    await backlog(engine, 1);
    await engine.executeRaw("UPDATE page_projection_jobs SET updated_at='2026-01-01 00:00:00.000400+00'");
    expect(await rebuildPendingPageProjections(engine, 100, { notAfter: '2026-01-01 00:00:00.000300+00' })).toEqual({ rebuilt: 0, superseded: 0 });
    expect(await rebuildPendingPageProjections(engine, 100, { notAfter: '2026-01-01 00:00:00.000400+00' })).toEqual({ rebuilt: 1, superseded: 0 });
  }
}, 120_000);

test('a preparation error is one page failure, not a batch abort', async () => {
  for (const engine of engines) {
    await backlog(engine, 4);
    const transaction = engine.transaction.bind(engine);
    let calls = 0;
    const broken = new Proxy(engine, { get(target, key) {
      if (key === 'transaction') return <T>(run: (tx: BrainEngine) => Promise<T>) => {
        if (calls++ === 0) return Promise.reject(new Error('simulated preparation failure'));
        return transaction(run);
      };
      const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const failures: Array<{ slug: string; reason: string }> = [];
    expect(await rebuildPendingPageProjections(broken, 100, { onFailure: failure => failures.push(failure) })).toEqual({ rebuilt: 3, superseded: 0 });
    expect(failures).toEqual([expect.objectContaining({ slug: 'notes/n-0000', reason: 'simulated preparation failure' })]);
    expect(await engine.executeRaw('SELECT slug,reason FROM page_projection_jobs')).toEqual([{ slug: 'notes/n-0000', reason: 'rebuild_failed' }]);
  }
}, 120_000);

test('--limit caps the pages tried and the result records that the run stopped early', async () => {
  for (const engine of engines) {
    await backlog(engine, 12);
    expect(await drainProjections(engine, { limit: 5 })).toEqual({ rebuilt: 5, superseded: 0, failed: [], remaining: 7, limited: true });
    expect(await drainProjections(engine)).toEqual({ rebuilt: 7, superseded: 0, failed: [], remaining: 0, limited: false });
  }
}, 120_000);

test('doctor names the drain command when no PGLite resident holds the brain, and the resident when one does', async () => {
  for (const engine of engines) {
    const sourceId = await backlog(engine, 1);
    const local = await checkProjectionReadiness(engine, { sourceId });
    expect(local.status).toBe('warn');
    expect(local.message).toContain('Run `gbrain projections drain`');
    expect(local.message).not.toContain('Restart the upgraded resident');
    const resident = await checkProjectionReadiness(engine, { sourceId }, { resident: true });
    expect(resident.message).toContain('resident gbrain process that holds this PGLite brain is rebuilding');
    expect(resident.message).not.toContain('Run `gbrain projections drain`');
    await drainProjections(engine);
    expect((await checkProjectionReadiness(engine, { sourceId })).status).toBe('ok');
  }
}, 120_000);

/** Pauses the first page of `engine` until `release` resolves, at `point`. */
function paused(engine: BrainEngine, point: 'before_lock' | 'after_lock') {
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const transaction = engine.transaction.bind(engine);
  let first = true;
  const proxy = new Proxy(engine, { get(target, key) {
    if (key === 'transaction') return async <T>(run: (tx: BrainEngine) => Promise<T>) => {
      if (!first) return transaction(run);
      first = false;
      if (point === 'before_lock') { reached.resolve(); await release.promise; return transaction(run); }
      return transaction(tx => run(new Proxy(tx, { get(inner, prop) {
        if (prop === 'lockPageKeys') return async (keys: unknown) => { await (inner as any).lockPageKeys(keys); reached.resolve(); await release.promise; };
        const value = Reflect.get(inner, prop, inner); return typeof value === 'function' ? value.bind(inner) : value;
      } })));
    };
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { engine: proxy, reached: reached.promise, release: () => release.resolve() };
}

test('on Postgres the drain runs beside a resident owner and each page is rebuilt once in either order', async () => {
  for (const engine of engines.filter(candidate => candidate.kind === 'postgres')) {
    await backlog(engine, 3);
    const cli = paused(engine, 'before_lock');
    const drain = drainProjections(cli.engine);
    await cli.reached;
    expect(await runResidentProjectionInvocation(engine, localHostId(), [])).toEqual({ rebuilt: 3, superseded: 0 });
    cli.release();
    expect(await drain).toEqual({ rebuilt: 0, superseded: 3, failed: [], remaining: 0, limited: false });

    const sourceId = await backlog(engine, 1);
    const holder = paused(engine, 'after_lock');
    const first = drainProjections(holder.engine);
    await holder.reached;
    const resident = runResidentProjectionInvocation(engine, localHostId(), []);
    for (let attempt = 0; attempt < 200; attempt++) {
      const [waiting] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted');
      if (waiting.n > 0) break;
      await Bun.sleep(25);
    }
    holder.release();
    const [cliRun, residentRun] = await Promise.all([first, resident]);
    expect(cliRun.failed).toEqual([]);
    expect({ rebuilt: cliRun.rebuilt + residentRun.rebuilt, superseded: cliRun.superseded + residentRun.superseded }).toEqual({ rebuilt: 1, superseded: 1 });
    const [page] = await engine.executeRaw<{ sealed: boolean }>("SELECT text_projection_revision=knowledge_revision AS sealed FROM pages WHERE slug='notes/n-0000' AND source_id=$1", [sourceId]);
    expect(page.sealed).toBe(true);
  }
}, 120_000);
