import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { DAILY_MEMORY_SOURCE_ID } from '../src/core/cycle/daily-memory.ts';
import { runDailyMemoryJob } from '../src/core/cycle/daily-memory-followup.ts';
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
      if (name === 'autopilot-daily-memory' && data && 'daily_memory_dates' in data) throw new Error('Synthetic settlement rejection');
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
    const handoffs = await engine.executeRaw<{ data: Record<string, unknown> }>("SELECT data FROM minion_jobs WHERE name='autopilot-daily-memory' AND data ? 'daily_memory_dates'");
    expect(handoffs.some(row => Array.isArray(row.data.daily_memory_dates)
      && row.data.daily_memory_dates.includes('2026-09-23') && row.data.daily_memory_dates.includes('2026-09-24'))).toBe(true);
    await engine.putPage('notes/purged', { type: 'note', title: 'Purge fixture', compiled_truth: 'Synthetic fixture', frontmatter: { date: '2026-09-25' } }, { sourceId });
    await engine.executeRaw("UPDATE pages SET effective_date='2026-09-25'::date::timestamptz,effective_date_source='date' WHERE source_id=$1 AND slug='notes/purged'", [sourceId]);
    const doomed = (await engine.getPage('notes/purged', { sourceId }))!;
    await engine.createVersion('notes/purged', { sourceId });
    await submitPageMutation(ctx, { operation: 'delete_page', params: { slug: 'notes/purged', expected_revision: (await engine.readPageSnapshot('notes/purged', { sourceId }))!.revision, purge: true, request_id: randomUUID() }, waitMs: 30_000 });
    expect(await engine.getPage('notes/purged', { sourceId, includeDeleted: true })).toBeNull();
    expect(await engine.executeRaw('SELECT id FROM page_versions WHERE page_id=$1', [doomed.id])).toHaveLength(0);
    const purgedHandoffs = await engine.executeRaw<{ data: Record<string, unknown> }>("SELECT data FROM minion_jobs WHERE name='autopilot-daily-memory' AND data ? 'daily_memory_dates'");
    expect(purgedHandoffs.some(row => Array.isArray(row.data.daily_memory_dates)
      && row.data.daily_memory_dates.includes('2026-09-25'))).toBe(true);
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
    const handoffs = await engine.executeRaw<{ data: { daily_memory_dates?: string[] } }>("SELECT data FROM minion_jobs WHERE name='autopilot-daily-memory' AND id>$1", [Math.max(0, ...beforeJobs.map(row => Number(row.id)))]);
    expect(handoffs.some(row => row.data.daily_memory_dates?.includes('2026-09-26') && row.data.daily_memory_dates.includes('2026-09-27'))).toBe(true);
    await drainDaily(engine);
    expect(await dailyBody(engine, '2026-09-26')).toContain(`[[${sourceId}:${slug}]]`);
    expect(await dailyBody(engine, '2026-09-27')).not.toContain(`[[${sourceId}:${slug}]]`);
    const before = (await engine.readPageSnapshot(slug, { sourceId }))!;
    const jobs = await engine.executeRaw('SELECT id FROM minion_jobs ORDER BY id');
    const add = MinionQueue.prototype.add;
    const rejected = spyOn(MinionQueue.prototype, 'add').mockImplementation(async function(this: MinionQueue, name, data, opts) {
      if (name === 'autopilot-daily-memory' && data && 'daily_memory_dates' in data) throw new Error('Synthetic version refresh rejection');
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
    const handoffs = await engine.executeRaw<{ data: Record<string, unknown> }>(
      "SELECT data FROM minion_jobs WHERE name='autopilot-daily-memory' AND data ? 'daily_memory_dates'");
    expect(handoffs.some(row => Array.isArray(row.data.daily_memory_dates)
      && row.data.daily_memory_dates.includes('2026-09-20')
      && row.data.daily_memory_dates.includes('2026-09-21'))).toBe(true);
    await drainDaily(engine);
    expect(await dailyBody(engine, '2026-09-21')).not.toContain(link);
    expect(await dailyBody(engine, '2026-09-20')).toContain(link);
    await disposePersistenceConsumer(engine);
  }
}, 120_000);
