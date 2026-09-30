import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { softDeleteSource, restoreSource } from '../src/core/destructive-guard.ts';
import { DAILY_MEMORY_SOURCE_ID, dailyMemorySlug, ensureDailyMemorySource, writeDailyMemoryFromSources } from '../src/core/cycle/daily-memory.ts';
import { runDailyMemoryJob } from '../src/core/cycle/daily-memory-followup.ts';
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
    expect(await restoreSource(engine, sourceId)).toBe(true);
    const restored = (await queue.claim('restore-refresh-lock', 60_000, 'default', ['autopilot-daily-memory']))!;
    expect(restored).not.toBeNull();
    expect(restored.id).not.toBe(archive.id);
    await queue.completeJob(restored.id, 'restore-refresh-lock', await runDailyMemoryJob(engine, restored));
    expect((await engine.getPage(dailyMemorySlug(day), { sourceId: DAILY_MEMORY_SOURCE_ID }))!.compiled_truth).toContain(link);
    expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE name='autopilot-daily-memory' AND status='completed'")).toHaveLength(2);
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
});
