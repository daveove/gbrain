/**
 * Admin graph explorer API (`/admin/api/graph/*`) over the production app
 * from `buildServeHttpApp` on an in-memory PGLite brain, driven over HTTP.
 *
 * Protects: owner auth on every graph route, the neighbourhood shape (root at
 * hop 0, every edge endpoint present, cross-source neighbours kept,
 * soft-deleted pages and hidden link types/sources excluded before the node
 * budget is spent), the request bounds (depth 1-2, node cap 300, most
 * connected first under the cap), slug ambiguity across sources, the source
 * map aggregate and its memo, search ordering and the page side panel.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import express from 'express';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildServeHttpApp } from '../src/commands/serve-http.ts';
import {
  GRAPH_MAX_LIMIT, GRAPH_TITLE_SEARCH_SQL, createTtlMemo,
  queryGraphNeighbourhood, queryGraphPage, querySourceMap, querySourceTopPages,
  type GraphPageDetail, type GraphSearchHit, type NeighbourhoodResult, type SourceMapResult,
} from '../src/core/graph-explorer.ts';

let engine: PGLiteEngine;
let server: Server;
let base = '';
let cookie = '';
const ids: Record<string, number> = {};

async function page(source: string, slug: string, title: string, body = '', deleted = false): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO pages (source_id, slug, type, title, compiled_truth, deleted_at)
     VALUES ($1, $2, 'note', $3, $4, ${deleted ? 'now()' : 'NULL'}) RETURNING id`,
    [source, slug, title, body]);
  ids[`${source}:${slug}`] = rows[0].id;
  return rows[0].id;
}

async function link(from: string, to: string, type: string, provenance = 'manual'): Promise<void> {
  await engine.executeRaw(`INSERT INTO links (from_page_id, to_page_id, link_type, link_source) VALUES ($1, $2, $3, $4)`,
    [ids[from], ids[to], type, provenance]);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const id of ['tana-fixture', 'bear-fixture', 'logseq-fixture', 'tana-json-fixture']) {
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING', [id]);
  }
  // Tana: a project with children; one child is a hub with extra fan-out.
  await page('tana-fixture', 'project', 'Project Atlas', 'Atlas root node. '.repeat(60));
  for (const c of ['alpha', 'beta', 'gamma', 'delta']) await page('tana-fixture', c, `Task ${c}`);
  await page('tana-fixture', 'leaf', 'Leaf under alpha');
  await page('tana-fixture', 'twin', 'Duplicate of project');
  await page('tana-fixture', 'ghost', 'Deleted child', '', true);
  await link('tana-fixture:project', 'tana-fixture:alpha', 'contains', 'tana-structure');
  await link('tana-fixture:project', 'tana-fixture:alpha', 'contains', 'tana-children');
  await link('tana-fixture:project', 'tana-fixture:beta', 'contains');
  await link('tana-fixture:project', 'tana-fixture:gamma', 'contains');
  await link('tana-fixture:project', 'tana-fixture:delta', 'tagged');
  await link('tana-fixture:project', 'tana-fixture:ghost', 'contains');
  await link('tana-fixture:twin', 'tana-fixture:project', 'duplicate');
  await link('tana-fixture:alpha', 'tana-fixture:leaf', 'contains');
  await link('tana-fixture:alpha', 'tana-fixture:beta', 'mentions');
  // An ended temporal relationship: the links row stays, link_relationships
  // marks it ended, and the live-by-default graph contract hides it.
  await page('tana-fixture', 'former-employer', 'Former employer');
  await link('tana-fixture:project', 'tana-fixture:former-employer', 'works_at');
  await engine.executeRaw(`INSERT INTO link_relationships (from_page_id, to_page_id, link_type, scope, source_id, semantics,
      valid_ranges, status_now, first_start, last_end, evidence_hash)
    VALUES ($1, $2, 'works_at', 'all', 'tana-fixture', 'state', '{[2020-01-01,2021-01-01)}', 'ended', '2020-01-01', '2021-01-01', 'fixture')`,
    [ids['tana-fixture:project'], ids['tana-fixture:former-employer']]);
  // alpha is the most connected child: extra edges into Bear (cross-source).
  await page('bear-fixture', 'meeting-notes', 'Meeting notes');
  await page('bear-fixture', 'reading-list', 'Reading list');
  await link('bear-fixture:meeting-notes', 'tana-fixture:project', 'wikilink');
  await link('bear-fixture:meeting-notes', 'tana-fixture:alpha', 'wikilink');
  await link('bear-fixture:reading-list', 'tana-fixture:alpha', 'wikilink');
  // Tana-shaped JSON bodies: one with a name/description, one with neither.
  await page('tana-json-fixture', 'call', 'Call', JSON.stringify({
    children: ['k1', 'k2'], id: 'abc123',
    props: {
      created: 1,
      name: 'Call <span data-inlineref-node="n1">Ada</span> about <b>pricing</b> &amp; <span data-inlineref-node="n2"></span> on <span data-inlineref-date="{&quot;dateTimeString&quot;:&quot;2024-05-01&quot;}"></span>',
      description: 'Follow up  next week',
    },
  }));
  await page('tana-json-fixture', 'container', 'Container', JSON.stringify({ children: ['x1', 'x2'], id: 'c1', props: { created: 1 } }));
  await page('tana-json-fixture', 'draft', 'Draft outline');
  await page('tana-json-fixture', 'invoice', 'Send invoice');
  await page('tana-json-fixture', 'budget-json', 'Budget export', '{"title":"Budget","rows":[1,2]}');
  // The same child stored by two provenances must appear once in the excerpt.
  await link('tana-json-fixture:container', 'tana-json-fixture:draft', 'contains', 'tana-structure');
  await link('tana-json-fixture:container', 'tana-json-fixture:draft', 'contains', 'tana-children');
  await link('tana-json-fixture:container', 'tana-json-fixture:invoice', 'contains');
  // Same slug in two sources -> ambiguous without source.
  await page('logseq-fixture', 'project', 'Logseq project page');
  await page('logseq-fixture', 'lonely', 'Isolated page');
  // A live page whose only link points at a soft-deleted page is still isolated.
  await link('logseq-fixture:lonely', 'tana-fixture:ghost', 'mentions');
  // An archived source keeps live pages; the map flags it rather than hiding it.
  await engine.executeRaw(`INSERT INTO sources (id, name, archived) VALUES ('archived-fixture', 'archived-fixture', true) ON CONFLICT DO NOTHING`);
  await page('archived-fixture', 'old-note', 'Old note');

  const app = express();
  const listening = Promise.withResolvers<void>();
  server = app.listen(0, '127.0.0.1', () => listening.resolve());
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a TCP address');
  base = `http://127.0.0.1:${address.port}`;
  const built = await buildServeHttpApp(app, engine, { port: address.port, tokenTtl: 3600, enableDcr: false, publicUrl: base });
  const login = await fetch(`${base}/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: built.bootstrapToken }),
  });
  expect(login.status).toBe(200);
  cookie = login.headers.get('set-cookie')!.split(';')[0];
}, 120_000);

afterAll(async () => {
  const closed = Promise.withResolvers<void>();
  server.closeAllConnections?.();
  server.close(() => closed.resolve());
  await closed.promise;
  await engine.disconnect();
});

async function get<T = { error?: string; sources?: string[] }>(path: string, withCookie = true): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${path}`, { headers: withCookie ? { Cookie: cookie } : {} });
  // The assertions below check the shape; T only names what the route promises.
  const body = (await res.json()) as T;
  return { status: res.status, body };
}

describe('admin graph API', () => {
  test('every graph route requires the owner session', async () => {
    for (const path of [
      '/admin/api/graph/search?q=project',
      `/admin/api/graph/neighbourhood?id=${ids['tana-fixture:project']}`,
      `/admin/api/graph/page?id=${ids['tana-fixture:project']}`,
      '/admin/api/graph/sources',
      '/admin/api/graph/sources/tana-fixture/top',
    ]) {
      const res = await get(path, false);
      expect(res.status).toBe(401);
      expect(JSON.stringify(res.body)).not.toContain('Project Atlas');
    }
  });

  test('neighbourhood: root at hop 0, closed edge set, cross-source kept, deleted and hidden types excluded', async () => {
    const { status, body } = await get<NeighbourhoodResult>('/admin/api/graph/neighbourhood?slug=project&source=tana-fixture&depth=2&hide_types=duplicate');
    expect(status).toBe(200);
    expect(body.root).toMatchObject({ id: ids['tana-fixture:project'], source_id: 'tana-fixture', hop: 0 });
    const nodeIds = new Set(body.nodes.map(n => n.id));
    for (const e of body.edges) {
      expect(nodeIds.has(e.from)).toBe(true);
      expect(nodeIds.has(e.to)).toBe(true);
      expect(e.link_type).not.toBe('duplicate');
    }
    const hop = Object.fromEntries(body.nodes.map(n => [`${n.source_id}:${n.slug}`, n.hop]));
    expect(hop['tana-fixture:alpha']).toBe(1);
    expect(hop['bear-fixture:meeting-notes']).toBe(1);
    expect(hop['tana-fixture:leaf']).toBe(2);
    expect(hop['bear-fixture:reading-list']).toBe(2);
    expect(hop['tana-fixture:ghost']).toBeUndefined();
    expect(hop['tana-fixture:twin']).toBeUndefined();
    expect(hop['tana-fixture:former-employer']).toBeUndefined();
    // Two provenances of project->alpha collapse into one edge with count 2.
    const projectAlpha = body.edges.find(e => e.from === ids['tana-fixture:project'] && e.to === ids['tana-fixture:alpha']);
    expect(projectAlpha).toMatchObject({ link_type: 'contains', count: 2 });
    expect(body.truncated).toBe(false);

    const withDup = await get<NeighbourhoodResult>(`/admin/api/graph/neighbourhood?id=${ids['tana-fixture:project']}&depth=1`);
    expect(withDup.body.nodes.map(n => n.slug)).toContain('twin');
    expect(withDup.body.nodes.every(n => n.hop <= 1)).toBe(true);

    const noBear = await get<NeighbourhoodResult>(`/admin/api/graph/neighbourhood?id=${ids['tana-fixture:project']}&hide_sources=bear-fixture`);
    expect(noBear.body.nodes.some(n => n.source_id === 'bear-fixture')).toBe(false);
  });

  test('node cap keeps the most connected neighbours first and reports truncation', async () => {
    const { body } = await get<NeighbourhoodResult>(`/admin/api/graph/neighbourhood?id=${ids['tana-fixture:project']}&depth=1&limit=2&hide_types=duplicate`);
    expect(body.nodes).toHaveLength(2);
    expect(body.nodes[1].slug).toBe('alpha');
    expect(body.truncated).toBe(true);
    expect(body.candidates).toBeGreaterThan(1);
  });

  test('hide hubs uses total stored degree before ranking, keeps the root, and does not traverse hidden hubs', async () => {
    const root = ids['tana-fixture:project'];
    const path = `/admin/api/graph/neighbourhood?id=${root}&hide_types=duplicate`;
    const capped = await get<NeighbourhoodResult>(`${path}&depth=1&limit=3&max_degree=2`);
    expect(capped.status).toBe(200);
    expect(capped.body.root.degree).toBe(9);
    expect(capped.body.nodes.map(n => [n.source_id, n.slug, n.degree, n.hop])).toEqual([
      ['tana-fixture', 'project', 9, 0],
      ['bear-fixture', 'meeting-notes', 2, 1],
      ['tana-fixture', 'beta', 2, 1],
    ]);
    expect(capped.body.candidates).toBe(4);
    expect(capped.body.truncated).toBe(true);
    expect(capped.body.edges.map(e => [e.link_type, e.count])).toEqual([['contains', 1], ['wikilink', 1]]);

    const deep = await get<NeighbourhoodResult>(`${path}&depth=2&max_degree=1`);
    expect(deep.body.nodes.map(n => [n.slug, n.degree, n.hop])).toEqual([
      ['project', 9, 0], ['delta', 1, 1], ['gamma', 1, 1],
    ]);
    expect(deep.body.candidates).toBe(2);
    expect(deep.body.truncated).toBe(false);
    // alpha's degree is still 6 even when its mentions/wikilinks are hidden:
    // hub filtering does not measure just the currently visible edge types.
    const types = await get<NeighbourhoodResult>(`/admin/api/graph/neighbourhood?id=${root}&depth=1&max_degree=3&hide_types=duplicate,mentions,wikilink`);
    expect(types.body.nodes.map(n => n.slug)).toEqual(['project', 'beta', 'delta', 'gamma']);
    const off = await get<NeighbourhoodResult>(`${path}&depth=1&limit=2`);
    expect(off.body.nodes.map(n => n.slug)).toEqual(['project', 'alpha']);
  });

  test('hub rows cannot consume either direction of the bounded edge scan', async () => {
    await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('scan-fixture', 'scan-fixture')");
    for (const direction of ['out', 'in']) {
      const root = await page('scan-fixture', `${direction}-root`, `${direction} root`);
      const hub = await page('scan-fixture', `${direction}-hub`, `${direction} hub`);
      const leaf = await page('scan-fixture', `${direction}-leaf`, `${direction} leaf`);
      const [from, to] = direction === 'out' ? [root, hub] : [hub, root];
      await engine.executeRaw(`INSERT INTO links (from_page_id, to_page_id, link_type, link_source)
        SELECT $1, $2, 'mentions', 'scan-' || n FROM generate_series(1, 4000) n`, [from, to]);
      await engine.executeRaw(`INSERT INTO links (from_page_id, to_page_id, link_type, link_source)
        VALUES ($1, $2, 'contains', 'manual')`, direction === 'out' ? [root, leaf] : [leaf, root]);
      const { status, body } = await get<NeighbourhoodResult>(`/admin/api/graph/neighbourhood?id=${root}&depth=2&limit=2&max_degree=1`);
      expect(status).toBe(200);
      expect(body.nodes.map(n => [n.slug, n.degree, n.hop])).toEqual([
        [`${direction}-root`, 4001, 0], [`${direction}-leaf`, 1, 1],
      ]);
      expect(body.edges).toEqual([{ from: direction === 'out' ? root : leaf, to: direction === 'out' ? leaf : root, link_type: 'contains', count: 1 }]);
      expect(body.candidates).toBe(1);
      expect(body.truncated).toBe(false);
    }
    // Keep the other tests' literal whole-brain aggregate expectations isolated.
    await engine.executeRaw("DELETE FROM pages WHERE source_id = 'scan-fixture'");
    await engine.executeRaw("DELETE FROM sources WHERE id = 'scan-fixture'");
  }, 60_000);

  test('request bounds', async () => {
    const root = ids['tana-fixture:project'];
    expect((await get(`/admin/api/graph/neighbourhood?id=${root}&depth=3`)).status).toBe(400);
    expect((await get(`/admin/api/graph/neighbourhood?id=${root}&depth=0`)).status).toBe(400);
    expect((await get(`/admin/api/graph/neighbourhood?id=${root}&limit=-4`)).status).toBe(400);
    for (const threshold of ['0', '-1', '1.5', 'nope', '', '2147483647', '1&max_degree=2']) {
      const invalid = await get(`/admin/api/graph/neighbourhood?id=${root}&max_degree=${threshold}`);
      expect(invalid.status).toBe(400);
      expect(invalid.body.error).toBe('invalid_max_degree');
    }
    expect((await get<NeighbourhoodResult>(`/admin/api/graph/neighbourhood?id=${root}&limit=100000`)).body.limit).toBe(GRAPH_MAX_LIMIT);
    expect((await get('/admin/api/graph/neighbourhood')).status).toBe(400);
    expect((await get('/admin/api/graph/neighbourhood?id=999999')).status).toBe(404);
    expect((await get(`/admin/api/graph/neighbourhood?id=${ids['tana-fixture:ghost']}`)).status).toBe(404);
    expect((await get('/admin/api/graph/search?q=a')).status).toBe(400);
    // Two characters that are not slug-shaped would be an unindexable title scan.
    expect((await get('/admin/api/graph/search?q=Pr')).status).toBe(400);
    // Page ids are int4: a larger id is a bad request, not a database error.
    expect((await get('/admin/api/graph/neighbourhood?id=9999999999')).status).toBe(400);
    expect((await get('/admin/api/graph/page?id=2147483648')).status).toBe(400);
    expect((await get('/admin/api/graph/sources/tana-fixture/top?limit=1000')).status).toBe(200);
  });

  test('a slug shared by two sources needs a source', async () => {
    const { status, body } = await get('/admin/api/graph/neighbourhood?slug=project');
    expect(status).toBe(409);
    expect(body.error).toBe('ambiguous_slug');
    expect(body.sources).toEqual(['logseq-fixture', 'tana-fixture']);
  });

  test('source map counts pages, connected pages and cross-source edges, memoized', async () => {
    const { status, body } = await get<SourceMapResult>('/admin/api/graph/sources');
    expect(status).toBe(200);
    const by = Object.fromEntries(body.sources.map(s => [s.id, s]));
    // former-employer's only edge is an ended relationship, so it counts as isolated.
    expect(by['tana-fixture']).toMatchObject({ pages: 8, connected: 7, isolated: 1 });
    expect(by['logseq-fixture']).toMatchObject({ pages: 2, connected: 0, isolated: 2 });
    expect(by['bear-fixture']).toMatchObject({ pages: 2, connected: 2, internal_edges: 0 });
    expect(body.cross).toEqual([{ from_source: 'bear-fixture', to_source: 'tana-fixture', edges: 3 }]);
    expect(body.link_types.find(t => t.link_type === 'contains')?.edges).toBe(8);
    const again = await get<SourceMapResult>('/admin/api/graph/sources');
    expect(again.body.generated_at).toBe(body.generated_at);

    const top = await get<GraphSearchHit[]>('/admin/api/graph/sources/tana-fixture/top?limit=2');
    expect(top.body.map(p => p.slug)).toEqual(['project', 'alpha']);
    // Only a link to a deleted page: neither ranked nor counted as connected.
    expect((await get<GraphSearchHit[]>('/admin/api/graph/sources/logseq-fixture/top')).body).toEqual([]);
    expect(by['archived-fixture']).toMatchObject({ archived: true, pages: 1 });
  });

  test('a Tana JSON body gets a readable excerpt, falling back to its children', async () => {
    const named = await get<GraphPageDetail>(`/admin/api/graph/page?id=${ids['tana-json-fixture:call']}`);
    expect(named.body.excerpt).toBe('Call Ada about pricing & [ref] on [date] — Follow up next week');
    const unnamed = await get<GraphPageDetail>(`/admin/api/graph/page?id=${ids['tana-json-fixture:container']}`);
    // draft is linked twice (two provenances); invoice must still be listed, draft once.
    expect(unnamed.body.excerpt).toBe('contains: Draft outline, Send invoice');
    const prose = await get<GraphPageDetail>(`/admin/api/graph/page?id=${ids['tana-fixture:project']}`);
    expect(prose.body.excerpt.startsWith('Atlas root node. Atlas root node.')).toBe(true);
    // Ordinary JSON (no Tana node shape) keeps its text, even in a Tana source.
    const json = await get<GraphPageDetail>(`/admin/api/graph/page?id=${ids['tana-json-fixture:budget-json']}`);
    expect(json.body.excerpt).toBe('{"title":"Budget","rows":[1,2]}');
  });

  test('search ranks exact matches first; page panel carries link counts and a bounded excerpt', async () => {
    const hits = (await get<GraphSearchHit[]>('/admin/api/graph/search?q=project')).body;
    expect(hits[0].slug).toBe('project');
    expect(hits.some(h => h.slug === 'ghost')).toBe(false);
    const scoped = (await get<GraphSearchHit[]>('/admin/api/graph/search?q=project&source=logseq-fixture')).body;
    expect(scoped.map(h => h.source_id)).toEqual(['logseq-fixture']);

    const { status, body } = await get<GraphPageDetail>(`/admin/api/graph/page?id=${ids['tana-fixture:project']}`);
    expect(status).toBe(200);
    expect(body.title).toBe('Project Atlas');
    expect(body.excerpt.length).toBeLessThanOrEqual(361);
    expect(body.links).toContainEqual({ link_type: 'contains', direction: 'out', count: 5 });
    expect(body.links).toContainEqual({ link_type: 'duplicate', direction: 'in', count: 1 });
  });

  test('search matches titles by substring and slugs only exactly', async () => {
    // 'lonely' is a slug whose title is 'Isolated page': a slug substring finds nothing ...
    expect((await get<GraphSearchHit[]>('/admin/api/graph/search?q=lonel')).body).toEqual([]);
    // ... the exact slug finds it, in every source unless one is given.
    const exact = (await get<GraphSearchHit[]>('/admin/api/graph/search?q=lonely')).body;
    expect(exact.map(h => `${h.source_id}:${h.slug}`)).toEqual(['logseq-fixture:lonely']);
    // Unicode slugs are slugs too (canonical grammar), even when the title differs.
    await page('logseq-fixture', '日本/計画', 'Planning notes');
    expect((await get<GraphSearchHit[]>(`/admin/api/graph/search?q=${encodeURIComponent('日本/計画')}`)).body.map(h => h.title)).toEqual(['Planning notes']);
    // Exact-slug hits follow the requested limit, not a fixed ambiguity cap.
    for (let i = 0; i < 12; i++) {
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING', [`many-${i}`]);
      await page(`many-${i}`, 'shared-slug', `Shared ${i}`);
    }
    expect((await get<GraphSearchHit[]>('/admin/api/graph/search?q=shared-slug&limit=12')).body).toHaveLength(12);
    const both = (await get<GraphSearchHit[]>('/admin/api/graph/search?q=project')).body;
    expect(both.slice(0, 2).map(h => h.source_id)).toEqual(['logseq-fixture', 'tana-fixture']);
    // The title arm never matches slugs, so the title trigram index serves it.
    expect(GRAPH_TITLE_SEARCH_SQL).not.toMatch(/slug\s+ILIKE/i);
    // With sequential scans off, the only index that can serve the match scan
    // is the title trigram index (no OR on slug, no deleted_at beside it).
    const scratch = new PGLiteEngine();
    await scratch.connect({});
    try {
      await scratch.initSchema();
      await scratch.executeRaw(`INSERT INTO pages (source_id, slug, type, title, compiled_truth)
        SELECT 'default', 'n/' || g, 'note', 'Note ' || md5(g::text), '' FROM generate_series(1, 2000) g`);
      await scratch.executeRaw('ANALYZE pages');
      await scratch.executeRaw('SET enable_seqscan = off');
      const plan = await scratch.executeRaw<{ 'QUERY PLAN': string }>(`EXPLAIN ${GRAPH_TITLE_SEARCH_SQL}`,
        ['abcdef', '%abcdef%', 'abcdef%', 20, null]);
      const text = plan.map(r => r['QUERY PLAN']).join('\n');
      expect(text).toContain('Bitmap Index Scan on idx_pages_trgm');
      expect(text).not.toContain('pages_dedup_idx');
    } finally {
      await scratch.disconnect();
    }
  }, 60_000);

  test('disabling graph.edge_validity restores ended edges in every graph view', async () => {
    const previous = await engine.getConfig('graph.edge_validity');
    await engine.setConfig('graph.edge_validity', 'off');
    try {
      const root = ids['tana-fixture:project'];
      const former = ids['tana-fixture:former-employer'];
      const neighbourhood = await queryGraphNeighbourhood(engine, root, { depth: 1 });
      expect(neighbourhood.nodes.map(n => n.id)).toContain(former);
      expect(neighbourhood.edges).toContainEqual({ from: root, to: former, link_type: 'works_at', count: 1 });
      const detail = await queryGraphPage(engine, root);
      expect(detail?.links).toContainEqual({ link_type: 'works_at', direction: 'out', count: 1 });
      // Query the aggregates directly: the HTTP endpoints intentionally memoize results.
      const map = await querySourceMap(engine);
      expect(map.link_types).toContainEqual({ link_type: 'works_at', edges: 1 });
      expect(map.sources.find(s => s.id === 'tana-fixture')?.isolated).toBe(0);
      expect((await querySourceTopPages(engine, 'tana-fixture')).map(p => p.id)).toContain(former);
    } finally {
      await engine.setConfig('graph.edge_validity', previous ?? 'on');
    }
  });
});

describe('graph aggregate memo', () => {
  test('a failure is replayed for failureTtlMs, then the load runs again', async () => {
    let t = 0;
    let calls = 0;
    const memo = createTtlMemo<number>({ ttlMs: 300_000, failureTtlMs: 90_000, maxEntries: 2, now: () => t });
    const failing = () => { calls++; return Promise.reject(new Error('timeout')); };
    await expect(memo('all', failing)).rejects.toThrow('timeout');
    t = 89_000;
    await expect(memo('all', failing)).rejects.toThrow('timeout');
    expect(calls).toBe(1);
    t = 91_000;
    expect(await memo('all', async () => { calls++; return 7; })).toBe(7);
    t = 300_000;
    expect(await memo('all', async () => { calls++; return 8; })).toBe(7);
    expect(calls).toBe(2);
    // Oldest key is dropped past maxEntries.
    await memo('b', async () => 1);
    await memo('c', async () => 1);
    expect(await memo('all', async () => { calls++; return 9; })).toBe(9);
  });
});
