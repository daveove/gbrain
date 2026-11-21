import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { effectiveLinkExtractorWatermark } from '../src/core/link-extraction-watermark.ts';
import { dailyMemoryExtractTargets, ensureDailyMemorySource } from '../src/core/cycle/daily-memory.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  await ensureDailyMemorySource(engine);
});

const OLD_CANDIDATES = `SELECT slug FROM pages JOIN sources s ON s.id=pages.source_id
  WHERE source_id=$1 AND s.archived IS NOT TRUE AND deleted_at IS NULL
  AND (s.config @> '{"system_index":true}'::jsonb
    OR (s.name='Dream cycle indexes' AND s.config @> '{"federated":false}'::jsonb))
  AND frontmatter @> '{"dream_generated":true}'::jsonb
  AND (slug ~ '^daily-memory/[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR (slug LIKE 'source-records/%'
    AND frontmatter ?& ARRAY['source_record_id','source_record_type','source_record_ref']))`;
const recordFrontmatter = { dream_generated: true, source_record_id: null, source_record_type: 'fixture', source_record_ref: 'fixture' };
const payloadBytes = (rows: unknown[]) => Buffer.byteLength(JSON.stringify(rows));

async function oldTargets(onlySlugs?: string[]) {
  const candidates = await engine.executeRaw<{ slug: string }>(
    `${OLD_CANDIDATES}${onlySlugs ? ' AND slug=ANY($2::text[])' : ''} ORDER BY slug`,
    onlySlugs ? ['dream', onlySlugs] : ['dream']);
  const slugs = candidates.map(row => row.slug);
  const batches: string[][] = [];
  const bytes = [payloadBytes(candidates)];
  if (slugs.length) {
    const versionTs = await effectiveLinkExtractorWatermark(engine);
    let afterPageId = 0;
    for (;;) {
      const stale = await engine.listStalePagesForExtraction({ sourceId: 'dream', versionTs, slugs, batchSize: 100, afterPageId });
      bytes.push(payloadBytes(stale));
      if (!stale.length) break;
      batches.push(stale.map(row => row.slug));
      afterPageId = stale[stale.length - 1]!.id;
    }
  }
  return { candidates, batches, bytes, slugs: batches.flat().sort() };
}

async function insertPage(slug: string, frontmatter: Record<string, unknown> = recordFrontmatter, sourceId = 'dream') {
  await engine.executeRaw(`INSERT INTO pages (source_id,slug,type,title,compiled_truth,frontmatter,updated_at,links_extracted_at)
    VALUES ($1,$2,'note','Fixture',repeat('x',2048),$3::jsonb,'2100-01-01','2100-01-02')`,
  [sourceId, slug, frontmatter]);
}

