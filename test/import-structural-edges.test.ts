/**
 * Import writes pages and used to stop there. A markdown link between two
 * pages already in the brain never became a `links` row, because the stale
 * extract sweep was not run. This pins that the sweep runs and the edge
 * exists.
 */
import { describe, test, expect, beforeAll, afterAll, spyOn } from 'bun:test';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { ImportAbortError, runImport } from '../src/commands/import.ts';
import { INLINE_EXTRACT_CHANGE_LIMIT } from '../src/core/deferred-stale-extract.ts';
import { loadPendingLinkReferences } from '../src/core/pending-link-references.ts';
import { withEnv } from './helpers/with-env.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';

describe('import structural edges', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => {
    if (engine) await engine.disconnect();
  }, 60_000);

  test('a markdown link in the fixture becomes a links-table edge', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-import-edges-'));
    writeFileSync(
      join(dir, 'alpha.md'),
      '---\ntype: concept\n---\n# Alpha\n\nSee [Beta](beta.md).\n',
    );
    writeFileSync(
      join(dir, 'beta.md'),
      '---\ntype: concept\n---\n# Beta\n\nTarget page.\n',
    );
    writeFileSync(
      join(dir, 'gamma.md'),
      '---\ntype: concept\n---\n# Gamma\n\nSee [Delta](delta.md#section).\n',
    );
    writeFileSync(
      join(dir, 'delta.md'),
      '---\ntype: concept\n---\n# Delta\n\n## section\n\nTarget page.\n',
    );
    const gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-home-'));

    await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
      const result = await runImport(engine, [dir, '--no-embed', '--json']);
      expect(result.imported).toBe(4);
      expect(result.errors).toBe(0);
      expect(result.linkExtractionError).toBeUndefined();

      const rows = await engine.executeRaw<{ from_slug: string; to_slug: string }>(
        `SELECT pf.slug AS from_slug, pt.slug AS to_slug
         FROM links l
         JOIN pages pf ON pf.id = l.from_page_id
         JOIN pages pt ON pt.id = l.to_page_id
         WHERE pf.deleted_at IS NULL AND pt.deleted_at IS NULL
         ORDER BY pf.slug`,
      );
      expect(rows).toEqual([
        { from_slug: 'alpha', to_slug: 'beta' },
        { from_slug: 'gamma', to_slug: 'delta' },
      ]);
    });
  }, 60_000);

  test('small directory import honors configured frontmatter extraction', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-import-configured-frontmatter-'));
    writeFileSync(join(dir, 'fm-origin.md'), '---\ntype: concept\nrelated: [fm-target]\n---\nOrigin without body links.');
    writeFileSync(join(dir, 'fm-target.md'), '---\ntype: concept\n---\nTarget without body links.');
    const gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-home-'));
    const key = 'autopilot.incremental_extract_include_frontmatter';
    const previous = await engine.getConfig(key);
    await engine.setConfig(key, 'true');
    try {
      await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
        const result = await runImport(engine, [dir, '--no-embed', '--json']);
        expect(result.errors).toBe(0);
        expect((await engine.getLinks('fm-origin')).some(link => link.to_slug === 'fm-target' && link.link_source === 'frontmatter')).toBe(true);
        expect(await engine.countStalePagesForExtraction()).toBe(0);
      });
    } finally {
      if (previous == null) await engine.executeRaw('DELETE FROM config WHERE key=$1', [key]);
      else await engine.setConfig(key, previous);
    }
  }, 60_000);

  test('importing the target later still creates the edge', async () => {
    const sourceDir = mkdtempSync(join(tmpdir(), 'gbrain-import-pending-'));
    writeFileSync(
      join(sourceDir, 'pending.md'),
      '---\ntype: concept\n---\n# Pending\n\nSee [Later](later.md).\n',
    );
    const targetDir = mkdtempSync(join(tmpdir(), 'gbrain-import-later-'));
    writeFileSync(
      join(targetDir, 'later.md'),
      '---\ntype: concept\n---\n# Later\n\nTarget page.\n',
    );
    const gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-home-'));

    await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
      await runImport(engine, [sourceDir, '--no-embed', '--json']);
      const before = await engine.executeRaw<{ slug: string; links_extracted_at: string | null }>(
        `SELECT slug, links_extracted_at::text AS links_extracted_at
         FROM pages WHERE slug = 'pending' AND deleted_at IS NULL`,
      );
      expect(before).toEqual([{ slug: 'pending', links_extracted_at: expect.any(String) }]);
      expect(await engine.countStalePagesForExtraction()).toBe(0);
      expect((await loadPendingLinkReferences(engine)).filter(row => row.reference.slug === 'pending'))
        .toEqual([expect.objectContaining({ reference: expect.objectContaining({
          slug: 'pending', sourceId: 'default',
          candidates: [expect.objectContaining({ targetSlug: 'later' })],
        }) })]);

      await runImport(engine, [targetDir, '--no-embed', '--json']);
      const rows = await engine.executeRaw<{ from_slug: string; to_slug: string }>(
        `SELECT pf.slug AS from_slug, pt.slug AS to_slug
         FROM links l
         JOIN pages pf ON pf.id = l.from_page_id
         JOIN pages pt ON pt.id = l.to_page_id
         WHERE pf.slug = 'pending' AND pt.slug = 'later'`,
      );
      expect(rows).toEqual([{ from_slug: 'pending', to_slug: 'later' }]);
      expect((await loadPendingLinkReferences(engine)).filter(row => row.reference.slug === 'pending'))
        .toHaveLength(0);
    });
  }, 60_000);

  test('a thrown link sweep is not a clean import --json success', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-import-sweep-fail-'));
    writeFileSync(join(dir, 'note.md'), '---\ntype: concept\n---\n# Note\n\nbody\n');
    const gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-home-'));
    const wrapped = new Proxy(engine, {
      get(target, prop, receiver) {
        if (prop === 'countStalePagesForExtraction') {
          return () => { throw new Error('sweep blew up'); };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    try {
      await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
        const result = await runImport(wrapped, [dir, '--no-embed', '--json']);
        expect(result.imported).toBe(1);
        expect(result.errors).toBe(1);
        expect(result.failures).toContainEqual({ path: '<link-extraction>', error: expect.stringContaining('sweep blew up') });
        expect(result.linkExtractionError).toContain('sweep blew up');
      });
    } finally {
      console.log = orig;
    }
    const payload = logs.map(line => {
      try { return JSON.parse(line) as { status?: string; link_extraction_error?: string }; }
      catch { return null; }
    }).find(parsed => parsed?.link_extraction_error);
    expect(payload?.status).toBe('link_extraction_failed');
    expect(payload?.status).not.toBe('success');
    expect(payload?.link_extraction_error).toContain('sweep blew up');
  }, 60_000);

  test('a large import queues the stale sweep instead of draining it inline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-import-large-'));
    const count = INLINE_EXTRACT_CHANGE_LIMIT + 1;
    for (let i = 0; i < count; i++) {
      writeFileSync(
        join(dir, `page-${i}.md`),
        `---\ntype: concept\n---\n# Page ${i}\n\nSee [Other](page-${(i + 1) % count}.md).\n`,
      );
    }
    const gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-home-'));
    await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
      const result = await runImport(engine, [dir, '--no-embed', '--json']);
      expect(result.imported).toBe(count);
      expect(result.errors).toBe(0);
      expect(result.linkExtractionError).toBeUndefined();
      const stamped = await engine.executeRaw<{ stamped: number }>(
        `SELECT count(*)::int AS stamped FROM pages
         WHERE slug LIKE 'page-%' AND links_extracted_at IS NOT NULL AND deleted_at IS NULL`,
      );
      expect(stamped[0].stamped).toBe(0);
      const links = await engine.executeRaw<{ total: number }>(
        `SELECT count(*)::int AS total FROM links l
         JOIN pages pf ON pf.id = l.from_page_id
         WHERE pf.slug LIKE 'page-%'`,
      );
      expect(links[0].total).toBe(0);
      const jobs = await engine.executeRaw<{ data: unknown; idempotency_key: string | null; timeout_ms: number | null }>(
        `SELECT data, idempotency_key, timeout_ms FROM minion_jobs WHERE name = 'extract'`,
      );
      expect(jobs).toHaveLength(1);
      const data = (typeof jobs[0].data === 'string' ? JSON.parse(jobs[0].data) : jobs[0].data) as { stale?: boolean; reason?: string };
      expect(data.stale).toBe(true);
      expect(data.reason).toBe('import_size_gate');
      expect(jobs[0].idempotency_key).toBe('extract-stale:default:import');
      expect(jobs[0].timeout_ms).toBeGreaterThanOrEqual(30 * 60 * 1000);
    });
  }, 120_000);

  test('a pure no-op large directory does not enqueue another deferred sweep', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('noop-src', 'noop-src') ON CONFLICT (id) DO NOTHING`,
    );
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-import-noop-large-'));
    const count = INLINE_EXTRACT_CHANGE_LIMIT + 1;
    for (let i = 0; i < count; i++) {
      writeFileSync(
        join(dir, `noop-${i}.md`),
        `---\ntype: concept\n---\n# Noop ${i}\n\nSee [Other](noop-${(i + 1) % count}.md).\n`,
      );
    }
    const gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-home-'));
    await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
      const first = await runImport(engine, [dir, '--no-embed', '--json'], { sourceId: 'noop-src' });
      expect(first.imported).toBe(count);
      expect(first.errors).toBe(0);
      await engine.executeRaw(
        `UPDATE minion_jobs
         SET status = 'completed', finished_at = now()
         WHERE name = 'extract' AND idempotency_key LIKE 'extract-stale:noop-src:import%'`,
      );
      await engine.executeRaw(
        `UPDATE pages SET links_extracted_at = GREATEST(now(), updated_at, '2026-09-21T00:00:00Z'::timestamptz)
         WHERE source_id = 'noop-src' AND deleted_at IS NULL`,
      );
      const before = await engine.executeRaw<{ total: number }>(
        `SELECT count(*)::int AS total FROM minion_jobs
         WHERE name = 'extract' AND idempotency_key LIKE 'extract-stale:noop-src:import%'`,
      );
      const second = await runImport(engine, [dir, '--no-embed', '--json'], { sourceId: 'noop-src' });
      expect(second.imported).toBe(0);
      expect(second.errors).toBe(0);
      expect(second.linkExtractionError).toBeUndefined();
      const after = await engine.executeRaw<{ total: number }>(
        `SELECT count(*)::int AS total FROM minion_jobs
         WHERE name = 'extract' AND idempotency_key LIKE 'extract-stale:noop-src:import%'`,
      );
      expect(after[0].total).toBe(before[0].total);
    });
  }, 180_000);

  test('a small import with a large stale backlog queues the sweep', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('backlog-src', 'backlog-src') ON CONFLICT (id) DO NOTHING`,
    );
    await engine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title)
       SELECT 'backlog-src', 'stale-' || i, 'note', 'Stale'
       FROM generate_series(1, $1) AS i
       ON CONFLICT DO NOTHING`,
      [INLINE_EXTRACT_CHANGE_LIMIT + 1],
    );
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-import-backlog-'));
    writeFileSync(join(dir, 'fresh.md'), '---\ntype: note\n---\n# Fresh\n\nSee [Stale](stale-1.md).\n');
    const gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-home-'));
    await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
      const result = await runImport(engine, [dir, '--no-embed', '--json'], { sourceId: 'backlog-src' });
      expect(result.imported).toBe(1);
      expect(result.errors).toBe(0);
      const stamped = await engine.executeRaw<{ stamped: number }>(
        `SELECT count(*)::int AS stamped FROM pages
         WHERE source_id = 'backlog-src' AND links_extracted_at IS NOT NULL AND deleted_at IS NULL`,
      );
      expect(stamped[0].stamped).toBe(0);
      const jobs = await engine.executeRaw<{ data: unknown }>(
        `SELECT data FROM minion_jobs WHERE name = 'extract' AND idempotency_key = 'extract-stale:backlog-src:import'`,
      );
      expect(jobs).toHaveLength(1);
      const data = (typeof jobs[0].data === 'string' ? JSON.parse(jobs[0].data) : jobs[0].data) as { reason?: string; stale?: boolean };
      expect(data.stale).toBe(true);
      expect(data.reason).toBe('import_stale_backlog');
    });
  }, 120_000);

  test('failed or non-live deferred jobs block full-sync bookmarks and retain resume state', async () => {
    const previousRepo = await engine.getConfig('sync.repo_path');
    const previousCommit = await engine.getConfig('sync.last_commit');
    try {
      for (const outcome of ['throw', 'non-live']) {
        const repo = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-queue-failure-')));
        writeFileSync(join(repo, 'note.md'), '# Note\n\nA queue failure fixture.\n');
        execSync('git init -q && git add -A && git -c user.name=Tester -c user.email=t@example.com -c commit.gpgsign=false commit -qm init', { cwd: repo });
        await engine.setConfig('sync.repo_path', repo);
        await engine.setConfig('sync.last_commit', 'old-queue-anchor');
        const enqueue = spyOn(MinionQueue.prototype, 'add').mockImplementation(async () => {
          if (outcome === 'throw') throw new Error('queue unavailable');
          return { id: 6837, status: 'completed', data: { stale: true } } as never;
        });
        const gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-home-'));
        try {
          await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
            const { performSync } = await import('../src/commands/sync.ts');
            const result = await performSync(engine, { repoPath: repo, full: true, noPull: true, noEmbed: true });
            expect(result.status).toBe('blocked_by_failures');
            expect(await engine.getConfig('sync.last_commit')).toBe('old-queue-anchor');
            const checkpoint = join(gbrainHome, '.gbrain', 'import-checkpoint.json');
            expect(JSON.parse(readFileSync(checkpoint, 'utf8')).completedPaths).toContain('note.md');
          });
        } finally {
          enqueue.mockRestore();
        }
      }
    } finally {
      await engine.setConfig('sync.repo_path', previousRepo ?? '');
      await engine.setConfig('sync.last_commit', previousCommit ?? '');
    }
  }, 120_000);

  test('an extraction opt-out skips full-import queues and inline sweeps', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('optout-src', 'optout-src')`);
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-no-extract-'));
    writeFileSync(join(dir, 'one.md'), '# One\n\nSee [Two](two.md).\n');
    writeFileSync(join(dir, 'two.md'), '# Two\n\nTarget page.\n');
    const gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-home-'));
    await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
      for (const fullSync of [true, false]) {
        const result = await runImport(engine, [dir, '--no-embed', '--json'], { sourceId: 'optout-src', fullSync, noExtract: true });
        expect(result.errors).toBe(0);
      }
      expect(await engine.executeRaw(`SELECT id FROM minion_jobs WHERE name = 'extract' AND data->>'sourceId' = 'optout-src'`)).toHaveLength(0);
      expect(await engine.executeRaw(`SELECT l.id FROM links l JOIN pages p ON p.id = l.from_page_id WHERE p.source_id = 'optout-src'`)).toHaveLength(0);
    });
  }, 120_000);

  test('a full sync queues the stale sweep instead of draining it inline', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'gbrain-fullsync-sweep-'));
    mkdirSync(join(repo, 'notes'));
    writeFileSync(join(repo, 'notes/one.md'), '---\ntype: concept\n---\n# One\n\nSee [Two](two.md).\n');
    writeFileSync(join(repo, 'notes/two.md'), '---\ntype: concept\n---\n# Two\n\nTarget.\n');
    execSync('git init', { cwd: repo, stdio: 'pipe' });
    execSync('git config user.email "t@example.com"', { cwd: repo, stdio: 'pipe' });
    execSync('git config user.name "Tester"', { cwd: repo, stdio: 'pipe' });
    execSync('git add -A && git commit -m "init"', { cwd: repo, stdio: 'pipe' });
    const gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-home-'));
    await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
      const { performSync } = await import('../src/commands/sync.ts');
      const result = await performSync(engine, { repoPath: repo, full: true, noPull: true, noEmbed: true });
      expect(result.status).not.toBe('blocked_by_failures');
      const links = await engine.executeRaw<{ total: number }>(
        `SELECT count(*)::int AS total FROM links l
         JOIN pages pf ON pf.id = l.from_page_id
         WHERE pf.slug IN ('notes/one', 'notes/two')`,
      );
      expect(links[0].total).toBe(0);
      const jobs = await engine.executeRaw<{ data: unknown }>(
        `SELECT data FROM minion_jobs WHERE name = 'extract' AND idempotency_key LIKE 'extract-stale:default:%'`,
      );
      const reasons = jobs.map((job) => {
        const data = (typeof job.data === 'string' ? JSON.parse(job.data) : job.data) as { reason?: string };
        return data.reason;
      });
      expect(reasons).toContain('import_full_sync');
    });
  }, 120_000);

  test('a thrown link sweep does not advance the bookmark or drop the resume checkpoint', async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-import-bookmark-')));
    writeFileSync(join(repo, 'note.md'), '---\ntype: concept\n---\n# Note\n\nSee [Other](other.md).\n');
    execSync('git init', { cwd: repo, stdio: 'pipe' });
    execSync('git config user.email "t@example.com"', { cwd: repo, stdio: 'pipe' });
    execSync('git config user.name "Tester"', { cwd: repo, stdio: 'pipe' });
    execSync('git add -A && git commit -m "init"', { cwd: repo, stdio: 'pipe' });
    const gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-home-'));
    mkdirSync(join(gbrainHome, '.gbrain'), { recursive: true });
    const checkpoint = join(gbrainHome, '.gbrain', 'import-checkpoint.json');
    writeFileSync(checkpoint, JSON.stringify({
      schema_version: 1, owner: 'gbrain', kind: 'import', dir: repo,
      completedPaths: ['note.md'], timestamp: new Date().toISOString(),
    }));
    const previousRepo = await engine.getConfig('sync.repo_path');
    const previousCommit = await engine.getConfig('sync.last_commit');
    const wrapped = new Proxy(engine, {
      get(target, prop, receiver) {
        if (prop === 'countStalePagesForExtraction') {
          return () => { throw new Error('sweep blew up'); };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    try {
      await engine.setConfig('sync.repo_path', repo);
      await engine.setConfig('sync.last_commit', 'old-anchor');
      await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
        const result = await runImport(wrapped, [repo, '--no-embed', '--json']);
        expect(result.errors).toBe(1);
        expect(result.failures).toContainEqual({ path: '<link-extraction>', error: expect.stringContaining('sweep blew up') });
        expect(await engine.getConfig('sync.last_commit')).toBe('old-anchor');
        expect(existsSync(checkpoint)).toBe(true);
        expect(JSON.parse(readFileSync(checkpoint, 'utf8')).completedPaths).toEqual(['note.md']);
      });
    } finally {
      if (previousRepo == null) await engine.executeRaw(`DELETE FROM config WHERE key = 'sync.repo_path'`);
      else await engine.setConfig('sync.repo_path', previousRepo);
      if (previousCommit == null) await engine.executeRaw(`DELETE FROM config WHERE key = 'sync.last_commit'`);
      else await engine.setConfig('sync.last_commit', previousCommit);
    }
  }, 60_000);

  test('cancellation during the stale sweep is rethrown, not stored as a link failure', async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-import-cancel-sweep-')));
    writeFileSync(join(repo, 'note.md'), '---\ntype: concept\n---\n# Note\n\nbody\n');
    execSync('git init', { cwd: repo, stdio: 'pipe' });
    execSync('git config user.email "t@example.com"', { cwd: repo, stdio: 'pipe' });
    execSync('git config user.name "Tester"', { cwd: repo, stdio: 'pipe' });
    execSync('git add -A && git commit -m "init"', { cwd: repo, stdio: 'pipe' });
    const gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-home-'));
    const controller = new AbortController();
    const previousRepo = await engine.getConfig('sync.repo_path');
    const previousCommit = await engine.getConfig('sync.last_commit');
    const wrapped = new Proxy(engine, {
      get(target, prop, receiver) {
        if (prop === 'countStalePagesForExtraction') return async () => 1;
        if (prop === 'listStalePagesForExtraction') {
          return () => {
            controller.abort();
            return [];
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    try {
      await engine.setConfig('sync.repo_path', repo);
      await engine.setConfig('sync.last_commit', 'old-anchor');
      await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
        const error = await runImport(wrapped, [repo, '--no-embed', '--json'], { signal: controller.signal })
          .then(() => null, (caught: unknown) => caught);
        expect(error).toBeInstanceOf(ImportAbortError);
        expect((error as ImportAbortError).partialResult?.failures ?? []).not.toContainEqual(
          expect.objectContaining({ path: '<link-extraction>' }),
        );
        expect(await engine.getConfig('sync.last_commit')).toBe('old-anchor');
      });
    } finally {
      if (previousRepo == null) await engine.executeRaw(`DELETE FROM config WHERE key = 'sync.repo_path'`);
      else await engine.setConfig('sync.repo_path', previousRepo);
      if (previousCommit == null) await engine.executeRaw(`DELETE FROM config WHERE key = 'sync.last_commit'`);
      else await engine.setConfig('sync.last_commit', previousCommit);
    }
  }, 60_000);
});
