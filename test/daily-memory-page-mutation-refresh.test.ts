import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { DAILY_MEMORY_SOURCE_ID, ensureDailyMemorySource } from '../src/core/cycle/daily-memory.ts';
import { dailyMemoryDaysForSlugs, refreshDailyMemoryAfterPageMutation, runDailyMemoryJob } from '../src/core/cycle/daily-memory-followup.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { registerLocalWriter, localHostId } from '../src/core/persistence/identity.ts';
import { admitWrite, claimNextWrite } from '../src/core/persistence/journal.ts';
import { publishMutation } from '../src/core/persistence/coordinator.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  const local = new PGLiteEngine(); await local.connect({}); await local.initSchema(); engines.push(local);
  if (process.env.DATABASE_URL) {
    const isolated = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(isolated.engine); closePostgres = isolated.close;
  }
  for (const engine of engines) {
    await registerLocalWriter(engine, 'cli');
    await engine.setConfig('dream.timezone', 'Asia/Manila');
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.();
});
const context = (engine: BrainEngine, sourceId: string): OperationContext => ({ engine, sourceId,
  config: { engine: engine.kind, embedding_disabled: true }, remote: false, dryRun: false,
  logger: { info() {}, warn() {}, error() {} } });
const content = (day: string) => `---\ntype: note\ntitle: Publication fixture\ndate: "${day}"\n---\n\nSynthetic fixture`;
async function drainDaily(engine: BrainEngine) {
  const queue = new MinionQueue(engine);
  for (let i = 0; i < 40; i++) {
    const job = await queue.claim('publication-daily-lock', 60_000, 'default', ['autopilot-daily-memory']);
    if (!job) return;
    await queue.completeJob(job.id, 'publication-daily-lock', await runDailyMemoryJob(engine, job));
  }
  throw new Error('Fixture daily queue did not settle');
}
async function dailyBody(engine: BrainEngine, day: string) {
  return (await engine.getPage(`daily-memory/${day}`, { sourceId: DAILY_MEMORY_SOURCE_ID }))?.compiled_truth ?? '';
}

test('wait-zero publication and idempotent replay accept settled daily work for date moves, delete, restore and capture', async () => {
  for (const engine of engines) {
    const sourceId = `mutation-${randomUUID()}`, slug = 'notes/publication';
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    const ctx = context(engine, sourceId), requestId = randomUUID();
    const input = { operation: 'put_page', params: { slug, content: content('2026-09-20'), request_id: requestId } };
    await expect(submitPageMutation(ctx, { ...input, waitMs: 0 })).rejects.toMatchObject({ code: 'write_pending' });
    await submitPageMutation(ctx, { ...input, waitMs: 30_000 });
    const jobs = await engine.executeRaw('SELECT id FROM minion_jobs');
    await submitPageMutation(ctx, { ...input, waitMs: 30_000 });
    expect(await engine.executeRaw('SELECT id FROM minion_jobs')).toEqual(jobs);
    await drainDaily(engine);
    const link = `[[${sourceId}:${slug}]]`;
    expect(await dailyBody(engine, '2026-09-20')).toContain(link);
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug, expected_revision: (await engine.readPageSnapshot(slug, { sourceId }))!.revision, content: content('2026-09-21'), request_id: randomUUID() }, waitMs: 30_000 });
    await drainDaily(engine);
    expect(await dailyBody(engine, '2026-09-20')).not.toContain(link);
    expect(await dailyBody(engine, '2026-09-21')).toContain(link);
    await submitPageMutation(ctx, { operation: 'delete_page', params: { slug, expected_revision: (await engine.readPageSnapshot(slug, { sourceId }))!.revision, request_id: randomUUID() }, waitMs: 30_000 });
    await drainDaily(engine);
    expect(await dailyBody(engine, '2026-09-21')).not.toContain(link);
    await submitPageMutation(ctx, { operation: 'restore_page', params: { slug, expected_revision: (await engine.readPageSnapshot(slug, { sourceId, includeDeleted: true }))!.revision, request_id: randomUUID() }, waitMs: 30_000 });
    await drainDaily(engine);
    expect(await dailyBody(engine, '2026-09-21')).toContain(link);
    await submitPageMutation(ctx, { operation: 'capture', params: { slug: 'notes/captured', content: content('2026-09-22'), request_id: randomUUID() }, waitMs: 30_000 });
    await drainDaily(engine);
    expect(await dailyBody(engine, '2026-09-22')).toContain(`[[${sourceId}:notes/captured]]`);
    await disposePersistenceConsumer(engine);
  }
}, 120_000);

