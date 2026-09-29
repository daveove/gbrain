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
    const gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-home-'));

    await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
      const result = await runImport(engine, [dir, '--no-embed', '--json']);
      expect(result.imported).toBe(2);
      expect(result.errors).toBe(0);

      const rows = await engine.executeRaw<{ from_slug: string; to_slug: string }>(
        `SELECT pf.slug AS from_slug, pt.slug AS to_slug
         FROM links l
         JOIN pages pf ON pf.id = l.from_page_id
         JOIN pages pt ON pt.id = l.to_page_id
         WHERE pf.deleted_at IS NULL AND pt.deleted_at IS NULL`,
      );
      expect(rows).toEqual([{ from_slug: 'alpha', to_slug: 'beta' }]);
    });
  }, 60_000);
});
