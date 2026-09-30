import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { extractLinksForSlugs, extractStaleFromDB, runExtract, runExtractCore, stampExtracted } from '../src/commands/extract.ts';
import { loadPendingLinkReferences, pendingLinkReferenceBatches, probePendingLinkReferences, requeueReadyPendingLinks, storePendingLinkReferences } from '../src/core/pending-link-references.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-pending-links-'));
let engine: PGLiteEngine;
let reopenedEngine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  reopenedEngine = new PGLiteEngine();
  await engine.connect({ database_path: home });
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });
beforeEach(async () => { await resetPgliteState(engine); });
const page = (body = '') => ({ type: 'person', title: 'Example', compiled_truth: body, timeline: '' });
const drain = (signal?: AbortSignal) => extractStaleFromDB(engine, {
  dryRun: false, jsonMode: true, quiet: true, includeFrontmatter: false, catchUp: false, signal,
});
async function origin() {
  const s = (await engine.readPageSnapshot('people/origin', { sourceId: 'default' }))!;
  return { slug: 'people/origin', sourceId: 'default', revision: s.revision, sourceIncarnation: s.sourceIncarnation };
}

test('permanent missing target clears backlog; dormant retry reads no page body', async () => {
  await engine.putPage('people/origin', page('[[people/missing]]'));
  expect((await drain()).staleRemaining).toBe(0);
  expect(await loadPendingLinkReferences(engine)).toHaveLength(1);
  const read = engine.readPageSnapshot;
  const refs = engine.listAllPageRefs;
  engine.readPageSnapshot = async () => { throw new Error('dormant retry must not read body'); };
  engine.listAllPageRefs = async () => { throw new Error('dormant retry must not scan all pages'); };
  try { expect((await drain()).pagesProcessed).toBe(0); } finally { engine.readPageSnapshot = read; engine.listAllPageRefs = refs; }
});

test('delayed target resolves after database close/reopen', async () => {
  await engine.putPage('people/origin', page('[[people/later]]'));
  expect((await drain()).staleRemaining).toBe(0);
  await engine.disconnect();
  engine = reopenedEngine;
  await engine.connect({ database_path: home });
  await engine.putPage('people/later', page());
  await drain();
  expect((await engine.getLinks('people/origin')).some(link => link.to_slug === 'people/later')).toBe(true);
  expect(await loadPendingLinkReferences(engine)).toHaveLength(0);
});

test('another source target does not wake isolated origin', async () => {
  await engine.executeRaw("INSERT INTO sources(id,name) VALUES('pending-other','Other') ON CONFLICT(id) DO NOTHING");
  await engine.putPage('people/origin', page('[[people/later]]'));
  await drain();
  await engine.putPage('people/later', page(), { sourceId: 'pending-other' });
  await drain();
  expect(await engine.getLinks('people/origin')).toHaveLength(0);
  expect(await loadPendingLinkReferences(engine)).toHaveLength(1);
});