test('rejected settlement handoff rolls back the canonical page, versions, effects and all child jobs', async () => {
  for (const engine of engines) {
    const sourceId = `rollback-${randomUUID()}`, slug = 'notes/rollback';
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    await engine.putPage(slug, { type: 'note', title: 'Rollback fixture', compiled_truth: 'Before', frontmatter: { date: '2026-09-20' } }, { sourceId });
    const ctx = context(engine, sourceId), snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
    const authority = await submissionAuthority(ctx, 'put_page', sourceId, snapshot.sourceIncarnation, slug);
    const admitted = await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId,
      sourceIncarnation: snapshot.sourceIncarnation, slug, pageId: snapshot.page.id, requestId: randomUUID(),
      callerIntent: { content: 'After' }, intent: { content: 'After' } });
    const row = (await claimNextWrite(engine, localHostId()))!;
    expect(row.id).toBe(admitted.id);
    const beforeJobs = await engine.executeRaw('SELECT id FROM minion_jobs ORDER BY id');
    const beforeVersions = await engine.executeRaw('SELECT id FROM page_versions WHERE page_id=$1 ORDER BY id', [snapshot.page.id]);
    const add = MinionQueue.prototype.add;
    const rejected = spyOn(MinionQueue.prototype, 'add').mockImplementation(async function(this: MinionQueue, name, data, opts) {
      if (name === 'autopilot-daily-memory') throw new Error('Synthetic settlement rejection');
      return add.call(this, name, data, opts);
    });
    try {
      const result = await publishMutation(engine, row, { observedRevision: snapshot.revision,
        apply: async tx => {
          await tx.putPage(slug, { type: 'note', title: 'Rollback fixture', compiled_truth: 'After', frontmatter: { date: '2026-09-21' } }, { sourceId });
          return {};
        } }, localHostId());
      expect(result.state).not.toBe('committed');
    } finally { rejected.mockRestore(); }
    expect((await engine.readPageSnapshot(slug, { sourceId }))!.revision).toBe(snapshot.revision);
    expect((await engine.getPage(slug, { sourceId }))!.compiled_truth).toBe('Before');
    expect(await engine.executeRaw('SELECT id FROM minion_jobs ORDER BY id')).toEqual(beforeJobs);
    expect(await engine.executeRaw('SELECT id FROM page_versions WHERE page_id=$1 ORDER BY id', [snapshot.page.id])).toEqual(beforeVersions);
    expect(await engine.executeRaw('SELECT id FROM persistence_effects WHERE request_id=$1::uuid', [row.id])).toHaveLength(0);
  }
}, 120_000);

