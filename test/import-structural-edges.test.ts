/**
 * Import writes pages and used to stop there. A markdown link between two
 * pages already in the brain never became a `links` row, because the stale
 * extract sweep was not run. This pins that the sweep runs and the edge
 * exists.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runImport } from '../src/commands/import.ts';
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
});