for (const federated of [true, false]) test(`qualified target arrival requeues its origin without widening the target-source drain (${federated})`, async () => {
  const a = 'pending-origin', b = 'pending-target';
  await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES($1,$1,$2::text::jsonb),($3,$3,'{}'::jsonb)",
    [a, JSON.stringify({ federated }), b]);
  const scoped = (sourceId: string, dryRun = false) => extractStaleFromDB(engine, {
    dryRun, jsonMode: true, quiet: true, includeFrontmatter: false, sourceIdFilter: sourceId, catchUp: false,
  });
  await engine.putPage('people/origin', page(`[[${b}:people/later]]`), { sourceId: a });
  await scoped(a);
  expect(await engine.countStalePagesForExtraction({ sourceId: a })).toBe(0);
  expect(await loadPendingLinkReferences(engine, a)).toHaveLength(1);
  await engine.putPage('people/later', page(), { sourceId: b });
  const pending = await loadPendingLinkReferences(engine, a);
  expect((await scoped(b, true)).staleRemaining).toBe(1); // Only B is extracted by this invocation.
  expect(await loadPendingLinkReferences(engine, a)).toEqual(pending);
  expect(await engine.countStalePagesForExtraction({ sourceId: a })).toBe(0);
  const read = engine.readPageSnapshot;
  engine.readPageSnapshot = async function(...args) {
    if (args[1]?.sourceId === a) throw new Error('Target-source drain must not read origin body');
    return read.apply(this, args);
  };
  try { expect((await scoped(b)).pagesProcessed).toBe(1); }
  finally { engine.readPageSnapshot = read; }
  if (!federated) {
    expect(await engine.countStalePagesForExtraction({ sourceId: a })).toBe(0);
    expect(await loadPendingLinkReferences(engine, a)).toHaveLength(1);
    await engine.setConfig('link_resolution.cross_source', 'true');
    expect((await scoped(b)).pagesProcessed).toBe(0);
  }
  expect(await engine.countStalePagesForExtraction({ sourceId: a })).toBe(1);
  expect(await loadPendingLinkReferences(engine, a)).toHaveLength(0);
  expect((await scoped(a)).pagesProcessed).toBe(1);
  expect((await engine.getLinks('people/origin', { sourceId: a })).some(link =>
    link.to_source_id === b && link.to_slug === 'people/later')).toBe(true);
  expect((await scoped(a)).pagesProcessed).toBe(0);
});

test('only the configured fallback source wakes an unqualified foreign origin', async () => {
  const a = 'pending-fallback-origin', b = 'pending-configured-default', other = 'pending-nondefault';
  await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES($1,$1,'{\"federated\":true}'::jsonb),($2,$2,'{}'::jsonb),($3,$3,'{}'::jsonb)", [a,b,other]);
  await engine.setConfig('sources.default', b);
  const scoped = (sourceId: string, dryRun = false) => extractStaleFromDB(engine, {
    dryRun, jsonMode: true, quiet: true, includeFrontmatter: false, sourceIdFilter: sourceId, catchUp: false,
  });
  await engine.putPage('people/fallback-origin', page('[[people/fallback-later]]'), { sourceId: a });
  await scoped(a);
  const pending = await loadPendingLinkReferences(engine, a);
  await engine.putPage('people/fallback-later', page(), { sourceId: other });
  await scoped(other);
  expect(await engine.countStalePagesForExtraction({ sourceId: a })).toBe(0);
  expect(await loadPendingLinkReferences(engine, a)).toEqual(pending);
  await engine.putPage('people/fallback-later', page(), { sourceId: b });
  expect((await scoped(b, true)).staleRemaining).toBe(1);
  expect(await loadPendingLinkReferences(engine, a)).toEqual(pending);
  expect(await engine.countStalePagesForExtraction({ sourceId: a })).toBe(0);
  const read = engine.readPageSnapshot;
  engine.readPageSnapshot = async function(...args) {
    if (args[1]?.sourceId === a) throw new Error('Fallback drain must not read foreign body');
    return read.apply(this, args);
  };
  try { expect((await scoped(b)).pagesProcessed).toBe(1); }
  finally { engine.readPageSnapshot = read; }
  expect(await engine.countStalePagesForExtraction({ sourceId: a })).toBe(1);
  expect((await scoped(a)).pagesProcessed).toBe(1);
  expect((await engine.getLinks('people/fallback-origin', { sourceId: a })).some(link =>
    link.to_source_id === b && link.to_slug === 'people/fallback-later')).toBe(true);
});

test('registry write failure preserves stale watermark', async () => {
  await engine.putPage('people/origin', page('[[people/missing]]'));
  const execute = engine.executeRaw;
  engine.executeRaw = (async function(this: PGLiteEngine, sql: string, params?: unknown[]) {
    if (sql.includes('INSERT INTO config(key,value)')) throw new Error('registry unavailable');
    return execute.call(this, sql, params);
  }) as typeof engine.executeRaw;
  try { await expect(drain()).rejects.toThrow('registry unavailable'); } finally { engine.executeRaw = execute; }
  expect(await engine.countStalePagesForExtraction()).toBe(1);
});

