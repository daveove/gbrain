import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';
import { INLINE_PENDING_PROBE_BUDGET_MS, probePendingOriginsForArrivedTargets } from '../src/core/pending-link-target-arrivals.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { extractLinksForSlugs, extractStaleFromDB, STALE_TIME_BUDGET_MS, runExtract, runExtractCore, stampExtracted } from '../src/commands/extract.ts';
import { loadPendingLinkReferences, pendingLinkReferenceBatches, probePendingLinkReferences, requeueReadyPendingLinks, storePendingLinkReferences } from '../src/core/pending-link-references.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-pending-links-'));
let engine: PGLiteEngine;
let reopenedEngine: PGLiteEngine;
let schemaVersion: string | null;
beforeAll(async () => {
  engine = new PGLiteEngine();
  reopenedEngine = new PGLiteEngine();
  await engine.connect({ database_path: home });
  await engine.initSchema();
  schemaVersion = await engine.getConfig('version');
}, 60_000);
afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });
beforeEach(async () => {
  await resetPgliteState(engine);
  if (schemaVersion) await engine.setConfig('version', schemaVersion);
});
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
  // B's new page plus a ready foreign A wakeup when federated cross-source applies.
  expect((await scoped(b, true)).staleRemaining).toBe(federated ? 2 : 1);
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
  // B stale page + foreign A wakeup.
  expect((await scoped(b, true)).staleRemaining).toBe(2);
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