test('pre-apply dates survive updated-at fallback replacement and hard purge without an old index', async () => {
  for (const engine of engines) {
    const sourceId = `prior-day-${randomUUID()}`;
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    const ctx = context(engine, sourceId);
    await engine.putPage('notes/undated', { type: 'note', title: 'Undated fixture', compiled_truth: 'Before', frontmatter: {} }, { sourceId });
    await engine.executeRaw("UPDATE pages SET effective_date=NULL,effective_date_source=NULL,updated_at='2026-09-23T12:00:00Z'::timestamptz WHERE source_id=$1 AND slug='notes/undated'", [sourceId]);
    expect(await engine.getPage('daily-memory/2026-09-23', { sourceId: DAILY_MEMORY_SOURCE_ID })).toBeNull();
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug: 'notes/undated', expected_revision: (await engine.readPageSnapshot('notes/undated', { sourceId }))!.revision, content: content('2026-09-24'), request_id: randomUUID() }, waitMs: 30_000 });
    const handoffs = await engine.executeRaw<{ data: { daily_memory_date: string } }>("SELECT data FROM minion_jobs WHERE name='autopilot-daily-memory'");
    expect(handoffs.map(row => row.data.daily_memory_date)).toEqual(expect.arrayContaining(['2026-09-23', '2026-09-24']));
    await engine.putPage('notes/purged', { type: 'note', title: 'Purge fixture', compiled_truth: 'Synthetic fixture', frontmatter: { date: '2026-09-25' } }, { sourceId });
    await engine.executeRaw("UPDATE pages SET effective_date='2026-09-25'::date::timestamptz,effective_date_source='date' WHERE source_id=$1 AND slug='notes/purged'", [sourceId]);
    const doomed = (await engine.getPage('notes/purged', { sourceId }))!;
    await engine.createVersion('notes/purged', { sourceId });
    await submitPageMutation(ctx, { operation: 'delete_page', params: { slug: 'notes/purged', expected_revision: (await engine.readPageSnapshot('notes/purged', { sourceId }))!.revision, purge: true, request_id: randomUUID() }, waitMs: 30_000 });
    expect(await engine.getPage('notes/purged', { sourceId, includeDeleted: true })).toBeNull();
    expect(await engine.executeRaw('SELECT id FROM page_versions WHERE page_id=$1', [doomed.id])).toHaveLength(0);
    const purgedHandoffs = await engine.executeRaw<{ data: { daily_memory_date: string } }>("SELECT data FROM minion_jobs WHERE name='autopilot-daily-memory'");
    expect(purgedHandoffs.some(row => row.data.daily_memory_date === '2026-09-25')).toBe(true);
    await drainDaily(engine);
    await disposePersistenceConsumer(engine);
  }
}, 120_000);

