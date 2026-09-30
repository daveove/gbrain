/** Standalone sync preserves affected dates across a rejected queue handoff. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
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
});
