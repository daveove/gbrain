import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { softDeleteSource, restoreSource } from '../src/core/destructive-guard.ts';
import { DAILY_MEMORY_SOURCE_ID, dailyMemorySlug, ensureDailyMemorySource, writeDailyMemoryFromSources } from '../src/core/cycle/daily-memory.ts';
import { refreshDailyMemoryAfterPageMutation, runDailyMemoryJob } from '../src/core/cycle/daily-memory-followup.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { runSources } from '../src/commands/sources.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

describe('daily memory refresh on source archive/restore', () => {
  let engine: PGLiteEngine;
  let schemaVersion: string | null;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    schemaVersion = await engine.getConfig('version');
  }, 30000);
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => {
    await resetPgliteState(engine);
    if (schemaVersion) await engine.setConfig('version', schemaVersion);
    await ensureDailyMemorySource(engine);
  });

  test('archiving a source queues its affected daily memory days', async () => {
    await engine.executeRaw("INSERT INTO sources(id,name,archived) VALUES('archive-refresh','Archive refresh',false)");
    await engine.putPage('notes/day', {
      type: 'note', title: 'Day', compiled_truth: 'Body',
      frontmatter: { date: '2026-09-30' },
    }, { sourceId: 'archive-refresh' });
    await engine.executeRaw(
      "UPDATE pages SET effective_date='2026-09-30T00:00:00Z'::timestamptz, effective_date_source='date' WHERE source_id='archive-refresh'",
    );
    const written = await writeDailyMemoryFromSources(engine, { date: '2026-09-30' });
    expect(written.written).toBe(true);
    expect(await softDeleteSource(engine, 'archive-refresh')).not.toBeNull();
    const jobs = await engine.executeRaw<{ data: Record<string, unknown> }>(
      "SELECT data FROM minion_jobs WHERE name='autopilot-daily-memory' ORDER BY id",
    );
    expect(jobs.some(j => j.data.daily_memory_date === '2026-09-30')).toBe(true);
  });

  test('restore admits a fresh refresh after the archive refresh has completed', async () => {
    const sourceId = 'archive-restore-refresh', day = '2026-09-30';
    await engine.executeRaw("INSERT INTO sources(id,name,archived) VALUES($1,'Lifecycle fixture',false)", [sourceId]);
    await engine.putPage('notes/day', {
      type: 'note', title: 'Lifecycle fixture', compiled_truth: 'Synthetic fixture', frontmatter: { date: day },
    }, { sourceId });
    await engine.executeRaw("UPDATE pages SET effective_date=$1::date::timestamptz,effective_date_source='date' WHERE source_id=$2", [day, sourceId]);
    await writeDailyMemoryFromSources(engine, { date: day });
    const link = `[[${sourceId}:notes/day]]`, queue = new MinionQueue(engine);
    expect((await engine.getPage(dailyMemorySlug(day), { sourceId: DAILY_MEMORY_SOURCE_ID }))!.compiled_truth).toContain(link);
    await softDeleteSource(engine, sourceId);
    const archive = (await queue.claim('archive-refresh-lock', 60_000, 'default', ['autopilot-daily-memory']))!;
    expect(archive).not.toBeNull();
    await queue.completeJob(archive.id, 'archive-refresh-lock', await runDailyMemoryJob(engine, archive));
    expect((await engine.getPage(dailyMemorySlug(day), { sourceId: DAILY_MEMORY_SOURCE_ID }))!.compiled_truth).not.toContain(link);
    const archiveWatcher = (await queue.claim('archive-watcher-lock', 60_000, 'default', ['autopilot-daily-memory']))!;
    const archiveDone = await runDailyMemoryJob(engine, archiveWatcher);
    if (!('daily_memory_pending' in archiveDone)) throw new Error('Expected settlement result');
    expect(archiveDone.daily_memory_pending).toBe(false);
    await queue.completeJob(archiveWatcher.id, 'archive-watcher-lock', archiveDone);
    expect(await restoreSource(engine, sourceId)).toBe(true);
    const restored = (await queue.claim('restore-refresh-lock', 60_000, 'default', ['autopilot-daily-memory']))!;
    expect(restored).not.toBeNull();
    expect(restored.id).not.toBe(archive.id);
    await queue.completeJob(restored.id, 'restore-refresh-lock', await runDailyMemoryJob(engine, restored));
    expect((await engine.getPage(dailyMemorySlug(day), { sourceId: DAILY_MEMORY_SOURCE_ID }))!.compiled_truth).toContain(link);
    const restoreWatcher = (await queue.claim('restore-watcher-lock', 60_000, 'default', ['autopilot-daily-memory']))!;
    const restoreDone = await runDailyMemoryJob(engine, restoreWatcher);
    if (!('daily_memory_pending' in restoreDone)) throw new Error('Expected settlement result');
    expect(restoreDone.daily_memory_pending).toBe(false);
    await queue.completeJob(restoreWatcher.id, 'restore-watcher-lock', restoreDone);
    expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE name='autopilot-daily-memory' AND status='completed'")).toHaveLength(4);
  });

  test('failed archive and restore handoffs surface and retry after the state change', async () => {
    const sourceId = 'retry-refresh', day = '2026-09-30';
    await engine.executeRaw("INSERT INTO sources(id,name,archived) VALUES($1,'Retry fixture',false)", [sourceId]);
    await engine.putPage('notes/day', {
      type: 'note', title: 'Retry fixture', compiled_truth: 'Synthetic fixture', frontmatter: { date: day },
    }, { sourceId });
    await engine.executeRaw("UPDATE pages SET effective_date=$1::date::timestamptz,effective_date_source='date' WHERE source_id=$2", [day, sourceId]);
    for (const operation of [softDeleteSource, restoreSource]) {
      const rejected = spyOn(MinionQueue.prototype, 'add').mockRejectedValue(new Error('synthetic queue outage'));
      try { await expect(operation(engine, sourceId)).rejects.toThrow('synthetic queue outage'); }
      finally { rejected.mockRestore(); }
      // The state change committed, but its no-op retry must still enqueue the refresh.
      expect(await operation(engine, sourceId)).toBe(operation === softDeleteSource ? null : false);
    }
    expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE name='autopilot-daily-memory' AND status='waiting'")).toHaveLength(4);
  });

  test('archive settlement replaces a dead day child and waits for real link cleanup', async () => {
    const sourceId = 'archive-replay', day = '2026-09-30';
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES($1,'Archive replay fixture')", [sourceId]);
    await engine.putPage('notes/day', { type: 'note', title: 'Fixture', compiled_truth: '', frontmatter: { date: day } }, { sourceId });
    await engine.executeRaw("UPDATE pages SET effective_date=$1::date::timestamptz,effective_date_source='date' WHERE source_id=$2", [day, sourceId]);
    await writeDailyMemoryFromSources(engine, { date: day });
    const queue = new MinionQueue(engine), link = `[[${sourceId}:notes/day]]`;
    await softDeleteSource(engine, sourceId);
    const child = (await queue.claim('archive-dead-lock', 60_000, 'default', ['autopilot-daily-memory']))!;
    await queue.failJob(child.id, 'archive-dead-lock', 'Synthetic archive child failure', 'dead');
    const watcher = (await queue.claim('archive-watch-lock', 60_000, 'default', ['autopilot-daily-memory']))!;
    const replay = await runDailyMemoryJob(engine, watcher);
    if (!('daily_memory_replayed' in replay)) throw new Error('Expected settlement result');
    expect(replay.daily_memory_replayed).toBe(1);
    await queue.completeJob(watcher.id, 'archive-watch-lock', replay);
    expect((await engine.getPage(dailyMemorySlug(day), { sourceId: DAILY_MEMORY_SOURCE_ID }))!.compiled_truth).toContain(link);
    const replacement = (await queue.claim('archive-replace-lock', 60_000, 'default', ['autopilot-daily-memory']))!;
    expect(replacement.id).not.toBe(child.id);
    await queue.completeJob(replacement.id, 'archive-replace-lock', await runDailyMemoryJob(engine, replacement));
    await engine.executeRaw("UPDATE minion_jobs SET delay_until=now()-interval '1 second' WHERE status='delayed'");
    await queue.promoteDelayed();
    const poll = (await queue.claim('archive-poll-lock', 60_000, 'default', ['autopilot-daily-memory']))!;
    const done = await runDailyMemoryJob(engine, poll);
    if (!('daily_memory_pending' in done)) throw new Error('Expected settlement result');
    expect(done.daily_memory_pending).toBe(false);
    await queue.completeJob(poll.id, 'archive-poll-lock', done);
    expect((await engine.getPage(dailyMemorySlug(day), { sourceId: DAILY_MEMORY_SOURCE_ID }))!.compiled_truth).not.toContain(link);
  });

  test('restoring a source queues its affected daily memory days', async () => {
    await engine.executeRaw("INSERT INTO sources(id,name,archived) VALUES('restore-refresh','Restore refresh',true)");
    await engine.putPage('notes/day', {
      type: 'note', title: 'Day', compiled_truth: 'Body',
      frontmatter: { date: '2026-09-29' },
    }, { sourceId: 'restore-refresh' });
    await engine.executeRaw(
      "UPDATE pages SET effective_date='2026-09-29T00:00:00Z'::timestamptz, effective_date_source='date' WHERE source_id='restore-refresh'",
    );
    await engine.putPage(dailyMemorySlug('2026-09-29'), {
      type: 'note',
      title: 'Daily memory 2026-09-29',
      compiled_truth: '[[restore-refresh:notes/day]] — Day\n',
      frontmatter: { dream_generated: true },
    }, { sourceId: DAILY_MEMORY_SOURCE_ID });
    expect(await restoreSource(engine, 'restore-refresh')).toBe(true);
    const jobs = await engine.executeRaw<{ data: Record<string, unknown> }>(
      "SELECT data FROM minion_jobs WHERE name='autopilot-daily-memory'",
    );
    expect(jobs.some(j => j.data.daily_memory_date === '2026-09-29')).toBe(true);
  });

  test('refuses to remove the owned dream source via system-index guard', async () => {
    const { assertSourceNotSystemIndex } = await import('../src/core/destructive-guard.ts');
    await expect(assertSourceNotSystemIndex(engine, DAILY_MEMORY_SOURCE_ID)).rejects.toThrow(/system index/);
  });

  test('page mutation refresh queues affected days and surfaces queue failures', async () => {
    const sourceId = 'page-mutation-refresh', day = '2026-09-28', slug = 'notes/day';
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES($1,'Page mutation fixture')", [sourceId]);
    await engine.putPage(slug, {
      type: 'note', title: 'Fixture', compiled_truth: 'Body', frontmatter: { date: day },
    }, { sourceId });
    await engine.executeRaw("UPDATE pages SET effective_date=$1::date::timestamptz,effective_date_source='date' WHERE source_id=$2", [day, sourceId]);
    const days = await refreshDailyMemoryAfterPageMutation(engine, {
      sourceId, slug, operation: 'put_page', requestId: '11111111-1111-4111-8111-111111111111',
    });
    expect(days).toContain(day);
    const jobs = await engine.executeRaw<{ data: Record<string, unknown> }>(
      "SELECT data FROM minion_jobs WHERE name='autopilot-daily-memory'",
    );
    expect(jobs.some(j => j.data.daily_memory_date === day)).toBe(true);
    const rejected = spyOn(MinionQueue.prototype, 'add').mockRejectedValue(new Error('synthetic page refresh outage'));
    try {
      await expect(refreshDailyMemoryAfterPageMutation(engine, {
        sourceId, slug, operation: 'delete_page', requestId: '22222222-2222-4222-8222-222222222222',
      })).rejects.toThrow('synthetic page refresh outage');
    } finally {
      rejected.mockRestore();
    }
  });

  test('CLI removal rolls back its accepted first child when the settlement handoff fails', async () => {
    const sourceId = 'remove-atomic', day = '2026-09-30';
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES($1,'Remove fixture')", [sourceId]);
    await engine.putPage('notes/day', { type: 'note', title: 'Fixture', compiled_truth: 'Synthetic', frontmatter: { date: day } }, { sourceId });
    await writeDailyMemoryFromSources(engine, { date: day });
    const original = MinionQueue.prototype.add;
    let calls = 0;
    const add = spyOn(MinionQueue.prototype, 'add').mockImplementation(async function(this: MinionQueue, ...args: Parameters<MinionQueue['add']>) {
      const tx = (this as unknown as { engine: BrainEngine }).engine;
      expect(tx).not.toBe(engine);
      expect(await tx.executeRaw('SELECT id FROM sources WHERE id=$1', [sourceId])).toHaveLength(1);
      if (++calls === 2) throw new Error('synthetic settlement outage');
      return original.call(this, ...args);
    });
    try { await expect(runSources(engine, ['remove', sourceId, '--confirm-destructive'])).rejects.toThrow('synthetic settlement outage'); }
    finally { add.mockRestore(); }
    expect(calls).toBe(2);
    expect(await engine.executeRaw('SELECT id FROM sources WHERE id=$1', [sourceId])).toHaveLength(1);
    expect(await engine.getPage('notes/day', { sourceId })).not.toBeNull();
    expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE name='autopilot-daily-memory'")).toHaveLength(0);
    await runSources(engine, ['remove', sourceId, '--confirm-destructive']);
    expect(await engine.executeRaw('SELECT id FROM sources WHERE id=$1', [sourceId])).toHaveLength(0);
    const queue = new MinionQueue(engine);
    const child = await queue.claim('removed-source-lock', 60_000, 'default', ['autopilot-daily-memory']);
    if (!child) throw new Error('Expected accepted removal refresh');
    await queue.completeJob(child.id, 'removed-source-lock', await runDailyMemoryJob(engine, child));
    expect((await engine.getPage(dailyMemorySlug(day), { sourceId: DAILY_MEMORY_SOURCE_ID }))!.compiled_truth).not.toContain(`[[${sourceId}:notes/day]]`);
  });

  test('CLI removal refuses reserved indexes without an undefined constant reference', async () => {
    const exit = spyOn(process, 'exit').mockImplementation(code => { throw new Error(`fixture exit ${code}`); });
    try { await expect(runSources(engine, ['remove', 'dream', '--confirm-destructive'])).rejects.toThrow('fixture exit 3'); }
    finally { exit.mockRestore(); }
    expect(await engine.executeRaw("SELECT id FROM sources WHERE id='dream'")).toHaveLength(1);
  });

});