test('version reverts refresh prior and restored dates atomically and roll back rejected handoffs', async () => {
  for (const engine of engines) {
    const sourceId = `revert-day-${randomUUID()}`, slug = 'notes/version-date';
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    const ctx = context(engine, sourceId);
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug, content: content('2026-09-26'), request_id: randomUUID() }, waitMs: 30_000 });
    const oldVersion = await engine.createVersion(slug, { sourceId });
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug, content: content('2026-09-27'), expected_revision: (await engine.readPageSnapshot(slug, { sourceId }))!.revision, request_id: randomUUID() }, waitMs: 30_000 });
    const newVersion = await engine.createVersion(slug, { sourceId });
    await drainDaily(engine);
    expect(await dailyBody(engine, '2026-09-27')).toContain(`[[${sourceId}:${slug}]]`);
    const beforeJobs = await engine.executeRaw<{ id: number }>('SELECT id FROM minion_jobs ORDER BY id');
    await submitPageMutation(ctx, { operation: 'revert_version', params: { slug, version_id: oldVersion.id, expected_revision: (await engine.readPageSnapshot(slug, { sourceId }))!.revision, request_id: randomUUID() }, waitMs: 30_000 });
    const handoffs = await engine.executeRaw<{ data: { daily_memory_date: string } }>("SELECT data FROM minion_jobs WHERE name='autopilot-daily-memory' AND id>$1", [Math.max(0, ...beforeJobs.map(row => Number(row.id)))]);
    expect(handoffs.map(row => row.data.daily_memory_date)).toEqual(expect.arrayContaining(['2026-09-26', '2026-09-27']));
    await drainDaily(engine);
    expect(await dailyBody(engine, '2026-09-26')).toContain(`[[${sourceId}:${slug}]]`);
    expect(await dailyBody(engine, '2026-09-27')).not.toContain(`[[${sourceId}:${slug}]]`);
    const before = (await engine.readPageSnapshot(slug, { sourceId }))!;
    const jobs = await engine.executeRaw('SELECT id FROM minion_jobs ORDER BY id');
    const add = MinionQueue.prototype.add;
    const rejected = spyOn(MinionQueue.prototype, 'add').mockImplementation(async function(this: MinionQueue, name, data, opts) {
      if (name === 'autopilot-daily-memory') throw new Error('Synthetic version refresh rejection');
      return add.call(this, name, data, opts);
    });
    try { await expect(submitPageMutation(ctx, { operation: 'revert_version', params: { slug, version_id: newVersion.id, expected_revision: before.revision, request_id: randomUUID() }, waitMs: 30_000 })).rejects.toThrow(); }
    finally { rejected.mockRestore(); }
    expect((await engine.readPageSnapshot(slug, { sourceId }))!.revision).toBe(before.revision);
    expect((await engine.getPage(slug, { sourceId }))!.frontmatter).toEqual(before.page.frontmatter);
    expect(await engine.executeRaw('SELECT id FROM minion_jobs ORDER BY id')).toEqual(jobs);
    await disposePersistenceConsumer(engine);
  }
}, 120_000);
test('revert_version queues prior and restored calendar days for daily indexes', async () => {
  for (const engine of engines) {
    const sourceId = `revert-${randomUUID()}`, slug = 'notes/revert-day';
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    const ctx = context(engine, sourceId);
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug, content: content('2026-09-20'), request_id: randomUUID() }, waitMs: 30_000 });
    await drainDaily(engine);
    const link = `[[${sourceId}:${slug}]]`;
    expect(await dailyBody(engine, '2026-09-20')).toContain(link);
    const first = (await engine.readPageSnapshot(slug, { sourceId }))!;
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug, expected_revision: first.revision, content: content('2026-09-21'), request_id: randomUUID() }, waitMs: 30_000 });
    await drainDaily(engine);
    expect(await dailyBody(engine, '2026-09-20')).not.toContain(link);
    expect(await dailyBody(engine, '2026-09-21')).toContain(link);
    const prior = (await engine.getVersions(slug, { sourceId })).find(version =>
      (version.frontmatter as { date?: string } | undefined)?.date === '2026-09-20');
    expect(prior).toBeTruthy();
    const current = (await engine.readPageSnapshot(slug, { sourceId }))!;
    await submitPageMutation(ctx, { operation: 'revert_version', params: { slug, version_id: prior!.id, expected_revision: current.revision, request_id: randomUUID() }, waitMs: 30_000 });
    const handoffs = await engine.executeRaw<{ data: { daily_memory_date: string } }>(
      "SELECT data FROM minion_jobs WHERE name='autopilot-daily-memory'");
    expect(handoffs.map(row => row.data.daily_memory_date)).toEqual(expect.arrayContaining(['2026-09-20', '2026-09-21']));
    await drainDaily(engine);
    expect(await dailyBody(engine, '2026-09-21')).not.toContain(link);
    expect(await dailyBody(engine, '2026-09-20')).toContain(link);
    await disposePersistenceConsumer(engine);
  }
}, 120_000);

test('12 versioned date edits then one mutation refresh only captured preimage and current days', async () => {
  for (const engine of engines) {
    const sourceId = `bounded-days-${randomUUID()}`, slug = 'notes/version-history';
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    const ctx = context(engine, sourceId), queue = new MinionQueue(engine);
    for (let i = 1; i <= 12; i++) {
      const snapshot = await engine.readPageSnapshot(slug, { sourceId });
      await submitPageMutation(ctx, { operation: 'put_page', params: { slug,
        ...(snapshot ? { expected_revision: snapshot.revision } : {}),
        content: content(`2026-02-${String(i).padStart(2, '0')}`), request_id: randomUUID() }, waitMs: 30_000 });
    }
    expect((await engine.getVersions(slug, { sourceId })).length).toBeGreaterThanOrEqual(11);
    // Retire the earlier queue rows without rendering aggregates: history is
    // recoverable for import/sync, but must not amplify an ordinary publication.
    for (;;) {
      const job = await queue.claim('version-history-lock', 60_000, 'default', ['autopilot-daily-memory']);
      if (!job) break;
      await queue.completeJob(job.id, 'version-history-lock', {});
    }
    const before = await engine.executeRaw<{ id: number }>('SELECT id FROM minion_jobs');
    const lastId = Math.max(0, ...before.map(row => Number(row.id)));
    const receipt = await submitPageMutation(ctx, { operation: 'put_page', params: { slug,
      expected_revision: (await engine.readPageSnapshot(slug, { sourceId }))!.revision,
      content: content('2026-02-13'), request_id: randomUUID() }, waitMs: 30_000 });
    expect((receipt.outcome as Record<string, unknown>).daily_memory_affected_dates).toEqual(['2026-02-12', '2026-02-13']);
    const jobs = await engine.executeRaw<{ data: { daily_memory_date: string } }>(
      "SELECT data FROM minion_jobs WHERE name='autopilot-daily-memory' AND id>$1", [lastId]);
    expect(jobs).toHaveLength(2);
    expect(jobs.map(job => job.data.daily_memory_date).sort()).toEqual(['2026-02-12', '2026-02-13']);
    expect((await dailyMemoryDaysForSlugs(engine, sourceId, [slug])).length).toBeGreaterThan(2);
    for (;;) {
      const job = await queue.claim('bounded-days-cleanup', 60_000, 'default', ['autopilot-daily-memory']);
      if (!job) break;
      await queue.completeJob(job.id, 'bounded-days-cleanup', {});
    }
    await disposePersistenceConsumer(engine);
  }
}, 120_000);

