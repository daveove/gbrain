/**
 * Import writes pages and used to stop there. A markdown link between two
 * pages already in the brain never became a `links` row, because the stale
 * extract sweep was not run. This pins that the sweep runs and the edge
 * exists.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { execSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runImport } from '../src/commands/import.ts';
import { INLINE_EXTRACT_CHANGE_LIMIT } from '../src/core/deferred-stale-extract.ts';
import { withEnv } from './helpers/with-env.ts';

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
      expect(before).toEqual([{ slug: 'pending', links_extracted_at: null }]);

      await runImport(engine, [targetDir, '--no-embed', '--json']);
      const rows = await engine.executeRaw<{ from_slug: string; to_slug: string }>(
        `SELECT pf.slug AS from_slug, pt.slug AS to_slug
         FROM links l
         JOIN pages pf ON pf.id = l.from_page_id
         JOIN pages pt ON pt.id = l.to_page_id
         WHERE pf.slug = 'pending' AND pt.slug = 'later'`,
      );
      expect(rows).toEqual([{ from_slug: 'pending', to_slug: 'later' }]);
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
});