test('cancellation after snapshot writes neither registry nor stamp', async () => {
  await engine.putPage('people/origin', page('[[people/missing]]'));
  const controller = new AbortController();
  const read = engine.readPageSnapshot;
  engine.readPageSnapshot = async function(...args) { const value = await read.apply(this, args); controller.abort(); return value; };
  try { await expect(drain(controller.signal)).rejects.toThrow(); } finally { engine.readPageSnapshot = read; }
  expect(await loadPendingLinkReferences(engine)).toHaveLength(0);
  expect(await engine.countStalePagesForExtraction()).toBe(1);
});

test('obsolete cleanup CAS cannot delete a concurrent replacement', async () => {
  await engine.putPage('people/origin', page('[[people/missing]]'));
  await drain();
  const oldRows = await loadPendingLinkReferences(engine);
  await engine.putPage('people/origin', page('[[people/different]]'));
  await storePendingLinkReferences(engine, await origin(), [{ targetSlug: 'people/different', linkType: '', context: 'private body must be omitted' }]);
  await requeueReadyPendingLinks(engine, oldRows, () => false);
  const rows = await loadPendingLinkReferences(engine);
  expect(rows).toHaveLength(1);
  expect(rows[0].reference.candidates[0].targetSlug).toBe('people/different');
  expect(rows[0].value).not.toContain('private body');
});

test('aborted pending readiness check cannot mutate registry or watermark', async () => {
  await engine.putPage('people/origin', page('[[people/missing]]')); await drain();
  const rows = await loadPendingLinkReferences(engine);
  const controller = new AbortController(); controller.abort();
  await expect(requeueReadyPendingLinks(engine, rows, () => true, controller.signal)).rejects.toThrow();
  expect(await loadPendingLinkReferences(engine)).toEqual(rows);
  expect(await engine.countStalePagesForExtraction()).toBe(0);
});

test('deleted origins remove obsolete registry entries without waking another page', async () => {
  await engine.putPage('people/origin', page('[[people/missing]]')); await drain();
  await engine.executeRaw("UPDATE pages SET deleted_at=now() WHERE slug='people/origin' AND source_id='default'");
  await drain();
  expect(await loadPendingLinkReferences(engine)).toHaveLength(0);
});

test('delayed bare basename with display alias wakes for a source-local qualified slug', async () => {
  await engine.setConfig('link_resolution.global_basename', 'true');
  try {
    await engine.putPage('people/origin', page('[[bob|Display Alias]]')); await drain();
    expect(await loadPendingLinkReferences(engine)).toHaveLength(1);
    await engine.putPage('people/bob', page()); await drain();
    expect((await engine.getLinks('people/origin')).some(link => link.to_slug === 'people/bob')).toBe(true);
    expect(await loadPendingLinkReferences(engine)).toHaveLength(0);
    expect((await drain()).pagesProcessed).toBe(0);
  } finally { await engine.setConfig('link_resolution.global_basename', 'false'); }
});

test('expired readiness deadline preserves dormant registry and watermark', async () => {
  await engine.putPage('people/origin', page('[[people/missing]]')); await drain();
  const rows = await loadPendingLinkReferences(engine);
  expect(await requeueReadyPendingLinks(engine, rows, () => true, undefined, 0)).toBe(0);
  expect(await loadPendingLinkReferences(engine)).toEqual(rows);
  expect(await engine.countStalePagesForExtraction()).toBe(0);
});


test('nearby different missing basename survives an edge with the same excerpt', async () => {
  await engine.setConfig('link_resolution.global_basename', 'true');
  try {
    await engine.putPage('people/origin', page('[[bob]] and [[robert]]')); await drain();
    await engine.putPage('people/robert', page()); await drain();
    const rows = await loadPendingLinkReferences(engine);
    expect(rows).toHaveLength(1);
    expect(rows[0].reference.candidates.map(candidate => candidate.targetSlug)).toEqual(['bob']);
    expect((await drain()).pagesProcessed).toBe(0);
  } finally { await engine.setConfig('link_resolution.global_basename', 'false'); }
});