test('stale target SQL equals the old selection without current rows or page bodies', async () => {
  await engine.executeRaw(`INSERT INTO pages (source_id,slug,type,title,compiled_truth,frontmatter,updated_at,links_extracted_at)
    SELECT 'dream','source-records/fixture/' || lpad(n::text,4,'0'),'note','Fixture',repeat('x',2048),
      $1::jsonb,'2100-01-01',CASE WHEN n < 205 THEN NULL ELSE '2100-01-02'::timestamptz END
    FROM generate_series(0,1204) n ORDER BY n DESC`, [recordFrontmatter]);
  await insertPage('daily-memory/2099-12-31', { dream_generated: true });
  await insertPage('source-records/fixture/version');
  await insertPage('source-records/fixture/edited');
  await insertPage('source-records/fixture/wanted-slug');
  await insertPage('source-records/fixture/wanted-name');
  await insertPage('source-records/fixture/wanted-wrong-source');
  await insertPage('source-records/fixture/wanted-deleted');
  await insertPage('source-records/fixture/wanted-checked');
  await insertPage('source-records/fixture/quarantine', { ...recordFrontmatter, quarantine: {} });
  await insertPage('source-records/fixture/deleted');
  await insertPage('daily-memory/not-a-date', { dream_generated: true });
  await insertPage('daily-memory/2099-12-30', { dream_generated: 'true' });
  await insertPage('daily-memory/2099-12-29', {});
  await insertPage('notes/not-an-index', { dream_generated: true });
  for (const key of ['source_record_id', 'source_record_type', 'source_record_ref']) {
    const frontmatter: Record<string, unknown> = { ...recordFrontmatter };
    delete frontmatter[key];
    await insertPage(`source-records/fixture/missing-${key}`, frontmatter);
  }
  await insertPage('source-records/fixture/other-source', recordFrontmatter, 'default');
  await engine.setConfig('_internal.link_extraction_generation', '2099-12-31T00:00:00Z');
  await engine.executeRaw(`UPDATE pages SET links_extracted_at=CASE
      WHEN slug='source-records/fixture/version' THEN '2099-12-30'::timestamptz
      WHEN slug='source-records/fixture/edited' THEN '2099-12-31'::timestamptz
      ELSE NULL END
    WHERE slug IN ('source-records/fixture/version','source-records/fixture/edited',
      'daily-memory/2099-12-31','source-records/fixture/quarantine','source-records/fixture/deleted')
      OR source_id='default' OR NOT (frontmatter @> '{"dream_generated":true}'::jsonb)
      OR slug LIKE '%missing-%' OR slug IN ('notes/not-an-index','daily-memory/not-a-date')`);
  await engine.executeRaw("UPDATE pages SET updated_at='2100-01-03' WHERE slug='source-records/fixture/edited'");
  await engine.executeRaw("UPDATE pages SET deleted_at=now() WHERE slug='source-records/fixture/deleted'");
  for (const slug of ['targets/arrived', 'targets/deleted', 'targets/checked']) await insertPage(slug, {}, 'default');
  await engine.executeRaw("UPDATE pages SET deleted_at=now() WHERE source_id='default' AND slug='targets/deleted'");
  for (const [origin, kind, source, ref, checked] of [
    ['wanted-slug', 'slug', 'default', 'targets/arrived', '2099-12-31'],
    ['wanted-name', 'name', 'default', 'arrived', '2099-12-31'],
    ['wanted-wrong-source', 'slug', 'dream', 'targets/arrived', '2099-12-31'],
    ['wanted-deleted', 'slug', 'default', 'targets/deleted', '2099-12-31'],
    ['wanted-checked', 'slug', 'default', 'targets/checked', '2100-01-01'],
  ]) {
    await engine.executeRaw(`INSERT INTO wanted_links
      (origin_page_id,source_id,producer,ref_kind,target_source_id,target_ref,checked_at)
      SELECT id,'dream','body',$2,$3,$4,$5::timestamptz FROM pages WHERE source_id='dream' AND slug=$1`,
    [`source-records/fixture/${origin}`, kind, source, ref, checked]);
  }
  const expected = await oldTargets();
  expect(expected.slugs).toHaveLength(210);
  expect(expected.slugs).toContain('daily-memory/2099-12-31');
  for (const suffix of ['version', 'edited', 'wanted-slug', 'wanted-name']) {
    expect(expected.slugs).toContain(`source-records/fixture/${suffix}`);
  }
  const executeRaw = engine.executeRaw;
  const batches: string[][] = [];
  const bytes: number[] = [];
  engine.executeRaw = (async function(this: PGLiteEngine, sql: string, params?: unknown[]) {
    const rows = await executeRaw.call(this, sql, params);
    if (sql.includes('FROM pages JOIN sources s')) {
      batches.push((rows as { slug: string }[]).map(row => row.slug));
      bytes.push(payloadBytes(rows));
      expect(rows.length).toBeLessThanOrEqual(100);
      for (const row of rows as { slug: string }[]) {
        expect(Object.keys(row).sort()).toEqual(['id', 'slug']);
        expect(expected.slugs).toContain(row.slug);
      }
    }
    return rows;
  }) as typeof engine.executeRaw;
  try {
    expect(await dailyMemoryExtractTargets(engine)).toEqual(expected.slugs);
  } finally { engine.executeRaw = executeRaw; }
  expect(batches).toEqual([...expected.batches, []]);
  expect(bytes.reduce((sum, n) => sum + n, 0)).toBeLessThan(expected.bytes.reduce((sum, n) => sum + n, 0));
  console.log('DAV-7473 fixture estimate (JSON UTF-8, not protocol bytes)', JSON.stringify({
    before: { rows: [expected.candidates.length, ...expected.batches.map(batch => batch.length), 0], bytes: expected.bytes },
    after: { rows: batches.map(batch => batch.length), bytes },
  }));
  const subset = [expected.slugs[209]!, expected.slugs[0]!, expected.slugs[0]!, 'source-records/fixture/1204', 'daily-memory/2099-12-29'];
  expect(await dailyMemoryExtractTargets(engine, subset)).toEqual((await oldTargets(subset)).slugs);
  expect(await dailyMemoryExtractTargets(engine, ['does-not-exist'])).toEqual([]);
}, 60_000);

test('stale target selection preserves current and legacy source ownership', async () => {
  await insertPage('daily-memory/2099-12-31', { dream_generated: true });
  await engine.executeRaw("UPDATE pages SET links_extracted_at=NULL WHERE source_id='dream'");
  for (const [name, config, archived, owned] of [
    ['Other name', { system_index: true }, false, true],
    ['Dream cycle indexes', { federated: false }, false, true],
    ['Dream cycle indexes', { federated: true }, false, false],
    ['Other name', { federated: false }, false, false],
    ['Dream cycle indexes', { system_index: 'true' }, false, false],
    ['Dream cycle indexes', {}, false, false],
    ['Dream cycle indexes', { system_index: true }, true, false],
  ] as const) {
    await engine.executeRaw('UPDATE sources SET name=$1,config=$2::jsonb,archived=$3 WHERE id=$4', [name, config, archived, 'dream']);
    const expected = await oldTargets();
    expect(expected.slugs).toEqual(owned ? ['daily-memory/2099-12-31'] : []);
    expect(await dailyMemoryExtractTargets(engine)).toEqual(expected.slugs);
  }
});

test('an empty exact target set performs no database work', async () => {
  const raw = spyOn(engine, 'executeRaw');
  const config = spyOn(engine, 'getConfig');
  try {
    expect(await dailyMemoryExtractTargets(engine, [])).toEqual([]);
    expect(raw).not.toHaveBeenCalled();
    expect(config).not.toHaveBeenCalled();
  } finally {
    raw.mockRestore();
    config.mockRestore();
  }
});