test('pending publication days coalesce through delayed and claimed successor generations with timezone isolation', async () => {
  for (const engine of engines) {
    const sourceId = `coalesced-days-${randomUUID()}`, slug = 'notes/coalesce', day = '2026-03-01';
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    await engine.putPage(slug, { type: 'note', title: 'Synthetic coalescing', compiled_truth: 'Synthetic',
      frontmatter: { date: day }, effective_date: new Date(`${day}T00:00:00Z`), effective_date_source: 'date' }, { sourceId });
    const queue = new MinionQueue(engine);
    for (let generation = 0; generation < 10; generation++) {
      const refresh = () => refreshDailyMemoryAfterPageMutation(engine, { sourceId, slug,
        operation: 'put_page', timezone: 'UTC' });
      await Promise.all(Array.from({ length: 12 }, refresh));
      const pending = await engine.executeRaw<{ id: number; idempotency_key: string }>(
        "SELECT id,idempotency_key FROM minion_jobs WHERE name='autopilot-daily-memory' AND data->>'daily_memory_date'=$1 AND data->>'daily_memory_timezone'='UTC' AND status IN ('waiting','delayed')", [day]);
      expect(pending).toHaveLength(1);
      const active = (await queue.claim('generation-lock', 60_000, 'default', ['autopilot-daily-memory']))!;
      expect(active.id).toBe(pending[0].id);
      await Promise.all(Array.from({ length: 12 }, refresh));
      const [successor] = await engine.executeRaw<{ id: number; idempotency_key: string }>(
        "SELECT id,idempotency_key FROM minion_jobs WHERE name='autopilot-daily-memory' AND data->>'daily_memory_date'=$1 AND status='waiting'", [day]);
      expect(successor.idempotency_key).toBe(`autopilot-daily:${day}:UTC:pending:after:${active.id}`);
      await queue.completeJob(active.id, 'generation-lock', {});
      const claimed = (await queue.claim('delay-lock', 60_000, 'default', ['autopilot-daily-memory']))!;
      expect(claimed.id).toBe(successor.id);
      await queue.deferJob(claimed.id, 'delay-lock', 'Synthetic delayed generation', 0);
      await refresh();
      expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE name='autopilot-daily-memory' AND data->>'daily_memory_date'=$1 AND status IN ('waiting','delayed')", [day])).toHaveLength(1);
      await queue.promoteDelayed({ registeredNames: ['autopilot-daily-memory'], queue: 'default' });
    }
    await refreshDailyMemoryAfterPageMutation(engine, { sourceId, slug, operation: 'put_page',
      timezone: 'Asia/Manila' });
    const pending = await engine.executeRaw<{ data: { daily_memory_timezone: string } }>(
      "SELECT data FROM minion_jobs WHERE name='autopilot-daily-memory' AND data->>'daily_memory_date'=$1 AND status='waiting'", [day]);
    expect(pending.map(job => job.data.daily_memory_timezone).sort()).toEqual(['Asia/Manila', 'UTC']);
    const original = MinionQueue.prototype.add;
    let raced: number | undefined;
    const claimRace = spyOn(MinionQueue.prototype, 'add').mockImplementation(async function(this: MinionQueue, ...args: Parameters<MinionQueue['add']>) {
      const accepted = await original.call(this, ...args);
      if (raced === undefined && accepted.coalesced && accepted.status === 'waiting') {
        // Return admission's stale waiting snapshot after a worker claim.
        const claimed = (await this.claim('admission-race-lock', 60_000, 'default', ['autopilot-daily-memory']))!;
        expect(claimed.id).toBe(accepted.id);
        raced = claimed.id;
      }
      return accepted;
    });
    try {
      await refreshDailyMemoryAfterPageMutation(engine, { sourceId, slug, operation: 'put_page', timezone: 'UTC' });
    } finally { claimRace.mockRestore(); }
    expect(raced).toBeDefined();
    const successors = await engine.executeRaw<{ idempotency_key: string }>(
      "SELECT idempotency_key FROM minion_jobs WHERE name='autopilot-daily-memory' AND data->>'daily_memory_date'=$1 AND data->>'daily_memory_timezone'='UTC' AND status='waiting'", [day]);
    expect(successors).toEqual([{ idempotency_key: `autopilot-daily:${day}:UTC:pending:after:${raced}` }]);
    await queue.completeJob(raced!, 'admission-race-lock', {});
    // Settle fixtures so later tests cannot claim these generations.
    for (;;) {
      const job = await queue.claim('cleanup-generation-lock', 60_000, 'default', ['autopilot-daily-memory']);
      if (!job) break;
      await queue.completeJob(job.id, 'cleanup-generation-lock', {});
    }
  }
}, 120_000);

