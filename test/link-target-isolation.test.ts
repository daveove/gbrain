import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { reconcileSourceLinks, resolveCandidateSources } from '../src/core/link-reconciliation.ts';
import { parseSchemaPackManifest } from '../src/core/schema-pack/manifest-v1.ts';
import { buildGazetteer, findMentionedEntities } from '../src/core/by-mention.ts';
import { collectWantedLinks } from '../src/core/wanted-links.ts';
import { listWantedPages, possibleWantedRows, replaceWantedLinks } from '../src/core/wanted-links-store.ts';
import { extractTimelineFromMeetings } from '../src/core/extract-timeline-from-meetings.ts';
import { runExtract, extractStaleFromDB } from '../src/commands/extract.ts';
import { prepareAutomaticLinks } from '../src/core/persistence/links-preparation.ts';
import { runMentionPass } from '../src/core/mentions/pass.ts';
import { readReferrerPage } from '../src/core/mentions/referrers.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const isolated = 'private-source';
const secretSlug = 'people/confidential-example';
const secretTitle = 'Confidential Example';
const secretSnippet = 'PRIVATE TARGET EXCERPT';
const pack = parseSchemaPackManifest({
  api_version: 'gbrain-schema-pack-v1', name: 'isolation-fixture', version: '1.0.0', extends: null,
  page_types: [], link_types: [{ name: 'owned_by' }],
  frontmatter_links: [{ page_type: 'note', fields: ['owner'], link_type: 'owned_by' }],
});

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw(`UPDATE sources SET config = '{"federated":true}'::jsonb WHERE id = 'default'`);
  await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES
    ('private-source', 'Private', '{"federated":false}'::jsonb),
    ('public-source', 'Public', '{"federated":true}'::jsonb)`);
  await engine.putPage(secretSlug, { type: 'person', title: secretTitle, compiled_truth: secretSnippet }, { sourceId: isolated });
});

async function seedOrigin(body = `[[${isolated}:${secretSlug}]]`, sourceId = 'default') {
  await engine.putPage('notes/origin', { type: 'note', title: 'Origin', compiled_truth: body }, { sourceId });
}

async function assertNoTargetText(value: unknown) {
  const text = JSON.stringify(value);
  for (const secret of [secretSlug, secretTitle, secretSnippet]) expect(text).not.toContain(secret);
}

async function storedEdges() {
  return engine.executeRaw(`SELECT f.slug AS from_slug, t.slug AS to_slug, t.source_id AS target_source, l.context
    FROM links l JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id ORDER BY l.id`);
}

describe('DAV-8075 isolated link targets', () => {
  for (const crossSource of [false, true]) {
    test(`reconciliation omits blocked targets and wanted text with global cross-source ${crossSource}`, async () => {
      await engine.setConfig('link_resolution.cross_source', String(crossSource));
      await seedOrigin(`[[${isolated}:${secretSlug}]] and [[${secretSlug}]]`);
      await engine.executeRaw(`UPDATE pages SET frontmatter = $1::jsonb WHERE source_id = 'default'`,
        [{ owner: `${isolated}:${secretSlug}` }]);
      const result = await reconcileSourceLinks(engine, 'default', { pack });
      expect(result.ok).toBe(true);
      expect(result.pagesProcessed).toBe(1);
      expect(result.linksCreated).toBe(0);
      expect(result.unresolved).toEqual([]);
      expect(await storedEdges()).toEqual([]);
      expect(await engine.executeRaw('SELECT target_ref, context FROM wanted_links')).toEqual([]);
      await assertNoTargetText(result);
      await assertNoTargetText(await listWantedPages(engine, { sourceId: 'default', limit: 20, offset: 0 }));
    });
  }

  test('same-source links and self links inside an isolated source still resolve', async () => {
    await seedOrigin(`[[${secretSlug}]] and [[notes/origin]]`, isolated);
    const result = await reconcileSourceLinks(engine, isolated, { pack });
    expect(result.ok).toBe(true);
    expect(result.linksCreated).toBe(1);
    await engine.addLink('notes/origin', 'notes/origin', '', 'mentions', 'manual', undefined, undefined,
      { fromSourceId: isolated, toSourceId: isolated });
    expect((await storedEdges()).map(row => row.target_source)).toEqual([isolated, isolated]);
  });

  test('qualified federated-to-federated links keep their existing default behavior', async () => {
    await engine.putPage('people/public-example', { type: 'person', title: 'Public Example', compiled_truth: 'Public' }, { sourceId: 'public-source' });
    await seedOrigin('[[public-source:people/public-example]]');
    const result = await reconcileSourceLinks(engine, 'default', { pack });
    expect(result.ok).toBe(true);
    expect(await storedEdges()).toMatchObject([{ to_slug: 'people/public-example', target_source: 'public-source' }]);
  });

  test('the explicit switch still permits unset targets and isolated-origin outbound links', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('unset-source', 'Unset')`);
    await engine.putPage('people/unset-example', { type: 'person', title: 'Unset Example', compiled_truth: 'Unset profile' }, { sourceId: 'unset-source' });
    await engine.setConfig('link_resolution.cross_source', 'true');
    await seedOrigin('[[people/unset-example]]', isolated);
    const result = await reconcileSourceLinks(engine, isolated, { pack });
    expect(result.ok).toBe(true);
    expect(await storedEdges()).toMatchObject([{ to_slug: 'people/unset-example', target_source: 'unset-source' }]);
  });

  test('a hidden lexicographic twin cannot mask a federated target', () => {
    const candidate = { targetSlug: secretSlug, linkType: 'mentions', context: secretTitle };
    const endpoints = new Map([['notes/origin', ['default']], [secretSlug, [isolated, 'public-source']]]);
    expect(resolveCandidateSources(candidate, 'notes/origin', 'default', new Set(endpoints.keys()), endpoints, true,
      { crossSource: true, isolatedSourceIds: new Set([isolated]) }))
      .toEqual({ ok: true, fromSlug: 'notes/origin', fromSourceId: 'default', toSourceId: 'public-source' });
  });

  test('wanted collection and storage refuse qualified isolated targets even when the page is missing', async () => {
    const ref = { key: 'ref:1', kind: 'slug' as const, target: secretSlug, targetSourceId: isolated };
    const candidates = [{ targetSlug: secretSlug, targetSourceId: isolated, linkType: 'mentions', context: secretSnippet, authoredRef: ref }];
    expect(collectWantedLinks({ candidates, frontmatterUnresolved: [{ field: 'owner', name: `${isolated}:${secretTitle}` }],
      originSourceId: 'default', crossSourceAllowed: true, isolatedSourceIds: new Set([isolated]),
      resolve: () => ({ ok: false, reason: 'isolated_target' }) })).toEqual([]);
    const row = { producer: 'body' as const, ref_kind: 'slug' as const, target_source_id: isolated,
      target_ref: 'people/missing-private-example', link_type: 'mentions', context: secretSnippet };
    expect(await possibleWantedRows(engine, 'default', [row])).toEqual([]);
    await seedOrigin();
    const origin = (await engine.getPage('notes/origin', { sourceId: 'default' }))!;
    await engine.transaction(tx => replaceWantedLinks(tx, { pageId: Number(origin.id), sourceId: 'default' }, { producers: ['body'], rows: [row] }));
    expect(await engine.executeRaw('SELECT target_ref, context FROM wanted_links')).toEqual([]);
  });

  test('wanted-page reads suppress old qualified and unqualified isolated references', async () => {
    await seedOrigin();
    for (const [sourceId, ref] of [[isolated, 'people/missing-private-example'], ['default', secretSlug]]) {
      await engine.executeRaw(`INSERT INTO wanted_links
          (origin_page_id, source_id, producer, ref_kind, target_source_id, target_ref, link_type, context, checked_at)
        SELECT id, 'default', 'body', 'slug', $1, $2, 'mentions', $3, now() FROM pages
        WHERE source_id = 'default' AND slug = 'notes/origin'`, [sourceId, ref, secretSnippet]);
    }
    expect(await listWantedPages(engine, { sourceId: 'default', limit: 20, offset: 0 })).toEqual({ total: 0, rows: [] });
  });

  test('automatic page preparation publishes no edge or wanted preview for an isolated target', async () => {
    await engine.setConfig('link_resolution.cross_source', 'true');
    await seedOrigin();
    const page = (await engine.getPage('notes/origin', { sourceId: 'default' }))!;
    const prepared = await prepareAutomaticLinks(engine, page.slug, page, 'default');
    const result = await prepared.apply(engine);
    expect(result.errors).toBe(0);
    expect(result.created).toBe(0);
    await assertNoTargetText(result);
    expect(await storedEdges()).toEqual([]);
    expect(await engine.executeRaw('SELECT target_ref, context FROM wanted_links')).toEqual([]);
  });

  test('DB extraction and the stale walk do not log or store blocked link text', async () => {
    await engine.setConfig('link_resolution.cross_source', 'true');
    await seedOrigin();
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runExtract(engine, ['links', '--source', 'db', '--source-id', 'default', '--include-frontmatter']);
      await extractStaleFromDB(engine, { dryRun: false, jsonMode: true, quiet: true, catchUp: true, sourceIdFilter: 'default', slugs: ['notes/origin'] });
      await assertNoTargetText(log.mock.calls);
    } finally { log.mockRestore(); }
    expect(await storedEdges()).toEqual([]);
    expect(await engine.executeRaw('SELECT target_ref, context FROM wanted_links')).toEqual([]);
  });

  for (const lane of ['reconcile', 'prepare', 'db', 'stale'] as const) {
    for (const reference of ['body', 'frontmatter'] as const) {
      test(`${lane}: an isolated ${reference} attendee does not block the meeting's other links`, async () => {
        await engine.setConfig('link_resolution.cross_source', 'true');
        await engine.putPage('people/allowed-example', { type: 'person', title: 'Allowed Example', compiled_truth: 'Public attendee' });
        const blocked = `${isolated}:${secretSlug}`;
        await engine.putPage('meetings/mixed', {
          type: 'meeting', title: 'Mixed meeting',
          compiled_truth: reference === 'body' ? `Attendees: [[${blocked}]], [[people/allowed-example]]` : '',
          frontmatter: reference === 'frontmatter' ? { attendees: [`[[${blocked}]]`, '[[people/allowed-example]]'] } : {},
        });
        if (lane === 'reconcile') {
          const result = await reconcileSourceLinks(engine, 'default', { pack });
          expect(result.ok).toBe(true);
          expect(result.failures).toEqual([]);
          await assertNoTargetText(result);
        } else if (lane === 'prepare') {
          const page = (await engine.getPage('meetings/mixed', { sourceId: 'default' }))!;
          const prepared = await prepareAutomaticLinks(engine, page.slug, page, 'default');
          expect(prepared.attendanceComplete).toBe(true);
          expect((await prepared.apply(engine)).errors).toBe(0);
        } else if (lane === 'db') {
          await runExtract(engine, ['links', '--source', 'db', '--source-id', 'default', '--include-frontmatter']);
        } else {
          const result = await extractStaleFromDB(engine, { dryRun: false, jsonMode: true, quiet: true, catchUp: true,
            includeFrontmatter: true, sourceIdFilter: 'default', slugs: ['meetings/mixed'] });
          expect(result.skippedAttendanceIncomplete ?? 0).toBe(0);
        }
        expect(await storedEdges()).toMatchObject([{ from_slug: 'people/allowed-example', to_slug: 'meetings/mixed', target_source: 'default' }]);
        await assertNoTargetText(await storedEdges());
        expect(await engine.executeRaw('SELECT target_ref, context FROM wanted_links')).toEqual([]);
      });
    }
  }

  test('shared SQL insertion fences every producer and emits a content-free single-link error', async () => {
    await seedOrigin();
    const row = { from_slug: 'notes/origin', from_source_id: 'default', to_slug: secretSlug,
      to_source_id: isolated, link_type: 'mentions', context: secretSnippet };
    expect(await engine.addLinksBatch([row])).toBe(0);
    await expect(engine.addLink(row.from_slug, row.to_slug, row.context, 'mentions', 'manual', undefined, undefined,
      { fromSourceId: 'default', toSourceId: isolated })).rejects.toThrow('Cross-source link target is isolated');
    expect(await storedEdges()).toEqual([]);
  });

  test('link and backlink reads hide legacy forbidden edges in every scope mode', async () => {
    await seedOrigin();
    await engine.executeRaw(`INSERT INTO links (from_page_id, to_page_id, link_type, context, link_source)
      SELECT f.id, t.id, 'mentions', $1, 'manual' FROM pages f, pages t
      WHERE f.source_id = 'default' AND f.slug = 'notes/origin' AND t.source_id = $2 AND t.slug = $3`,
      [secretSnippet, isolated, secretSlug]);
    for (const scope of [undefined, { sourceId: 'default' }, { sourceIds: ['default', isolated] }]) {
      expect(await engine.getLinks('notes/origin', scope)).toEqual([]);
    }
    for (const scope of [undefined, { sourceId: isolated }, { sourceIds: ['default', isolated] }]) {
      expect(await engine.getBacklinks(secretSlug, scope)).toEqual([]);
    }
    const page = await readReferrerPage(engine, { slug: secretSlug, sourceId: isolated, referrerSources: ['default', isolated],
      excludePrivate: false, pack: null, keepVisibility: ['private', 'world'] }, { limit: 20 });
    expect(page.rows).toEqual([]);
    await assertNoTargetText(await engine.traverseGraph('notes/origin', 2));
    await assertNoTargetText(await engine.traverseGraph('notes/origin', 2, { frontierCap: 20 }));
    for (const direction of ['out', 'in', 'both'] as const) {
      await assertNoTargetText(await engine.traversePaths('notes/origin', { depth: 2, direction }));
    }
  });

  test('mention matching and the mention pass fence isolated titles and aliases under the opt-in', async () => {
    await engine.setConfig('link_resolution.cross_source', 'true');
    await seedOrigin(`${secretTitle} presented the roadmap.`);
    await engine.executeRaw(`INSERT INTO page_aliases (source_id, slug, alias_norm, origin)
      VALUES ($1, $2, 'secret alias', 'frontmatter')`, [isolated, secretSlug]);
    const gazetteer = await buildGazetteer(engine);
    expect(findMentionedEntities(secretTitle, gazetteer, { fromSlug: 'notes/origin', fromSourceId: 'default', allowCrossSource: true })).toEqual([]);
    expect(findMentionedEntities('Secret Alias', gazetteer, { fromSlug: 'notes/origin', fromSourceId: 'default', allowCrossSource: true })).toEqual([]);
    expect(findMentionedEntities('Secret Alias', gazetteer, { fromSlug: 'notes/origin', fromSourceId: isolated, allowCrossSource: true }))
      .toMatchObject([{ slug: secretSlug, source_id: isolated }]);
    expect(findMentionedEntities(secretTitle, gazetteer, { fromSlug: 'notes/origin', fromSourceId: isolated, allowCrossSource: true }))
      .toMatchObject([{ slug: secretSlug, source_id: isolated }]);
    const result = await runMentionPass(engine, { sourceId: 'default' });
    expect(result.state).toBe('complete');
    expect(await storedEdges()).toEqual([]);
  });

  test('meeting timelines fence both legacy attendance edges and body mention targets', async () => {
    await engine.setConfig('link_resolution.cross_source', 'true');
    await engine.putPage('meetings/planning', { type: 'meeting', title: 'Planning', compiled_truth: `${secretTitle} presented.`,
      effective_date: new Date('2026-11-23T00:00:00.000Z') });
    await engine.executeRaw(`INSERT INTO links (from_page_id, to_page_id, link_type, link_source)
      SELECT f.id, t.id, 'attended', 'manual' FROM pages f, pages t
      WHERE f.slug = 'meetings/planning' AND f.source_id = 'default' AND t.slug = $1 AND t.source_id = $2`, [secretSlug, isolated]);
    const result = await extractTimelineFromMeetings(engine, { sourceIdFilter: 'default' });
    expect(result.batch_errors).toBe(0);
    expect(result.entries_created).toBe(0);
    expect(await engine.getTimeline(secretSlug, { sourceId: isolated })).toEqual([]);
  });
});
