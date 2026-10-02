import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { softDeleteSource, restoreSource } from '../src/core/destructive-guard.ts';
import { removeSource } from '../src/core/sources-ops.ts';
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

  test('failed archive and restore handoffs roll back and retry with the transition', async () => {
    const sourceId = 'retry-refresh', day = '2026-09-30';
    await engine.executeRaw("INSERT INTO sources(id,name,archived) VALUES($1,'Retry fixture',false)", [sourceId]);
    await engine.putPage('notes/day', {
      type: 'note', title: 'Retry fixture', compiled_truth: 'Synthetic fixture', frontmatter: { date: day },
    }, { sourceId });
    await engine.executeRaw("UPDATE pages SET effective_date=$1::date::timestamptz,effective_date_source='date' WHERE source_id=$2", [day, sourceId]);
    {
      const rejected = spyOn(MinionQueue.prototype, 'add').mockRejectedValue(new Error('synthetic queue outage'));
      try { await expect(softDeleteSource(engine, sourceId)).rejects.toThrow('synthetic queue outage'); }
      finally { rejected.mockRestore(); }
      // Transition and handoff share one transaction: queue failure leaves the source active.
      expect(await engine.executeRaw<{ archived: boolean }>('SELECT archived FROM sources WHERE id=$1', [sourceId]))
        .toEqual([{ archived: false }]);
      expect(await softDeleteSource(engine, sourceId)).not.toBeNull();
    }
    {
      const rejected = spyOn(MinionQueue.prototype, 'add').mockRejectedValue(new Error('synthetic queue outage'));
      try { await expect(restoreSource(engine, sourceId)).rejects.toThrow('synthetic queue outage'); }
      finally { rejected.mockRestore(); }
      expect(await engine.executeRaw<{ archived: boolean }>('SELECT archived FROM sources WHERE id=$1', [sourceId]))
        .toEqual([{ archived: true }]);
      expect(await restoreSource(engine, sourceId)).toBe(true);
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

  test('page mutation refresh keeps the timezone captured with priorDays', async () => {
    const sourceId = 'page-mutation-tz', day = '2026-09-28', slug = 'notes/tz-day';
    await engine.setConfig('cycle.timezone', 'Asia/Manila');
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES($1,'Page mutation tz fixture')", [sourceId]);
    await engine.putPage(slug, {
      type: 'note', title: 'Fixture', compiled_truth: 'Body', frontmatter: { date: day },
    }, { sourceId });
    await engine.executeRaw("UPDATE pages SET effective_date=$1::date::timestamptz,effective_date_source='date' WHERE source_id=$2", [day, sourceId]);
    const days = await refreshDailyMemoryAfterPageMutation(engine, {
      sourceId, slug, operation: 'put_page', requestId: '33333333-3333-4333-8333-333333333333',
      priorDays: ['2026-09-27'], timezone: 'UTC',
    });
    expect(days).toEqual(expect.arrayContaining(['2026-09-27', day]));
    const jobs = await engine.executeRaw<{ data: Record<string, unknown> }>(
      "SELECT data FROM minion_jobs WHERE name='autopilot-daily-memory'",
    );
    expect(jobs.some(j => j.data.daily_memory_timezone === 'UTC' && (
      j.data.daily_memory_date === '2026-09-27' || (Array.isArray(j.data.daily_memory_dates) && j.data.daily_memory_dates.includes('2026-09-27'))
    ))).toBe(true);
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
    const daily = await engine.getPage(dailyMemorySlug(day), { sourceId: DAILY_MEMORY_SOURCE_ID });
    // Empty days may delete the daily page; either way the removed source link must be gone.
    expect(daily == null || !daily.compiled_truth.includes(`[[${sourceId}:notes/day]]`)).toBe(true);
  });

  test('CLI removal refuses reserved indexes without an undefined constant reference', async () => {
    const exit = spyOn(process, 'exit').mockImplementation(code => { throw new Error(`fixture exit ${code}`); });
    try { await expect(runSources(engine, ['remove', 'dream', '--confirm-destructive'])).rejects.toThrow('fixture exit 3'); }
    finally { exit.mockRestore(); }
    expect(await engine.executeRaw("SELECT id FROM sources WHERE id='dream'")).toHaveLength(1);
  });

  test('CLI removal allows ordinary conflicting dream source without system-index ownership', async () => {
    await engine.executeRaw("DELETE FROM sources WHERE id='dream'");
    await engine.executeRaw(
      "INSERT INTO sources(id,name,config) VALUES('dream','Ordinary conflicting dream','{}'::jsonb)",
    );
    await runSources(engine, ['remove', 'dream', '--confirm-destructive']);
    expect(await engine.executeRaw("SELECT id FROM sources WHERE id='dream'")).toHaveLength(0);
    await ensureDailyMemorySource(engine);
    const owned = await engine.executeRaw<{ system_index: boolean | null }>(
      `SELECT (config->>'system_index')::boolean AS system_index FROM sources WHERE id='dream'`,
    );
    expect(owned[0]?.system_index).toBe(true);
  });

  test('removeSource ops path refuses system-index sources', async () => {
    await engine.executeRaw(
      "INSERT INTO sources(id,name,config) VALUES('sys-ops','System fixture',$1::jsonb)",
      [JSON.stringify({ system_index: true })],
    );
    await expect(removeSource(engine, { id: 'sys-ops', confirmDestructive: true })).rejects.toThrow(/system index/);
    expect(await engine.executeRaw("SELECT id FROM sources WHERE id='sys-ops'")).toHaveLength(1);
  });

  test('removeSource ops path enqueues affected daily-memory days before delete commits', async () => {
    const sourceId = 'ops-remove-refresh', day = '2026-09-30';
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES($1,'Ops remove fixture')", [sourceId]);
    await engine.putPage('notes/day', {
      type: 'note', title: 'Fixture', compiled_truth: 'Synthetic', frontmatter: { date: day },
    }, { sourceId });
    await engine.executeRaw(
      "UPDATE pages SET effective_date=$1::date::timestamptz,effective_date_source='date' WHERE source_id=$2",
      [day, sourceId],
    );
    await writeDailyMemoryFromSources(engine, { date: day });
    await removeSource(engine, { id: sourceId, confirmDestructive: true });
    expect(await engine.executeRaw('SELECT id FROM sources WHERE id=$1', [sourceId])).toHaveLength(0);
    const jobs = await engine.executeRaw<{ data: Record<string, unknown> }>(
      "SELECT data FROM minion_jobs WHERE name='autopilot-daily-memory'",
    );
    expect(jobs.some(j => j.data.daily_memory_date === day)).toBe(true);
  });


  test('direct sources purge refuses system-index sources', async () => {
    await engine.executeRaw(
      "INSERT INTO sources(id,name,archived,config) VALUES('sys-purge','System purge fixture',true,$1::jsonb)",
      [JSON.stringify({ system_index: true })],
    );
    const exit = spyOn(process, 'exit').mockImplementation(code => { throw new Error(`fixture exit ${code}`); });
    try {
      await expect(runSources(engine, ['purge', 'sys-purge', '--confirm-destructive'])).rejects.toThrow('fixture exit 3');
    } finally {
      exit.mockRestore();
    }
    expect(await engine.executeRaw("SELECT id FROM sources WHERE id='sys-purge'")).toHaveLength(1);
  });

  test('standalone import queues affected daily-memory days for imported slugs', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('fs');
    const { join } = await import('path');
    const { tmpdir } = await import('os');
    const { runImport } = await import('../src/commands/import.ts');
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-import-dm-'));
    try {
      await engine.executeRaw("INSERT INTO sources(id,name) VALUES('import-dm','Import daily fixture')");
      writeFileSync(join(dir, 'day.md'), [
        '---',
        'title: Imported day',
        'date: 2026-09-25',
        '---',
        '',
        'Body from standalone import.',
        '',
      ].join('\n'));
      await runImport(engine, [dir, '--no-embed'], { sourceId: 'import-dm', noExtract: true });
      const jobs = await engine.executeRaw<{ data: Record<string, unknown> }>(
        "SELECT data FROM minion_jobs WHERE name='autopilot-daily-memory'",
      );
      expect(jobs.some(j => j.data.daily_memory_date === '2026-09-25')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });


  test('force-purge queues affected daily-memory days before delete', async () => {
    const sourceId = 'purge-refresh', day = '2026-09-24';
    await engine.executeRaw("INSERT INTO sources(id,name,archived) VALUES($1,'Purge refresh fixture',false)", [sourceId]);
    await engine.putPage('notes/day', {
      type: 'note', title: 'Fixture', compiled_truth: 'Synthetic', frontmatter: { date: day },
    }, { sourceId });
    await engine.executeRaw(
      "UPDATE pages SET effective_date=$1::date::timestamptz,effective_date_source='date' WHERE source_id=$2",
      [day, sourceId],
    );
    await writeDailyMemoryFromSources(engine, { date: day });
    const original = MinionQueue.prototype.add;
    let calls = 0;
    const add = spyOn(MinionQueue.prototype, 'add').mockImplementation(async function(this: MinionQueue, ...args: Parameters<MinionQueue['add']>) {
      if (++calls === 2) throw new Error('synthetic purge settlement outage');
      return original.call(this, ...args);
    });
    try { await expect(runSources(engine, ['purge', sourceId, '--confirm-destructive'])).rejects.toThrow('synthetic purge settlement outage'); }
    finally { add.mockRestore(); }
    expect(await engine.executeRaw('SELECT id FROM sources WHERE id=$1', [sourceId])).toHaveLength(1);
    expect(await engine.getPage('notes/day', { sourceId })).not.toBeNull();
    expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE name='autopilot-daily-memory'")).toHaveLength(0);
    await runSources(engine, ['purge', sourceId, '--confirm-destructive']);
    expect(await engine.executeRaw('SELECT id FROM sources WHERE id=$1', [sourceId])).toHaveLength(0);
    const jobs = await engine.executeRaw<{ data: Record<string, unknown> }>(
      "SELECT data FROM minion_jobs WHERE name='autopilot-daily-memory'",
    );
    expect(jobs.some(j => j.data.daily_memory_date === day)).toBe(true);
  });

  test('force-purge protects a custom system index source before queue or deletion', async () => {
    const sourceId = 'custom-owned-index';
    await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES($1,'Synthetic index','{\"system_index\":true}'::jsonb)", [sourceId]);
    const exit = spyOn(process, 'exit').mockImplementation(code => { throw new Error(`fixture exit ${code}`); });
    try { await expect(runSources(engine, ['purge', sourceId, '--confirm-destructive'])).rejects.toThrow('fixture exit 3'); }
    finally { exit.mockRestore(); }
    expect(await engine.executeRaw('SELECT id FROM sources WHERE id=$1', [sourceId])).toHaveLength(1);
    expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE name='autopilot-daily-memory'")).toHaveLength(0);
  });

  test('standalone import retries daily-memory handoff from checkpoint after enqueue failure', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('fs');
    const { join } = await import('path');
    const { tmpdir } = await import('os');
    const { runImport } = await import('../src/commands/import.ts');
    const { MinionQueue } = await import('../src/core/minions/queue.ts');
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-import-dm-retry-'));
    try {
      await engine.executeRaw("INSERT INTO sources(id,name) VALUES('import-dm-retry','Import retry fixture')");
      writeFileSync(join(dir, 'day.md'), [
        '---', 'title: Imported day', 'date: 2026-09-23', '---', '', 'Body.', '',
      ].join('\n'));
      const original = MinionQueue.prototype.add;
      let calls = 0;
      const add = spyOn(MinionQueue.prototype, 'add').mockImplementation(async function(this: MinionQueue, ...args: Parameters<MinionQueue['add']>) {
        if (++calls === 2) throw new Error('synthetic import refresh outage');
        return original.call(this, ...args);
      });
      try {
        const first = await runImport(engine, [dir, '--no-embed'], { sourceId: 'import-dm-retry', noExtract: true });
        expect(first.errors).toBeGreaterThan(0);
      } finally {
        add.mockRestore();
      }
      // Retry with no new imports (content hash skip); checkpoint must still enqueue the day.
      await runImport(engine, [dir, '--no-embed'], { sourceId: 'import-dm-retry', noExtract: true });
      const jobs = await engine.executeRaw<{ data: Record<string, unknown> }>(
        "SELECT data FROM minion_jobs WHERE name='autopilot-daily-memory'",
      );
      expect(jobs.some(j => j.data.daily_memory_date === '2026-09-23')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });


  test('expiry purge queues affected daily-memory days before delete', async () => {
    const { purgeExpiredSources } = await import('../src/core/destructive-guard.ts');
    const sourceId = 'expiry-purge-refresh', day = '2026-09-22';
    await engine.executeRaw(
      "INSERT INTO sources(id,name,archived,archived_at,archive_expires_at) VALUES($1,'Expiry purge fixture',true,now(),now()-interval '1 hour')",
      [sourceId],
    );
    await engine.putPage('notes/day', {
      type: 'note', title: 'Fixture', compiled_truth: 'Synthetic', frontmatter: { date: day },
    }, { sourceId });
    await engine.executeRaw(
      "UPDATE pages SET effective_date=$1::date::timestamptz,effective_date_source='date' WHERE source_id=$2",
      [day, sourceId],
    );
    await writeDailyMemoryFromSources(engine, { date: day });
    const result = await purgeExpiredSources(engine);
    expect(result.purged).toContain(sourceId);
    const jobs = await engine.executeRaw<{ data: Record<string, unknown> }>(
      "SELECT data FROM minion_jobs WHERE name='autopilot-daily-memory'",
    );
    expect(jobs.some(j => j.data.daily_memory_date === day)).toBe(true);
  });

});