test('remote write receipts omit owner aggregate affected dates while accepting refresh jobs', async () => {
  for (const engine of engines) {
    const sourceId = `remote-days-${randomUUID()}`, slug = 'notes/remote', clientId = `remote-days-${randomUUID()}`;
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_name,client_secret_hash,scope,source_id,allowed_operations)
      VALUES($1,'Synthetic receipt client','fixture-hash','read write',$2,ARRAY['put_page'])`, [clientId, sourceId]);
    await ensureDailyMemorySource(engine);
    await engine.putPage('daily-memory/2026-01-01', { type: 'note', title: 'Synthetic hidden aggregate',
      compiled_truth: `[[${sourceId}:${slug}]]`, frontmatter: { dream_generated: true, visibility: 'private' } },
      { sourceId: DAILY_MEMORY_SOURCE_ID });
    const ctx: OperationContext = { ...context(engine, sourceId), remote: true,
      auth: { token: 'synthetic-token', clientId, principal: { kind: 'oauth_client', id: clientId }, scopes: ['read', 'write'],
        sourceId, allowedOperations: ['put_page'] } };
    const params = { slug, content: content('2026-03-02'), request_id: randomUUID() };
    const receipt = await submitPageMutation(ctx, { operation: 'put_page', params, waitMs: 30_000 });
    expect(receipt.state).toBe('committed');
    expect((receipt.outcome as Record<string, unknown>).daily_memory_affected_dates).toBeUndefined();
    expect(JSON.stringify(receipt)).not.toContain('daily_memory_affected_dates');
    expect(JSON.stringify(receipt)).not.toContain('2026-01-01');
    const replay = await submitPageMutation(ctx, { operation: 'put_page', params, waitMs: 30_000 });
    expect((replay.outcome as Record<string, unknown>).daily_memory_affected_dates).toBeUndefined();
    expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE name='autopilot-daily-memory' AND data->>'daily_memory_date'='2026-03-02'")).toHaveLength(1);
    expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE name='autopilot-daily-memory' AND data->>'daily_memory_date'='2026-01-01'")).toHaveLength(1);
    await disposePersistenceConsumer(engine);
  }
}, 120_000);
