/**
 * DAV-7480 / DAV-7159: a file named after a stored page's slug updates that page.
 *
 * slugifyPath collapses a run of hyphens, so a page stored as `tana-1-abc--4c32`
 * (the source keys pages with `--`) was re-derived from its own file name
 * `tana-1-abc--4c32.md` as `tana-1-abc-4c32`, and `gbrain import` minted a twin
 * instead of updating the stored page. importFromFile now resolves the stored
 * slug by the file's stem, then by source_path, inside the import's source.
 *
 * PGLite in-memory, no embeddings ($0).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent, importFromFile } from '../src/core/import-file.ts';
import { storedSlugForPath } from '../src/core/import-identity.ts';
import { slugifyPath } from '../src/core/sync.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const SOURCE = 'tana-fixture';
const OTHER = 'other-fixture';

let engine: PGLiteEngine;
let schemaVersion: string | null;
let dir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  schemaVersion = await engine.getConfig('version');
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-stored-slug-')));
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  if (schemaVersion) await engine.setConfig('version', schemaVersion);
  for (const id of [SOURCE, OTHER]) {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config, archived, created_at) VALUES ($1, $1, '{}'::jsonb, false, NOW()) ON CONFLICT (id) DO NOTHING`,
      [id],
    );
  }
});

const doc = (title: string, body: string) => `---\ntype: concept\ntitle: ${title}\n---\n\n${body}\n`;

async function seed(slug: string, sourceId: string, body = 'Original raw body.'): Promise<void> {
  const r = await importFromContent(engine, slug, doc('Seed', body), { noEmbed: true, sourceId });
  expect(r.status).toBe('imported');
}

function write(rel: string, text: string): string {
  const full = join(dir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
  return full;
}

const liveSlugs = async (sourceId: string) =>
  (await engine.executeRaw<{ slug: string }>(
    `SELECT slug FROM pages WHERE source_id = $1 AND deleted_at IS NULL ORDER BY slug`, [sourceId],
  )).map(r => r.slug);

describe('import updates the stored page for a double-hyphen slug', () => {
  test('fixture slug really is collapsed by slugifyPath', () => {
    expect(slugifyPath('tana-1-enaletppn21--4c32f95d.md')).toBe('tana-1-enaletppn21-4c32f95d');
  });

  test('file named after the stored slug updates that page and creates no twin', async () => {
    const stored = 'tana-1-enaletppn21--4c32f95d';
    await seed(stored, SOURCE);
    const [before] = await engine.executeRaw<{ id: number }>(`SELECT id FROM pages WHERE source_id = $1 AND slug = $2`, [SOURCE, stored]);

    const rel = `${stored}.md`;
    const result = await importFromFile(engine, write(rel, doc('Parsed', 'Re-parsed markdown body.')), rel, { noEmbed: true, sourceId: SOURCE });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe('imported');
    expect(result.slug).toBe(stored);
    expect(await liveSlugs(SOURCE)).toEqual([stored]);
    const [after] = await engine.executeRaw<{ id: number; compiled_truth: string; source_path: string }>(
      `SELECT id, compiled_truth, source_path FROM pages WHERE source_id = $1 AND slug = $2`, [SOURCE, stored]);
    expect(after.id).toBe(before.id);
    expect(after.compiled_truth).toContain('Re-parsed markdown body.');
    expect(after.source_path).toBe(rel);
  });

  test('re-import of the same file is a no-op on the same stored page', async () => {
    const stored = 'notes/a--b';
    await seed(stored, SOURCE);
    const rel = `${stored}.md`;
    const file = write(rel, doc('Parsed', 'Body once.'));
    expect((await importFromFile(engine, file, rel, { noEmbed: true, sourceId: SOURCE })).status).toBe('imported');
    const again = await importFromFile(engine, file, rel, { noEmbed: true, sourceId: SOURCE });
    expect(again.status).toBe('skipped');
    expect(again.error).toBeUndefined();
    expect(await liveSlugs(SOURCE)).toEqual([stored]);
  });

  test('negative control: a double-hyphen file with no stored page keeps path-derived behaviour', async () => {
    const rel = 'notes/c--d.md';
    const result = await importFromFile(engine, write(rel, doc('New', 'Fresh body.')), rel, { noEmbed: true, sourceId: SOURCE });
    expect(result.status).toBe('imported');
    expect(result.slug).toBe('notes/c-d');
    expect(await liveSlugs(SOURCE)).toEqual(['notes/c-d']);
  });

  test('a stored page in another source is never matched', async () => {
    await seed('notes/e--f', OTHER);
    const rel = 'notes/e--f.md';
    const result = await importFromFile(engine, write(rel, doc('Mine', 'Other source body.')), rel, { noEmbed: true, sourceId: SOURCE });
    expect(result.slug).toBe('notes/e-f');
    expect(await liveSlugs(OTHER)).toEqual(['notes/e--f']);
    expect(await liveSlugs(SOURCE)).toEqual(['notes/e-f']);
  });

  test('source_path lookup reaches a stored slug the stem cannot spell', async () => {
    await seed('cafe--x', SOURCE);
    await engine.executeRaw(`UPDATE pages SET source_path = $1 WHERE source_id = $2 AND slug = 'cafe--x'`, ['Caf\u00e9--x.md', SOURCE]);
    const rel = 'Caf\u00e9--x.md';
    const result = await importFromFile(engine, write(rel, doc('Cafe', 'Accent body.')), rel, { noEmbed: true, sourceId: SOURCE });
    expect(result.slug).toBe('cafe--x');
    expect(await liveSlugs(SOURCE)).toEqual(['cafe--x']);
  });

  test('anti-spoof: a page whose slug does not normalize to the path slug is never reached', async () => {
    await seed('people/mallory', SOURCE);
    await engine.executeRaw(`UPDATE pages SET source_path = $1 WHERE source_id = $2 AND slug = 'people/mallory'`, ['people/eve--x.md', SOURCE]);
    const decision = await storedSlugForPath(engine, SOURCE, 'people/eve--x.md', slugifyPath('people/eve--x.md'));
    expect(decision.kind).toBe('none');
  });

  test('two stored pages claiming one file are ambiguous and the file is skipped', async () => {
    await seed('ge--h', SOURCE);
    await seed('ge---h', SOURCE, 'Second raw body.');
    const rel = 'G\u00e9--H.md';
    await engine.executeRaw(`UPDATE pages SET source_path = $1 WHERE source_id = $2 AND slug IN ('ge--h', 'ge---h')`, [rel, SOURCE]);
    const result = await importFromFile(engine, write(rel, doc('GH', 'Ambiguous body.')), rel, { noEmbed: true, sourceId: SOURCE });
    expect(result.status).toBe('skipped');
    expect(result.skip_reason).toBe('slug_collision');
    expect(result.error).toContain('ge--h');
    expect([...(await liveSlugs(SOURCE))].sort()).toEqual(['ge---h', 'ge--h']);
  });

  test('an explicit frontmatter slug still decides the identity', async () => {
    await seed('notes/i--j', SOURCE);
    const rel = 'notes/i--j.md';
    const text = '---\ntype: concept\ntitle: Explicit\nslug: notes/i-j\n---\n\nExplicit slug body.\n';
    const result = await importFromFile(engine, write(rel, text), rel, { noEmbed: true, sourceId: SOURCE });
    expect(result.slug).toBe('notes/i-j');
  });

  // A--B.md and a--b.md are two files only on a case-sensitive filesystem.
  const caseSensitive = (() => {
    const probe = mkdtempSync(join(tmpdir(), 'gbrain-case-probe-'));
    writeFileSync(join(probe, 'p.md'), '');
    try { realpathSync.native(join(probe, 'P.md')); return false; } catch { return true; }
  })();
  test.skipIf(!caseSensitive)('a differently cased file does not take over the page another file owns', async () => {
    await seed('k--l', SOURCE);
    const owned = 'k--l.md';
    expect((await importFromFile(engine, write(owned, doc('Owner', 'Owner body.')), owned, { noEmbed: true, sourceId: SOURCE })).status).toBe('imported');
    const intruder = 'K--L.md';
    const result = await importFromFile(engine, write(intruder, doc('Intruder', 'Intruder body.')), intruder, { noEmbed: true, sourceId: SOURCE });
    expect(result.status).toBe('skipped');
    expect(result.skip_reason).toBe('slug_collision');
    const [page] = await engine.executeRaw<{ compiled_truth: string; source_path: string }>(
      `SELECT compiled_truth, source_path FROM pages WHERE source_id = $1 AND slug = 'k--l'`, [SOURCE]);
    expect(page.source_path).toBe(owned);
    expect(page.compiled_truth).toContain('Owner body.');
  });
});