test('zero budget still processes one stale batch beside dormant pending references', async () => {
  await engine.putPage('people/origin', page('[[people/missing]]')); await drain();
  for (let i = 0; i < 26; i++) await engine.putPage(`people/budget-${i}`, page());
  const result = await extractStaleFromDB(engine, {
    dryRun: false, jsonMode: true, quiet: true, includeFrontmatter: false, catchUp: false, timeBudgetMs: 0,
  });
  expect(result.pagesProcessed).toBe(25);
  expect(result.staleRemaining).toBe(1);
  expect(await loadPendingLinkReferences(engine)).toHaveLength(1);
});

test('dry-run counts ready dormant basenames without changing registry or watermarks', async () => {
  await engine.setConfig('link_resolution.global_basename', 'true');
  try {
    await engine.putPage('people/origin', page('[[later|Display alias]]')); await drain();
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES('pending-other','Other') ON CONFLICT(id) DO NOTHING");
    await engine.putPage('people/later', page(), { sourceId: 'pending-other' });
    await engine.markPagesExtractedBatch([{ slug: 'people/later', source_id: 'pending-other' }], new Date(Date.now() + 1000).toISOString());
    const preview = () => extractStaleFromDB(engine, {
      dryRun: true, jsonMode: true, quiet: true, includeFrontmatter: false,
      sourceIdFilter: 'default', catchUp: false,
    });
    expect((await preview()).staleRemaining).toBe(0);
    await engine.putPage('people/later', page());
    await engine.markPagesExtractedBatch([{ slug: 'people/later', source_id: 'default' }], new Date(Date.now() + 1000).toISOString());
    const registry = await loadPendingLinkReferences(engine);
    const metadata = () => engine.executeRaw('SELECT slug,source_id,knowledge_revision,updated_at,links_extracted_at FROM pages ORDER BY source_id,slug');
    const before = await metadata();
    const read = engine.readPageSnapshot, refs = engine.listAllPageRefs;
    engine.readPageSnapshot = async () => { throw new Error('dry-run readiness must not read page bodies'); };
    engine.listAllPageRefs = async () => { throw new Error('dry-run readiness must not scan all pages'); };
    try {
      expect(await preview()).toMatchObject({ staleRemaining: 1, pagesProcessed: 0, linksCreated: 0, timelineCreated: 0 });
      expect((await preview()).staleRemaining).toBe(1);
    } finally { engine.readPageSnapshot = read; engine.listAllPageRefs = refs; }
    expect(await loadPendingLinkReferences(engine)).toEqual(registry);
    expect(await metadata()).toEqual(before);
    expect(await engine.getLinks('people/origin')).toHaveLength(0);
    expect(await extractStaleFromDB(engine, {
      dryRun: false, jsonMode: true, quiet: true, includeFrontmatter: false,
      sourceIdFilter: 'default', catchUp: false,
    })).toMatchObject({ pagesProcessed: 1, staleRemaining: 0 });
  } finally { await engine.setConfig('link_resolution.global_basename', 'false'); }
});

test('dry-run does not double-count an already-stale ready origin or clean obsolete references', async () => {
  await engine.putPage('people/origin', page('[[people/later]]')); await drain();
  await engine.putPage('people/later', page());
  await engine.markPagesExtractedBatch([{ slug: 'people/later', source_id: 'default' }], new Date(Date.now() + 1000).toISOString());
  await engine.executeRaw("UPDATE pages SET links_extracted_at=NULL WHERE slug='people/origin'");
  const preview = () => extractStaleFromDB(engine, {
    dryRun: true, jsonMode: true, quiet: true, includeFrontmatter: false, catchUp: false,
  });
  expect((await preview()).staleRemaining).toBe(1);
  await engine.putPage('people/origin', page('Changed origin without that reference.'));
  await engine.markPagesExtractedBatch([{ slug: 'people/origin', source_id: 'default' }], new Date(Date.now() + 1000).toISOString());
  const registry = await loadPendingLinkReferences(engine);
  expect((await preview()).staleRemaining).toBe(0);
  expect(await loadPendingLinkReferences(engine)).toEqual(registry);
});