for (const failure of ['throw', 'null']) test(`foreign wake retries a failed durable handoff (${failure})`, async () => {
  const a = 'pending-retry-origin', b = 'pending-retry-target';
  await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES($1,$1,'{\"federated\":true}'::jsonb),($2,$2,'{}'::jsonb)", [a,b]);
  const scoped = (sourceId: string, dryRun = false) => extractStaleFromDB(engine, {
    dryRun, jsonMode: true, quiet: true, includeFrontmatter: false, sourceIdFilter: sourceId, catchUp: false,
  });
  await engine.putPage('people/retry-origin', page(`[[${b}:people/retry-target]]`), { sourceId: a });
  await scoped(a);
  const pending = await loadPendingLinkReferences(engine, a);
  await engine.putPage('people/retry-target', page(), { sourceId: b });
  const enqueue = spyOn(MinionQueue.prototype, 'add').mockImplementation(async () => {
    if (failure === 'throw') throw new Error('Synthetic queue failure');
    return { id: 0, status: 'completed', data: {} } as never;
  });
  try { await expect(scoped(b)).rejects.toThrow(failure === 'throw' ? 'Synthetic queue failure' : 'handoff was not accepted'); }
  finally { enqueue.mockRestore(); }
  expect(await loadPendingLinkReferences(engine, a)).toEqual(pending);
  expect(await engine.countStalePagesForExtraction({ sourceId: a })).toBe(1);
  const jobsBefore = await engine.executeRaw("SELECT id FROM minion_jobs WHERE name='extract'");
  // B still stale (failed before drain) + already-stale foreign A wakeup.
  expect((await scoped(b, true)).staleRemaining).toBe(2);
  expect(await loadPendingLinkReferences(engine, a)).toEqual(pending);
  expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE name='extract'")).toEqual(jobsBefore);
  expect((await scoped(b)).pagesProcessed).toBe(1);
  expect(await loadPendingLinkReferences(engine, a)).toHaveLength(0);
  const jobs = await engine.executeRaw<{ data: { sourceId?: string }; status: string }>("SELECT data,status FROM minion_jobs WHERE name='extract'");
  expect(jobs.some(job => job.data.sourceId === a && job.status === 'waiting')).toBe(true);
  expect((await scoped(a)).pagesProcessed).toBe(1);
  expect((await engine.getLinks('people/retry-origin', { sourceId: a })).some(link =>
    link.to_source_id === b && link.to_slug === 'people/retry-target')).toBe(true);
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

test('scoped bare target arrivals wake only the source-local basename origin', async () => {
  const a = 'basename-origin', b = 'basename-foreign';
  await engine.setConfig('link_resolution.global_basename', 'true');
  await engine.setConfig('link_resolution.cross_source', 'true');
  await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES($1,$1,'{\"federated\":true}'::jsonb),($2,$2,'{\"federated\":true}'::jsonb)", [a,b]);
  const scoped = (sourceId: string) => extractStaleFromDB(engine, {
    dryRun: false, jsonMode: true, quiet: true, includeFrontmatter: false, sourceIdFilter: sourceId, catchUp: false,
  });
  try {
    await engine.putPage('people/origin', page('[[bob]]'), { sourceId: a });
    await scoped(a);
    const pending = await loadPendingLinkReferences(engine, a);
    expect(pending).toHaveLength(1);
    await engine.putPage('people/bob', page(), { sourceId: b });
    await scoped(b);
    expect(await loadPendingLinkReferences(engine, a)).toEqual(pending);
    expect(await engine.countStalePagesForExtraction({ sourceId: a })).toBe(0);
    await engine.putPage('people/bob', page(), { sourceId: a });
    await scoped(a);
    expect(await loadPendingLinkReferences(engine, a)).toHaveLength(0);
    expect((await engine.getLinks('people/origin', { sourceId: a })).some(link =>
      link.to_slug === 'people/bob' && link.to_source_id === a)).toBe(true);
  } finally {
    await engine.setConfig('link_resolution.global_basename', 'false');
    await engine.setConfig('link_resolution.cross_source', 'false');
  }
});

test('scoped pending prefilter matches bare basename to a qualified same-source page', async () => {
  const a = 'basename-prefilter-a', b = 'basename-prefilter-b';
  await engine.setConfig('link_resolution.global_basename', 'true');
  await engine.executeRaw(
    "INSERT INTO sources(id,name,config) VALUES($1,$1,'{}'::jsonb),($2,$2,'{}'::jsonb)",
    [a, b],
  );
  try {
    await engine.putPage('people/origin', page('[[bob]]'), { sourceId: a });
    await extractStaleFromDB(engine, {
      dryRun: false, jsonMode: true, quiet: true, includeFrontmatter: false,
      sourceIdFilter: a, catchUp: false,
    });
    const pending = await loadPendingLinkReferences(engine, a);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.reference.candidates[0]!.targetSlug).toBe('bob');

    // Target clause only: origin lives in A, filter is B. Exact slug bob misses
    // people/bob; basename tail must include the row for the probe to run.
    await engine.putPage('people/bob', page(), { sourceId: b });
    const targeting: Awaited<ReturnType<typeof loadPendingLinkReferences>> = [];
    for await (const batch of pendingLinkReferenceBatches(engine, b)) targeting.push(...batch);
    expect(targeting.some(row => row.reference.sourceId === a
      && row.reference.candidates.some(c => c.targetSlug === 'bob'))).toBe(true);

    // Same-source arrival still wakes through the normal scoped extract path.
    await engine.putPage('people/bob', page(), { sourceId: a });
    await extractStaleFromDB(engine, {
      dryRun: false, jsonMode: true, quiet: true, includeFrontmatter: false,
      sourceIdFilter: a, catchUp: false,
    });
    expect(await loadPendingLinkReferences(engine, a)).toHaveLength(0);
    expect((await engine.getLinks('people/origin', { sourceId: a })).some(link =>
      link.to_slug === 'people/bob' && link.to_source_id === a)).toBe(true);
  } finally {
    await engine.setConfig('link_resolution.global_basename', 'false');
  }
});

test('expired readiness deadline preserves dormant registry and watermark', async () => {
  await engine.putPage('people/origin', page('[[people/missing]]')); await drain();
  const rows = await loadPendingLinkReferences(engine);
  expect(await requeueReadyPendingLinks(engine, rows, () => true, undefined, 0)).toBe(0);
  expect(await loadPendingLinkReferences(engine)).toEqual(rows);
  expect(await engine.countStalePagesForExtraction()).toBe(0);
});

test('pending registry deadline reports pendingScanIncomplete for continuation', async () => {
  await engine.putPage('people/origin', page('[[people/missing]]')); await drain();
  expect(await engine.countStalePagesForExtraction()).toBe(0);
  const result = await extractStaleFromDB(engine, {
    dryRun: false, jsonMode: true, quiet: true, includeFrontmatter: false, catchUp: false, timeBudgetMs: 0,
  });
  expect(result.pagesProcessed).toBe(0);
  expect(result.staleRemaining).toBe(0);
  expect(result.pendingScanIncomplete).toBe(true);
  expect(result.pendingScanAfter).toBe('');
});

test('pending registry resume cursor skips the scanned prefix and preserves after on deadline', async () => {
  for (let i = 0; i < 3; i++) {
    await engine.putPage(`people/cursor-${i}`, page('[[people/missing]]'));
  }
  await drain();
  const keys = (await engine.executeRaw<{ key: string }>(
    "SELECT key FROM config WHERE key LIKE 'internal.pending-links.%' ORDER BY key")).map(row => row.key);
  expect(keys.length).toBeGreaterThanOrEqual(3);
  const after = keys[0]!;
  const expired = pendingLinkReferenceBatches(engine, 'default', { deadline: Date.now() - 1, after });
  expect(await expired.next()).toEqual({ value: { incomplete: true, after }, done: true });
  const resumed = await extractStaleFromDB(engine, {
    dryRun: false, jsonMode: true, quiet: true, includeFrontmatter: false, catchUp: false,
    timeBudgetMs: 0, pendingAfter: after,
  });
  expect(resumed.pendingScanIncomplete).toBe(true);
  expect(resumed.pendingScanAfter).toBe(after);
  const live = pendingLinkReferenceBatches(engine, 'default', { after });
  const first = await live.next();
  expect(first.done).toBe(false);
  if (first.done) throw new Error('expected pending registry rows after cursor');
  expect(first.value.every(row => row.key > after)).toBe(true);
});


test('pending registry deadline after a fetched batch still yields before advancing after', async () => {
  for (let i = 0; i < 3; i++) {
    await engine.putPage(`people/yield-${i}`, page('[[people/missing]]'));
  }
  await drain();
  const keys = (await engine.executeRaw<{ key: string }>(
    "SELECT key FROM config WHERE key LIKE 'internal.pending-links.%' ORDER BY key")).map(row => row.key);
  expect(keys.length).toBeGreaterThanOrEqual(3);
  const start = Date.now();
  let beforeDeadline = true;
  const realNow = Date.now;
  Date.now = () => (beforeDeadline ? start : start + 60_000);
  try {
    const iter = pendingLinkReferenceBatches(engine, 'default', { deadline: start + 1_000 });
    const first = await iter.next();
    expect(first.done).toBe(false);
    if (first.done) throw new Error('batch must yield before deadline stop');
    expect(first.value.map(row => row.key).sort()).toEqual([...keys].sort());
    beforeDeadline = false;
    expect(await iter.next()).toEqual({ value: { incomplete: true, after: keys.at(-1)! }, done: true });
  } finally {
    Date.now = realNow;
  }
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
  expect(await iterator.return({ incomplete: false, after: '' })).toEqual({ value: { incomplete: false, after: '' }, done: true });
});

for (const qualified of [false, true]) test(`slash frontmatter aliases do not create exact body targets (qualified=${qualified})`, async () => {
  const targetSource = qualified ? 'alias-target' : 'default';
  if (qualified) {
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES($1,'Alias fixture')", [targetSource]);
    await engine.setConfig('link_resolution.cross_source', 'true');
  }
  const target = `${qualified ? targetSource + ':' : ''}people/old`;
  await engine.putPage('people/origin', page(`[[${target}]]`));
  await drain();
  await engine.putPage('people/new', {
    ...page(), frontmatter: { aliases: ['people/old'] },
  }, { sourceId: targetSource });
  await drain();
  // Force normal extraction too: waking alone cannot resolve this unsupported alias form.
  await engine.executeRaw("UPDATE pages SET links_extracted_at=NULL WHERE source_id='default' AND slug='people/origin'");
  await drain();
  expect(await engine.getLinks('people/origin')).toHaveLength(0);
  expect(await loadPendingLinkReferences(engine)).toHaveLength(1);
  expect(await engine.countStalePagesForExtraction()).toBe(0);
});

test('expired and cancelled pending probes issue no readiness queries', async () => {
  await engine.putPage('people/origin', page('[[people/missing]]')); await drain();
  const rows = await loadPendingLinkReferences(engine);
  const controller = new AbortController(); controller.abort();
  const original = engine.executeRaw;
  engine.executeRaw = async () => { throw new Error('expired probe must not query'); };
  try {
    const expired = pendingLinkReferenceBatches(engine, 'default', { deadline: Date.now() - 1 });
    expect(await expired.next()).toEqual({ value: { incomplete: true, after: '' }, done: true });
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


test('small sync target arrival wakes a pending origin without a stale sweep', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-inline-target-wake-'));
  try {
    mkdirSync(join(dir, 'people'));
    writeFileSync(join(dir, 'people/origin.md'), '---\ntype: person\n---\n[[people/later]]');
    await engine.putPage('people/origin', page('[[people/later]]'));
    const originResult = await extractLinksForSlugs(engine, dir, ['people/origin']);
    expect(originResult.processed).toEqual(['people/origin']);
    await stampExtracted(engine, originResult.processed.map(slug => ({ slug, source_id: 'default' })));
    expect(await loadPendingLinkReferences(engine)).toHaveLength(1);
    expect(await engine.countStalePagesForExtraction()).toBe(0);

    writeFileSync(join(dir, 'people/later.md'), '---\ntype: person\n---\nSynthetic later');
    await engine.putPage('people/later', page());
    const pending = await loadPendingLinkReferences(engine);
    const rejected = spyOn(MinionQueue.prototype, 'add').mockImplementation(async () => { throw new Error('Synthetic inline handoff rejection'); });
    try { await expect(extractLinksForSlugs(engine, dir, ['people/later'])).rejects.toThrow('Synthetic inline handoff rejection'); }
    finally { rejected.mockRestore(); }
    expect(await loadPendingLinkReferences(engine)).toEqual(pending);
    expect(await engine.countStalePagesForExtraction({ sourceId: 'default' })).toBe(2);
    const targetResult = await extractLinksForSlugs(engine, dir, ['people/later']);
    expect(targetResult.processed).toEqual(['people/later']);
    await stampExtracted(engine, targetResult.processed.map(slug => ({ slug, source_id: 'default' })));

    expect(await loadPendingLinkReferences(engine)).toHaveLength(0);
    const jobs = await engine.executeRaw<{ data: { sourceId?: string }; status: string }>("SELECT data,status FROM minion_jobs WHERE name='extract'");
    expect(jobs.some(job => job.data.sourceId === 'default' && job.status === 'waiting')).toBe(true);
    expect(await engine.countStalePagesForExtraction({ sourceId: 'default' })).toBe(1);
    expect((await drain()).pagesProcessed).toBe(1);
    expect((await engine.getLinks('people/origin')).some(link => link.to_slug === 'people/later')).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('inline arrival probe deadline hands off a durable stale-sweep continuation', async () => {
  for (let i = 0; i < 3; i++) await engine.putPage(`people/arrive-${i}`, page('[[people/future]]'));
  await drain();
  expect((await loadPendingLinkReferences(engine)).length).toBeGreaterThanOrEqual(3);
  const incomplete = await probePendingOriginsForArrivedTargets(engine, 'default', {
    globalBasename: false, deadline: Date.now() - 1, after: '',
  });
  expect(incomplete.pendingScanIncomplete).toBe(true);
  expect(incomplete.pendingScanAfter).toBe('');

  const dir = mkdtempSync(join(tmpdir(), 'gbrain-inline-probe-deadline-'));
  try {
    mkdirSync(join(dir, 'people'));
    writeFileSync(join(dir, 'people/future.md'), '---\ntype: person\n---\nSynthetic future');
    await engine.putPage('people/future', page());
    await extractLinksForSlugs(engine, dir, ['people/future'], { deadline: Date.now() - 1 });
    const jobs = await engine.executeRaw<{ data: { reason?: string; sourceId?: string }; status: string }>(
      "SELECT data,status FROM minion_jobs WHERE name='extract' AND data->>'reason'='pending_target_scan_continuation'");
    expect(jobs).toHaveLength(1);
    expect(jobs[0].data.sourceId).toBe('default');
    expect(jobs[0].status).toBe('waiting');
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



test('dry-run B-scoped preview counts a foreign A wakeup', async () => {
  await engine.setConfig('link_resolution.cross_source', 'true');
  await engine.executeRaw(
    "INSERT INTO sources(id,name,config) VALUES('src-a','A','{\"federated\":true}'::jsonb),('src-b','B','{\"federated\":true}'::jsonb) ON CONFLICT(id) DO UPDATE SET config=EXCLUDED.config",
  );
  await engine.putPage('people/origin', page('See [[src-b:people/later]].'), { sourceId: 'src-a' });
  expect(await extractStaleFromDB(engine, {
    dryRun: false, jsonMode: true, quiet: true, includeFrontmatter: false,
    sourceIdFilter: 'src-a', catchUp: false,
  })).toMatchObject({ staleRemaining: 0 });
  await engine.putPage('people/later', page(), { sourceId: 'src-b' });
  await engine.markPagesExtractedBatch(
    [{ slug: 'people/later', source_id: 'src-b' }],
    new Date(Date.now() + 1000).toISOString(),
  );
  const registry = await loadPendingLinkReferences(engine, 'src-a');
  expect(registry).toHaveLength(1);
  const preview = await extractStaleFromDB(engine, {
    dryRun: true, jsonMode: true, quiet: true, includeFrontmatter: false,
    sourceIdFilter: 'src-b', catchUp: false,
  });
  expect(preview).toMatchObject({ staleRemaining: 1, pagesProcessed: 0, linksCreated: 0 });
  expect(await loadPendingLinkReferences(engine, 'src-a')).toEqual(registry);
  expect(await engine.countStalePagesForExtraction({ sourceId: 'src-a' })).toBe(0);
});


test('B-scoped stale sweep wakes A pending on [[B:later]] and enqueues A extract', async () => {
  await engine.setConfig('link_resolution.cross_source', 'true');
  await engine.executeRaw(
    "INSERT INTO sources(id,name,config) VALUES('src-a','A','{\"federated\":true}'::jsonb),('src-b','B','{\"federated\":true}'::jsonb) ON CONFLICT(id) DO UPDATE SET config=EXCLUDED.config",
  );
  await engine.putPage('people/origin', page('See [[src-b:people/later]].'), { sourceId: 'src-a' });
  expect(await extractStaleFromDB(engine, {
    dryRun: false, jsonMode: true, quiet: true, includeFrontmatter: false,
    sourceIdFilter: 'src-a', catchUp: false,
  })).toMatchObject({ staleRemaining: 0 });
  expect(await loadPendingLinkReferences(engine, 'src-a')).toHaveLength(1);
  expect(await loadPendingLinkReferences(engine, 'src-b')).toHaveLength(1);

  await engine.putPage('people/later', page(), { sourceId: 'src-b' });
  await engine.markPagesExtractedBatch(
    [{ slug: 'people/later', source_id: 'src-b' }],
    new Date(Date.now() + 1000).toISOString(),
  );

  // Origin-only filter would miss A's pending; targeting filter must see it.
  const targeting: Awaited<ReturnType<typeof loadPendingLinkReferences>> = [];
  for await (const batch of pendingLinkReferenceBatches(engine, 'src-b', {})) {
    targeting.push(...batch);
  }
  expect(targeting.some(row => row.reference.sourceId === 'src-a')).toBe(true);

  const beforeJobs = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM minion_jobs WHERE name='extract'");
  const result = await extractStaleFromDB(engine, {
    dryRun: false, jsonMode: true, quiet: true, includeFrontmatter: false,
    sourceIdFilter: 'src-b', catchUp: false,
  });
  expect(result.pagesProcessed).toBe(0); // B itself was already stamped
  expect(await loadPendingLinkReferences(engine, 'src-a')).toHaveLength(0);
  expect(await engine.countStalePagesForExtraction({ sourceId: 'src-a' })).toBe(1);
  const jobs = await engine.executeRaw<{ idempotency_key: string | null; data: Record<string, unknown> }>(
    "SELECT idempotency_key, data FROM minion_jobs WHERE name='extract' ORDER BY id",
  );
  expect(jobs.length).toBeGreaterThan(beforeJobs[0]!.n);
  expect(jobs.some(job =>
    job.idempotency_key === 'extract-stale:src-a:pending-target:src-b'
    || (job.data?.sourceId === 'src-a' && job.data?.reason === 'pending_cross_source_target'),
  )).toBe(true);

  await extractStaleFromDB(engine, {
    dryRun: false, jsonMode: true, quiet: true, includeFrontmatter: false,
    sourceIdFilter: 'src-a', catchUp: false,
  });
  expect((await engine.getLinks('people/origin', { sourceId: 'src-a' }))
    .some(link => link.to_slug === 'people/later' && link.to_source_id === 'src-b')).toBe(true);
});


test('B-scoped sweep wakes unqualified pending when default target arrives in B', async () => {
  await engine.setConfig('link_resolution.cross_source', 'true');
  await engine.setConfig('sources.default', 'src-b');
  await engine.executeRaw(
    "INSERT INTO sources(id,name,config) VALUES('src-a','A','{\"federated\":true}'::jsonb),('src-b','B','{\"federated\":true}'::jsonb) ON CONFLICT(id) DO UPDATE SET config=EXCLUDED.config",
  );
  await engine.putPage('people/origin', page('See [[people/later]].'), { sourceId: 'src-a' });
  expect(await extractStaleFromDB(engine, {
    dryRun: false, jsonMode: true, quiet: true, includeFrontmatter: false,
    sourceIdFilter: 'src-a', catchUp: false,
  })).toMatchObject({ staleRemaining: 0 });
  expect(await loadPendingLinkReferences(engine, 'src-a')).toHaveLength(1);

  await engine.putPage('people/later', page(), { sourceId: 'src-b' });
  await engine.markPagesExtractedBatch(
    [{ slug: 'people/later', source_id: 'src-b' }],
    new Date(Date.now() + 1000).toISOString(),
  );

  await extractStaleFromDB(engine, {
    dryRun: false, jsonMode: true, quiet: true, includeFrontmatter: false,
    sourceIdFilter: 'src-b', catchUp: false,
  });
  expect(await loadPendingLinkReferences(engine, 'src-a')).toHaveLength(0);
  expect(await engine.countStalePagesForExtraction({ sourceId: 'src-a' })).toBe(1);
  const jobs = await engine.executeRaw<{ idempotency_key: string | null }>(
    "SELECT idempotency_key FROM minion_jobs WHERE name='extract'",
  );
  expect(jobs.some(job => job.idempotency_key === 'extract-stale:src-a:pending-target:src-b')).toBe(true);

  await extractStaleFromDB(engine, {
    dryRun: false, jsonMode: true, quiet: true, includeFrontmatter: false,
    sourceIdFilter: 'src-a', catchUp: false,
  });
  expect((await engine.getLinks('people/origin', { sourceId: 'src-a' }))
    .some(link => link.to_slug === 'people/later' && link.to_source_id === 'src-b')).toBe(true);
});

test('failed foreign wake enqueue leaves pending durable for a later B sweep', async () => {
  await engine.setConfig('link_resolution.cross_source', 'true');
  await engine.executeRaw(
    "INSERT INTO sources(id,name,config) VALUES('src-a','A','{\"federated\":true}'::jsonb),('src-b','B','{\"federated\":true}'::jsonb) ON CONFLICT(id) DO UPDATE SET config=EXCLUDED.config",
  );
  await engine.putPage('people/origin', page('See [[src-b:people/later]].'), { sourceId: 'src-a' });
  await extractStaleFromDB(engine, {
    dryRun: false, jsonMode: true, quiet: true, includeFrontmatter: false,
    sourceIdFilter: 'src-a', catchUp: false,
  });
  await engine.putPage('people/later', page(), { sourceId: 'src-b' });
  await engine.markPagesExtractedBatch(
    [{ slug: 'people/later', source_id: 'src-b' }],
    new Date(Date.now() + 1000).toISOString(),
  );

  const { MinionQueue } = await import('../src/core/minions/queue.ts');
  const add = spyOn(MinionQueue.prototype, 'add');
  add.mockImplementation(async () => { throw new Error('queue unavailable'); });
  try {
    await expect(extractStaleFromDB(engine, {
      dryRun: false, jsonMode: true, quiet: true, includeFrontmatter: false,
      sourceIdFilter: 'src-b', catchUp: false,
    })).rejects.toThrow('queue unavailable');
  } finally {
    add.mockRestore();
  }
  expect(await loadPendingLinkReferences(engine, 'src-a')).toHaveLength(1);
  expect(await engine.countStalePagesForExtraction({ sourceId: 'src-a' })).toBe(1);

  await extractStaleFromDB(engine, {
    dryRun: false, jsonMode: true, quiet: true, includeFrontmatter: false,
    sourceIdFilter: 'src-b', catchUp: false,
  });
  expect(await loadPendingLinkReferences(engine, 'src-a')).toHaveLength(0);
  expect(await engine.countStalePagesForExtraction({ sourceId: 'src-a' })).toBe(1);
});

for (const qualified of [true, false]) test(`foreign origin is stale before an eager queued worker reads it (qualified=${qualified})`, async () => {
  const a = 'pending-race-origin', b = 'pending-race-target';
  await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES($1,$1,'{\"federated\":true}'::jsonb),($2,$2,'{}'::jsonb)", [a,b]);
  await engine.setConfig('link_resolution.cross_source', 'true');
  const scoped = (sourceId: string, dryRun = false) => extractStaleFromDB(engine, {
    dryRun, jsonMode: true, quiet: true, includeFrontmatter: false, sourceIdFilter: sourceId, catchUp: false,
  });
  await engine.putPage('people/race-origin', page(qualified ? `[[${b}:people/race-later]]` : '[[people/race-later]]'), { sourceId: a });
  await scoped(a);
  await engine.putPage('people/race-later', page(), { sourceId: b });
  const pending = await loadPendingLinkReferences(engine, a);
  // B stale page + foreign A wakeup.
  expect((await scoped(b, true)).staleRemaining).toBe(2);
  expect(await loadPendingLinkReferences(engine, a)).toEqual(pending);
  const original = MinionQueue.prototype.add;
  let eagerProcessed = 0;
  const add = spyOn(MinionQueue.prototype, 'add').mockImplementation(async function(this: MinionQueue, ...args: Parameters<MinionQueue['add']>) {
    eagerProcessed += (await scoped(a)).pagesProcessed;
    return original.apply(this, args);
  });
  try { expect((await scoped(b)).pagesProcessed).toBe(1); }
  finally { add.mockRestore(); }
  expect(eagerProcessed).toBe(1);
  expect(await loadPendingLinkReferences(engine, a)).toHaveLength(0);
  expect(await engine.countStalePagesForExtraction({ sourceId: a })).toBe(0);
  expect((await engine.getLinks('people/race-origin', { sourceId: a })).some(link =>
    link.to_source_id === b && link.to_slug === 'people/race-later')).toBe(true);
});

// Advance only at the real per-origin deadline gate, not during fixture setup or SQL.
function pendingProbeClock(step: number) {
  let clock = 0;
  const spy = spyOn(Date, 'now').mockImplementation(() => {
    if (new Error().stack?.includes('requeueReadyPendingLinks')) clock += step;
    return clock;
  });
  return spy;
}

async function pendingFixture(count: number) {
  for (let i = 0; i < count; i++) await engine.putPage(`people/budget-${i}`, page(`[[people/future-${i}]]`));
  await drain();
  return loadPendingLinkReferences(engine);
}

async function pendingExtractHandler() {
  const handlers = new Map<string, (job: any) => Promise<any>>();
  await registerBuiltinHandlers({ register: (name: string, handler: (job: any) => Promise<any>) => handlers.set(name, handler) } as never,
    engine, { quiet: true });
  return handlers.get('extract')!;
}

test('partial short pending batch resumes after handled origins instead of claiming completion', async () => {
  const rows = await pendingFixture(8);
  const clock = pendingProbeClock(1);
  try {
    const first = await extractStaleFromDB(engine, {
      dryRun: false, jsonMode: true, quiet: true, catchUp: false, includeFrontmatter: false, timeBudgetMs: 5,
    });
    expect(first.pendingScanIncomplete).toBe(true);
    expect(first.pendingScanAfter).toBe(rows[2].key);
    const rest = await extractStaleFromDB(engine, {
      dryRun: false, jsonMode: true, quiet: true, catchUp: true, includeFrontmatter: false,
      pendingAfter: first.pendingScanAfter,
    });
    expect(rest.pendingScanIncomplete).not.toBe(true);
    expect(await loadPendingLinkReferences(engine)).toHaveLength(8);
  } finally { clock.mockRestore(); }
});

test('queued pending budget continuations reach a ready tail beyond a dormant full batch', async () => {
  const rows = await pendingFixture(105);
  const tail = rows.at(-1)!;
  await engine.putPage(tail.reference.candidates[0].targetSlug, page());
  await engine.executeRaw('UPDATE pages SET links_extracted_at=updated_at WHERE slug=$1', [tail.reference.candidates[0].targetSlug]);
  const handler = await pendingExtractHandler(), queue = new MinionQueue(engine);
  let job = await queue.add('extract', { stale: true, sourceId: 'default' });
  const clock = pendingProbeClock(STALE_TIME_BUDGET_MS / 8);
  let rounds = 0;
  try {
    for (; rounds < 25; rounds++) {
      await handler(job);
      if ((await engine.getLinks(tail.reference.slug)).some(link => link.to_slug === tail.reference.candidates[0].targetSlug)) break;
      const next = (await engine.executeRaw<{ id: number; data: Record<string, unknown> }>(
        "SELECT id,data FROM minion_jobs WHERE name='extract' AND data->>'continuation_of'=$1 ORDER BY id DESC LIMIT 1", [String(job.id)]))[0];
      expect(next).toBeDefined();
      expect(typeof next.data.pending_after).toBe('string');
      expect(String(next.data.pending_after) > String(job.data.pending_after ?? '')).toBe(true);
      job = next as typeof job;
    }
    expect(rounds).toBeLessThan(25);
    expect((await engine.getLinks(tail.reference.slug)).some(link => link.to_slug === tail.reference.candidates[0].targetSlug)).toBe(true);
  } finally { clock.mockRestore(); }
}, 120_000);

test('queued pending scan with no cursor progress fails for worker retry instead of going dormant', async () => {
  await pendingFixture(2);
  const handler = await pendingExtractHandler(), queue = new MinionQueue(engine);
  const job = await queue.add('extract', { stale: true, sourceId: 'default' });
  const clock = pendingProbeClock(STALE_TIME_BUDGET_MS);
  try {
    await expect(handler(job)).rejects.toThrow(/incomplete without cursor progress/);
    // No same-cursor successor chain; worker retry of this job is the durable path.
    expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE data->>'continuation_of'=$1", [String(job.id)])).toHaveLength(0);
  } finally { clock.mockRestore(); }
});

test('queued pending continuation enqueue failure fails the extract job', async () => {
  await pendingFixture(105);
  const handler = await pendingExtractHandler(), queue = new MinionQueue(engine);
  const job = await queue.add('extract', { stale: true, sourceId: 'default' });
  const clock = pendingProbeClock(STALE_TIME_BUDGET_MS / 8);
  const add = spyOn(MinionQueue.prototype, 'add').mockRejectedValue(new Error('Synthetic continuation enqueue failure'));
  try {
    await expect(handler(job)).rejects.toThrow('Synthetic continuation enqueue failure');
  } finally {
    add.mockRestore();
    clock.mockRestore();
  }
  expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE data->>'continuation_of'=$1", [String(job.id)])).toHaveLength(0);
});


test('legacy malformed registry keys resume past a consumed invalid prefix', async () => {
  const [tail] = await pendingFixture(1);
  for (let i = 0; i < 100; i++) await engine.setConfig(`internal.pending-links.000-legacy-${String(i).padStart(3, '0')}`,
    JSON.stringify({ sourceId: 'default', candidates: [] }));
  await engine.putPage(tail.reference.candidates[0].targetSlug, page());
  await engine.executeRaw('UPDATE pages SET links_extracted_at=updated_at WHERE slug=$1', [tail.reference.candidates[0].targetSlug]);
  let clock = 0;
  const now = spyOn(Date, 'now').mockImplementation(() => clock);
  const raw = engine.executeRaw;
  engine.executeRaw = async function<T>(sql: string, params?: any[]) {
    const result = await raw.call(this, sql, params);
    if (sql.includes('SELECT key,value FROM config') && params?.[2]) clock = 100;
    return result as T[];
  };
  let first: Awaited<ReturnType<typeof extractStaleFromDB>>;
  try {
    first = await extractStaleFromDB(engine, { dryRun: false, jsonMode: true, quiet: true,
      catchUp: false, includeFrontmatter: false, timeBudgetMs: 100 });
    expect(first.pendingScanIncomplete).toBe(true);
    expect(first.pendingScanAfter).toBe('internal.pending-links.000-legacy-099');
  } finally { engine.executeRaw = raw; now.mockRestore(); }
  await extractStaleFromDB(engine, { dryRun: false, jsonMode: true, quiet: true,
    catchUp: true, includeFrontmatter: false, pendingAfter: first!.pendingScanAfter });
  expect((await engine.getLinks(tail.reference.slug)).some(link => link.to_slug === tail.reference.candidates[0].targetSlug)).toBe(true);
});

test('cancelled pending job never publishes a cursor after a durable origin handoff', async () => {
  const [tail] = await pendingFixture(1);
  await engine.putPage(tail.reference.candidates[0].targetSlug, page());
  await engine.executeRaw('UPDATE pages SET links_extracted_at=updated_at WHERE slug=$1', [tail.reference.candidates[0].targetSlug]);
  const handler = await pendingExtractHandler(), queue = new MinionQueue(engine);
  const job = await queue.add('extract', { stale: true, sourceId: 'default' });
  const controller = new AbortController(), raw = engine.executeRaw;
  engine.executeRaw = async function<T>(sql: string, params?: any[]) {
    const result = await raw.call(this, sql, params);
    if (sql.includes('WITH ready AS') && result.length) controller.abort(new Error('Synthetic post-handoff cancel'));
    return result as T[];
  };
  try { await expect(handler({ ...job, signal: controller.signal })).rejects.toThrow('Synthetic post-handoff cancel'); }
  finally { engine.executeRaw = raw; }
  expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE data->>'continuation_of'=$1", [String(job.id)])).toHaveLength(0);
  expect(await engine.countStalePagesForExtraction()).toBe(1);
  await drain();
  expect((await engine.getLinks(tail.reference.slug)).some(link => link.to_slug === tail.reference.candidates[0].targetSlug)).toBe(true);
});


test('inline target probe completed batch durably resumes after default budget exhaustion', async () => {
  const rows = await pendingFixture(105), tail = rows.at(-1)!;
  await engine.putPage(tail.reference.candidates[0].targetSlug, page());
  const raw = engine.executeRaw;
  // Preserve the receiver: queueing runs through a transaction-scoped engine.
  engine.executeRaw = async function<T = Record<string, unknown>>(
    this: PGLiteEngine, sql: string, params?: unknown[], opts?: { signal?: AbortSignal },
  ): Promise<T[]> {
    const result = await raw.call(this,sql,params,opts) as T[];
    if (sql.includes('SELECT key,value FROM config') && params?.[2]) {
      await Bun.sleep(INLINE_PENDING_PROBE_BUDGET_MS + 100);
    }
    return result;
  };
  try { await probePendingOriginsForArrivedTargets(engine,'default',{ globalBasename: false }); }
  finally { engine.executeRaw = raw; }
  const [job] = await engine.executeRaw<{ id: number; data: { pending_after: string } }>(
    "SELECT id,data FROM minion_jobs WHERE data->>'reason'='pending_target_scan_continuation'");
  expect(job).toBeDefined(); expect(job.data.pending_after).toBe(rows[99].key);
  expect(await loadPendingLinkReferences(engine)).toHaveLength(105);
  await (await pendingExtractHandler())(job);
  expect((await engine.getLinks(tail.reference.slug)).some(link => link.to_slug === tail.reference.candidates[0].targetSlug)).toBe(true);
  expect((await loadPendingLinkReferences(engine)).some(row => row.key === tail.key)).toBe(false);
},120_000);

test('expired inline caller budget queues untouched arrivals and identical waiting retries coalesce', async () => {
  const [row] = await pendingFixture(1), target = row.reference.candidates[0].targetSlug;
  const dir = mkdtempSync(join(tmpdir(),'gbrain-inline-budget-'));
  try {
    mkdirSync(join(dir,'people'));
    writeFileSync(join(dir,target+'.md'),'---\ntype: person\n---\nSynthetic target');
    await engine.putPage(target,page());
    for (let retry = 0; retry < 2; retry++) {
      const result = await extractLinksForSlugs(engine,dir,[target],{ deadline: Date.now()-1 });
      expect(result.processed).toEqual([target]);
    }
    const jobs = await engine.executeRaw<{ id: number; data: { pending_after: string } }>(
      "SELECT id,data FROM minion_jobs WHERE data->>'reason'='pending_target_scan_continuation'");
    expect(jobs).toHaveLength(1); expect(jobs[0].data.pending_after).toBe('');
    expect(await loadPendingLinkReferences(engine)).toHaveLength(1);
    await (await pendingExtractHandler())(jobs[0]);
    expect((await engine.getLinks(row.reference.slug)).some(link => link.to_slug === target)).toBe(true);
  } finally { rmSync(dir,{ recursive: true,force: true }); }
});

test('inline continuation rejection and cancellation retain registry for a later retry', async () => {
  const rows = await pendingFixture(1);
  const rejected = spyOn(MinionQueue.prototype,'add').mockRejectedValue(new Error('Synthetic continuation rejection'));
  try { await expect(probePendingOriginsForArrivedTargets(engine,'default',{ globalBasename: false,deadline: -1 })).rejects.toThrow('Synthetic continuation rejection'); }
  finally { rejected.mockRestore(); }
  expect(await loadPendingLinkReferences(engine)).toEqual(rows);
  const controller = new AbortController(); controller.abort(new Error('Synthetic probe cancellation'));
  await expect(probePendingOriginsForArrivedTargets(engine,'default',{ globalBasename: false,signal: controller.signal })).rejects.toThrow('Synthetic probe cancellation');
  expect(await loadPendingLinkReferences(engine)).toEqual(rows);
  expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE name='extract'")).toHaveLength(0);
  await probePendingOriginsForArrivedTargets(engine,'default',{ globalBasename: false,deadline: -1 });
  expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE data->>'reason'='pending_target_scan_continuation'")).toHaveLength(1);
});

test('complete inline pending scans do not queue continuation generations', async () => {
  await pendingFixture(2);
  for (let retry = 0; retry < 2; retry++) await probePendingOriginsForArrivedTargets(engine,'default',{ globalBasename: false });
  expect(await loadPendingLinkReferences(engine)).toHaveLength(2);
  expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE name='extract'")).toHaveLength(0);
});


test('default inline budget exhausted during metadata queues an empty cursor without losing arrivals', async () => {
  const rows = await pendingFixture(1);
  const get = engine.getConfig;
  let waited = false;
  engine.getConfig = async function(this: PGLiteEngine, key: string) {
    const result = await get.call(this,key);
    if (!waited) { waited = true; await Bun.sleep(INLINE_PENDING_PROBE_BUDGET_MS + 100); }
    return result;
  };
  try { await probePendingOriginsForArrivedTargets(engine,'default',{ globalBasename: false }); }
  finally { engine.getConfig = get; }
  expect(await loadPendingLinkReferences(engine)).toEqual(rows);
  const [job] = await engine.executeRaw<{ data: { pending_after: string } }>("SELECT data FROM minion_jobs WHERE data->>'reason'='pending_target_scan_continuation'");
  expect(job).toBeDefined(); expect(job.data.pending_after).toBe('');
});
