/** Standalone sync preserves affected dates across a rejected queue handoff. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dailyMemoryDaysForSlugs, queueStandaloneSyncDailyMemory } from '../src/core/cycle/daily-memory-followup.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { performSync } from '../src/commands/sync.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
let repo: string;
let version: string | null;
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString().trim();
const write = (file: string, day: string) => writeFileSync(join(repo, file), `---\ntitle: Fixture\ndate: ${day}\n---\nFixture body.\n`);
const anchor = async () => (await engine.executeRaw<{ last_commit: string }>("SELECT last_commit FROM sources WHERE id='default'"))[0]?.last_commit;
const opts = () => ({ repoPath: repo, sourceId: 'default', noPull: true, noEmbed: true, noExtract: true, dailyMemoryFollowup: true });

describe('standalone sync daily-memory durable handoff', () => {
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    version = await engine.getConfig('version');
  });
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => {
    await resetPgliteState(engine);
    if (version) await engine.setConfig('version', version);
    repo = mkdtempSync(join(tmpdir(), 'gbrain-sync-days-'));
    git('init'); git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'user.name', 'Fixture'); git('config', 'commit.gpgsign', 'false');
    mkdirSync(join(repo, 'notes'));
    write('notes/old.md', '2026-01-03'); write('notes/remove.md', '2026-01-04');
    git('add', '-A'); git('commit', '-m', 'seed');
    await performSync(engine, { ...opts(), full: true, dailyMemoryFollowup: false });
  });
  afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

  for (const full of [false, true]) {
    test(`${full ? 'full reconciliation' : 'incremental rename'} retries old and new days before consuming anchor`, async () => {
      const seed = git('rev-parse', 'HEAD');
      renameSync(join(repo, 'notes/old.md'), join(repo, 'notes/new.md'));
      write('notes/new.md', '2026-01-05');
      rmSync(join(repo, 'notes/remove.md'));
      git('add', '-A'); git('commit', '-m', 'rename date and remove');
      const target = git('rev-parse', 'HEAD');
      const failure = spyOn(MinionQueue.prototype, 'add').mockRejectedValueOnce(new Error('fixture queue unavailable'));
      try {
        await expect(performSync(engine, { ...opts(), full })).rejects.toThrow('fixture queue unavailable');
      } finally { failure.mockRestore(); }
      expect(await anchor()).toBe(seed);
      const removed = await engine.executeRaw<{ deleted_at: string | null }>(
        "SELECT deleted_at FROM pages WHERE source_id='default' AND slug='notes/remove'");
      expect(removed[0]?.deleted_at).not.toBeNull();
      expect(removed).toHaveLength(1);
      const saved = await engine.executeRaw<{ path: string }>(
        "SELECT path FROM op_checkpoint_paths WHERE op='sync-daily-memory'");
      expect(saved.map(row => row.path)).toContain('day:2026-01-03');
      expect(saved.map(row => row.path)).toContain('day:2026-01-04');
      // Retry may hash-skip imported pages and skip banked deletion paths.
      await performSync(engine, { ...opts(), full });
      expect(await anchor()).toBe(target);
      const batches = await engine.executeRaw<{ data: { daily_memory_dates?: string[] } }>(
        "SELECT data FROM minion_jobs WHERE name='autopilot-daily-memory'");
      expect(batches.some(row => ['2026-01-03', '2026-01-04', '2026-01-05']
        .every(day => row.data.daily_memory_dates?.includes(day)))).toBe(true);
      expect(await engine.executeRaw("SELECT path FROM op_checkpoint_paths WHERE op='sync-daily-memory'")).toHaveLength(0);
    });
  }
  test('queued-cycle full sync reports imported and retired dates without duplicate standalone jobs', async () => {
    renameSync(join(repo, 'notes/old.md'), join(repo, 'notes/new.md'));
    write('notes/new.md', '2026-01-05');
    rmSync(join(repo, 'notes/remove.md'));
    git('add', '-A'); git('commit', '-m', 'full cycle changes');
    const result = await performSync(engine, { ...opts(), full: true, dailyMemoryFollowup: false });
    expect(result.pagesAffected).toEqual(expect.arrayContaining(['notes/old', 'notes/new', 'notes/remove']));
    expect(await engine.executeRaw('SELECT id FROM minion_jobs')).toHaveLength(0);
    const days = await dailyMemoryDaysForSlugs(engine, 'default', result.pagesAffected);
    expect(days).toEqual(expect.arrayContaining(['2026-01-03', '2026-01-04', '2026-01-05']));
    await queueStandaloneSyncDailyMemory(engine, { sourceId: 'default', commit: result.toCommit!, days });
    const batches = await engine.executeRaw<{ data: { daily_memory_dates?: string[] } }>(
      "SELECT data FROM minion_jobs WHERE name='autopilot-daily-memory'");
    expect(batches.some(row => days.every(day => row.data.daily_memory_dates?.includes(day)))).toBe(true);
  });

  test('a second working-tree edit at the same HEAD receives fresh maintenance after completed jobs', async () => {
    const head = git('rev-parse', 'HEAD');
    write('notes/old.md', '2026-01-05');
    await performSync(engine, { ...opts(), workingTree: true });
    const queue = new MinionQueue(engine);
    const completed: number[] = [];
    for (let i = 0; i < 10; i++) {
      const token = `fixture-daily-${i}`;
      const job = await queue.claim(token, 60_000, 'default', ['autopilot-daily-memory']);
      if (!job) break;
      expect(await queue.completeJob(job.id, token, {})).not.toBeNull();
      completed.push(job.id);
    }
    expect(completed.length).toBeGreaterThan(0);
    write('notes/old.md', '2026-01-06');
    await performSync(engine, { ...opts(), workingTree: true });
    expect(git('rev-parse', 'HEAD')).toBe(head);
    const fresh = await engine.executeRaw<{ id: number; status: string; data: { daily_memory_dates?: string[] } }>(
      "SELECT id,status,data FROM minion_jobs WHERE name='autopilot-daily-memory'");
    expect(fresh.some(row => !completed.includes(row.id) && ['waiting', 'delayed'].includes(row.status)
      && row.data.daily_memory_dates?.includes('2026-01-06'))).toBe(true);
  });

});