test('pending registry scans only the requested source in bounded keyset batches', async () => {
  await engine.setConfig('unrelated-non-json', 'ordinary configuration');
  const rows = Array.from({ length: 310 }, (_, i) => ({
    key: `internal.pending-links.batch-${String(i).padStart(4, '0')}`,
    value: JSON.stringify({ slug: `people/fixture-${i}`, sourceId: i < 205 ? 'unrelated' : 'default',
      revision: 'fixture-revision', sourceIncarnation: 'fixture-incarnation', candidates: [] }),
  }));
  await engine.executeRaw(`INSERT INTO config(key,value)
    SELECT key,value FROM jsonb_to_recordset(($1::jsonb)->'rows') AS r(key text,value text)`, [{ rows }]);
  const batches = [];
  for await (const batch of pendingLinkReferenceBatches(engine, 'default')) batches.push(batch);
  expect(batches.map(batch => batch.length)).toEqual([100, 5]);
  expect(batches.flat().every(row => row.reference.sourceId === 'default')).toBe(true);
  expect(new Set(batches.flat().map(row => row.key)).size).toBe(105);
  expect(await loadPendingLinkReferences(engine, 'unrelated')).toHaveLength(205);
  await engine.setConfig('internal.pending-links.malformed-text', '{broken');
  await engine.setConfig('internal.pending-links.malformed-shape', JSON.stringify({
    sourceId: 'default', candidates: [{ targetSourceId: 'default' }],
  }));
  expect(await loadPendingLinkReferences(engine, 'default')).toHaveLength(105);
  expect(await loadPendingLinkReferences(engine)).toHaveLength(310);
  expect(await engine.getConfig('internal.pending-links.malformed-text')).toBe('{broken');
  const iterator = pendingLinkReferenceBatches(engine, 'default');
  expect((await iterator.next()).value).toHaveLength(100);
  expect(await iterator.return()).toEqual({ value: undefined, done: true });
});

test('expired and cancelled pending probes issue no readiness queries', async () => {
  await engine.putPage('people/origin', page('[[people/missing]]')); await drain();
  const rows = await loadPendingLinkReferences(engine);
  const controller = new AbortController(); controller.abort();
  const original = engine.executeRaw;
  engine.executeRaw = async () => { throw new Error('expired probe must not query'); };
  try {
    const expired = pendingLinkReferenceBatches(engine, 'default', { deadline: Date.now() - 1 });
    expect(await expired.next()).toEqual({ value: undefined, done: true });
    await expect(pendingLinkReferenceBatches(engine, 'default', { signal: controller.signal }).next()).rejects.toThrow();
    expect(await probePendingLinkReferences(engine, rows, {
      globalBasename: true, deadline: Date.now() - 1,
    }, () => true)).toBe(0);
    expect(await requeueReadyPendingLinks(engine, rows, () => true, undefined, Date.now() - 1)).toBe(0);
  } finally { engine.executeRaw = original; }
});


test('incremental file extraction hands missing targets off before stamping', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-inline-pending-'));
  try {
    mkdirSync(join(dir, 'people'));
    writeFileSync(join(dir, 'people/origin.md'), '---\ntype: person\n---\n[[people/later]]');
    await engine.putPage('people/origin', page('[[people/later]]'));
    const result = await extractLinksForSlugs(engine, dir, ['people/origin']);
    expect(result.processed).toEqual(['people/origin']);
    await stampExtracted(engine, result.processed.map(slug => ({ slug, source_id: 'default' })));
    expect(await engine.countStalePagesForExtraction()).toBe(0);
    expect(await loadPendingLinkReferences(engine)).toHaveLength(1);
    await engine.putPage('people/later', page());
    await drain();
    expect((await engine.getLinks('people/origin')).some(link => link.to_slug === 'people/later')).toBe(true);
    expect(await loadPendingLinkReferences(engine)).toHaveLength(0);
    expect((await drain()).pagesProcessed).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('incremental registry failure does not report the origin safe to stamp', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-inline-pending-fail-'));
  mkdirSync(join(dir, 'people'));
  writeFileSync(join(dir, 'people/origin.md'), '---\ntype: person\n---\n[[people/missing]]');
  await engine.putPage('people/origin', page('[[people/missing]]'));
  const execute = engine.executeRaw;
  engine.executeRaw = (async function(this: PGLiteEngine, sql: string, params?: unknown[]) {
    if (sql.includes('INSERT INTO config(key,value)')) throw new Error('registry unavailable');
    return execute.call(this, sql, params);
  }) as typeof engine.executeRaw;
  try {
    expect((await extractLinksForSlugs(engine, dir, ['people/origin'])).processed).toEqual([]);
    expect(await engine.countStalePagesForExtraction()).toBe(1);
  } finally { engine.executeRaw = execute; rmSync(dir, { recursive: true, force: true }); }
});


for (const mode of ['incremental', 'full-fs', 'manual-db'] as const) {
  const run = (dir: string) => mode === 'manual-db'
    ? runExtract(engine, ['all', '--source', 'db', '--source-id', 'default', '--json'])
    : runExtractCore(engine, { mode: 'all', dir, quiet: true,
      ...(mode === 'incremental' ? { slugs: ['people/origin'] } : {}) });
  test(`${mode} all-mode persists missing targets before its watermark`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-all-pending-'));
    try {
      mkdirSync(join(dir, 'people'));
      writeFileSync(join(dir, 'people/origin.md'), '---\ntype: person\n---\n[[people/later]]');
      await engine.putPage('people/origin', page('[[people/later]]'));
      await run(dir);
      expect(await engine.countStalePagesForExtraction()).toBe(0);
      expect(await loadPendingLinkReferences(engine)).toHaveLength(1);
      await engine.putPage('people/later', page());
      await drain();
      expect((await engine.getLinks('people/origin')).some(link => link.to_slug === 'people/later')).toBe(true);
      expect(await loadPendingLinkReferences(engine)).toHaveLength(0);
      expect((await drain()).pagesProcessed).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test(`${mode} registry failure leaves its origin stale`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-all-pending-fail-'));
    mkdirSync(join(dir, 'people'));
    writeFileSync(join(dir, 'people/origin.md'), '---\ntype: person\n---\n[[people/missing]]');
    await engine.putPage('people/origin', page('[[people/missing]]'));
    const execute = engine.executeRaw;
    engine.executeRaw = (async function(this: PGLiteEngine, sql: string, params?: unknown[]) {
      if (sql.includes('INSERT INTO config(key,value)')) throw new Error('registry unavailable');
      return execute.call(this, sql, params);
    }) as typeof engine.executeRaw;
    try {
      if (mode === 'manual-db') {
        const exit = spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`extract exit ${code}`); });
        try { await expect(run(dir)).rejects.toThrow('extract exit 1'); expect(exit).toHaveBeenCalledWith(1); }
        finally { exit.mockRestore(); }
      } else await run(dir);
      expect(await engine.countStalePagesForExtraction()).toBe(1);
      expect(await loadPendingLinkReferences(engine)).toHaveLength(0);
    } finally { engine.executeRaw = execute; rmSync(dir, { recursive: true, force: true }); }
  });
}


for (const incremental of [true, false]) test(`file all-mode abort after snapshot writes no pending state (${incremental})`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-file-pending-abort-'));
  mkdirSync(join(dir, 'people'));
  writeFileSync(join(dir, 'people/origin.md'), '---\ntype: person\n---\n[[people/missing]]');
  await engine.putPage('people/origin', page('[[people/missing]]'));
  const controller = new AbortController();
  const read = engine.readPageSnapshot;
  engine.readPageSnapshot = async function(...args) {
    const value = await read.apply(this, args); controller.abort(); return value;
  };
  try {
    await runExtractCore(engine, { mode: 'all', dir, quiet: true, signal: controller.signal,
      ...(incremental ? { slugs: ['people/origin'] } : {}) });
    expect(await loadPendingLinkReferences(engine)).toHaveLength(0);
    expect(await engine.countStalePagesForExtraction()).toBe(1);
    expect(await engine.getLinks('people/origin')).toHaveLength(0);
  } finally { engine.readPageSnapshot = read; rmSync(dir, { recursive: true, force: true }); }
});
