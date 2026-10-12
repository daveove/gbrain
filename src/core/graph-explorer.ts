/**
 * Read-side graph queries behind the admin graph explorer
 * (`/admin/api/graph/*`, src/commands/serve-http-admin-graph.ts).
 *
 * Two views need two shapes the engine walks do not produce:
 *
 * - Neighbourhood: the ego network of ONE page, keyed by page id (a slug is
 *   only unique inside its source), ranked most-connected-first and capped
 *   to a few hundred nodes so a browser can lay it out. The walk crosses
 *   sources (the owner sees every edge), excludes soft-deleted pages, and
 *   applies the link-type and source filters while it expands, so a hidden
 *   edge type (e.g. `duplicate`) never spends the node budget.
 *   `traverseGraph` / `traversePathsDetailed` enumerate simple paths from
 *   every page that carries the slug, scope seed and steps together, rank
 *   nothing, and run without a per-statement bound; this module runs one
 *   bounded statement per hop instead.
 * - Source map: per-source page counts, connected-page counts and
 *   source-pair edge counts. Aggregates over `links` joined to the id,
 *   source_id and deleted_at columns of `pages`; no content column is read.
 *
 * Every statement carries `timeoutMs` (a transaction-local
 * statement_timeout on Postgres, see BrainEngine.executeRaw) and a LIMIT or a
 * GROUP BY over indexed keys.
 */
import type { BrainEngine } from './engine.ts';

export const GRAPH_MAX_DEPTH = 2;
export const GRAPH_DEFAULT_LIMIT = 150;
export const GRAPH_MAX_LIMIT = 300;
/** Edge rows one hop expansion may read per direction before it reports truncation. */
export const GRAPH_EDGE_SCAN_CAP = 4000;
/** Candidate pages whose degree is measured per hop; the rest are reported as truncation. */
export const GRAPH_CANDIDATE_CAP = 1500;
/** Upper bound on edges returned for the induced subgraph of the kept nodes. */
export const GRAPH_EDGE_RESULT_CAP = 5000;
export const GRAPH_SEARCH_MAX_LIMIT = 30;
export const GRAPH_TOP_PAGES_MAX_LIMIT = 50;
export const GRAPH_QUERY_TIMEOUT_MS = 8_000;
export const GRAPH_AGGREGATE_TIMEOUT_MS = 30_000;
export const GRAPH_EXCERPT_CHARS = 360;

export interface GraphPageRef {
  id: number;
  source_id: string;
  slug: string;
  title: string;
  type: string;
}

export interface GraphNodeView extends GraphPageRef {
  /** Stored link rows touching the page, either direction, every type. */
  degree: number;
  /** Hops from the root (0 = root). */
  hop: number;
}

export interface GraphEdgeView {
  from: number;
  to: number;
  link_type: string;
  /** Link rows collapsed into this edge (one per provenance / origin). */
  count: number;
}

export interface NeighbourhoodOptions {
  depth?: number;
  limit?: number;
  hideLinkTypes?: string[];
  hideSources?: string[];
}

export interface NeighbourhoodResult {
  root: GraphNodeView;
  nodes: GraphNodeView[];
  edges: GraphEdgeView[];
  depth: number;
  limit: number;
  /** Distinct pages reachable within `depth` under the filters, before the node cap. */
  candidates: number;
  /** True when a scan cap or the node cap dropped reachable pages. */
  truncated: boolean;
}

export class GraphRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly details?: Record<string, unknown>) {
    super(message);
  }
}

type Row = Record<string, unknown>;

function toPageRef(r: Row): GraphPageRef {
  return {
    id: Number(r.id),
    source_id: String(r.source_id),
    slug: String(r.slug),
    title: String(r.title ?? r.slug),
    type: String(r.type ?? ''),
  };
}

const DEGREE_SQL = `((SELECT count(*) FROM links o WHERE o.from_page_id = p.id) + (SELECT count(*) FROM links i WHERE i.to_page_id = p.id))::int`;
const TITLE_SQL = `COALESCE(NULLIF(p.title, ''), p.slug)`;

/** Resolve the root page. Without a source, a slug shared by two sources is ambiguous. */
export async function resolveGraphRoot(engine: BrainEngine, slug: string, sourceId?: string): Promise<GraphPageRef | null> {
  const rows = sourceId
    ? await engine.executeRaw<Row>(
        `SELECT p.id, p.source_id, p.slug, ${TITLE_SQL} AS title, p.type FROM pages p
          WHERE p.source_id = $1 AND p.slug = $2 AND p.deleted_at IS NULL`,
        [sourceId, slug], { timeoutMs: GRAPH_QUERY_TIMEOUT_MS })
    : await engine.executeRaw<Row>(
        `SELECT p.id, p.source_id, p.slug, ${TITLE_SQL} AS title, p.type FROM pages p
          WHERE p.slug = $1 AND p.deleted_at IS NULL ORDER BY p.source_id LIMIT 10`,
        [slug], { timeoutMs: GRAPH_QUERY_TIMEOUT_MS });
  if (rows.length === 0) return null;
  if (rows.length > 1) {
    throw new GraphRequestError(`Slug "${slug}" exists in ${rows.length} sources; pass source.`, 409, 'ambiguous_slug',
      { sources: rows.map(r => String(r.source_id)) });
  }
  return toPageRef(rows[0]);
}

async function pageInfo(engine: BrainEngine, ids: number[]): Promise<Map<number, GraphPageRef & { degree: number }>> {
  const out = new Map<number, GraphPageRef & { degree: number }>();
  if (ids.length === 0) return out;
  const rows = await engine.executeRaw<Row>(
    `SELECT p.id, p.source_id, p.slug, ${TITLE_SQL} AS title, p.type, ${DEGREE_SQL} AS degree
       FROM pages p WHERE p.id = ANY($1::int[]) AND p.deleted_at IS NULL`,
    [ids], { timeoutMs: GRAPH_QUERY_TIMEOUT_MS });
  for (const r of rows) out.set(Number(r.id), { ...toPageRef(r), degree: Number(r.degree) });
  return out;
}

/**
 * One hop: link rows touching `frontier` whose far endpoint is live, not in a
 * hidden source, and whose type is not hidden. Each direction reads at most
 * GRAPH_EDGE_SCAN_CAP rows in link-id order.
 */
async function expand(engine: BrainEngine, frontier: number[], hideTypes: string[], hideSources: string[]): Promise<{ edges: Array<{ a: number; b: number }>; truncated: boolean }> {
  const rows = await engine.executeRaw<Row>(
    `(SELECT 'out' AS dir, l.from_page_id AS a, l.to_page_id AS b FROM links l JOIN pages p ON p.id = l.to_page_id
       WHERE l.from_page_id = ANY($1::int[]) AND l.to_page_id <> l.from_page_id AND p.deleted_at IS NULL
         AND NOT (l.link_type = ANY($2::text[])) AND NOT (p.source_id = ANY($3::text[]))
       ORDER BY l.id LIMIT $4)
     UNION ALL
     (SELECT 'in' AS dir, l.to_page_id AS a, l.from_page_id AS b FROM links l JOIN pages p ON p.id = l.from_page_id
       WHERE l.to_page_id = ANY($1::int[]) AND l.to_page_id <> l.from_page_id AND p.deleted_at IS NULL
         AND NOT (l.link_type = ANY($2::text[])) AND NOT (p.source_id = ANY($3::text[]))
       ORDER BY l.id LIMIT $4)`,
    [frontier, hideTypes, hideSources, GRAPH_EDGE_SCAN_CAP], { timeoutMs: GRAPH_QUERY_TIMEOUT_MS });
  let outRows = 0;
  let inRows = 0;
  const edges: Array<{ a: number; b: number }> = [];
  for (const r of rows) {
    if (r.dir === 'out') outRows++; else inRows++;
    edges.push({ a: Number(r.a), b: Number(r.b) });
  }
  return { edges, truncated: outRows >= GRAPH_EDGE_SCAN_CAP || inRows >= GRAPH_EDGE_SCAN_CAP };
}

function byDegree(a: { degree: number; title: string; id: number }, b: { degree: number; title: string; id: number }): number {
  return b.degree - a.degree || a.title.localeCompare(b.title) || a.id - b.id;
}

export function clampGraphDepth(raw: unknown): number {
  const n = Number(raw ?? GRAPH_MAX_DEPTH);
  if (!Number.isInteger(n) || n < 1 || n > GRAPH_MAX_DEPTH) {
    throw new GraphRequestError(`depth must be an integer from 1 to ${GRAPH_MAX_DEPTH}`, 400, 'invalid_depth');
  }
  return n;
}

export function clampGraphLimit(raw: unknown, fallback: number, max: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new GraphRequestError(`limit must be a positive integer (max ${max})`, 400, 'invalid_limit');
  return Math.min(n, max);
}

/**
 * Ego network of page `rootId`: hop-1 pages ranked by degree, then (depth 2)
 * pages one further hop out ranked by how many kept pages they touch, then
 * degree. Edges are the induced subgraph of the kept pages under the type
 * filter. The root's own source is never hidden.
 */
export async function queryGraphNeighbourhood(engine: BrainEngine, rootId: number, opts: NeighbourhoodOptions = {}): Promise<NeighbourhoodResult> {
  const depth = clampGraphDepth(opts.depth);
  const limit = clampGraphLimit(opts.limit, GRAPH_DEFAULT_LIMIT, GRAPH_MAX_LIMIT);
  const rootInfo = (await pageInfo(engine, [rootId])).get(rootId);
  if (!rootInfo) throw new GraphRequestError('Page not found', 404, 'not_found');
  const hideTypes = [...new Set(opts.hideLinkTypes ?? [])];
  const hideSources = [...new Set(opts.hideSources ?? [])].filter(s => s !== rootInfo.source_id);
  let truncated = false;

  const kept = new Map<number, GraphNodeView>([[rootId, { ...rootInfo, hop: 0 }]]);
  const seen = new Set<number>([rootId]);

  let frontier = [rootId];
  for (let hop = 1; hop <= depth; hop++) {
    const step = await expand(engine, frontier, hideTypes, hideSources);
    truncated ||= step.truncated;
    // Score = distinct kept pages a candidate connects to.
    const touches = new Map<number, Set<number>>();
    for (const { a, b } of step.edges) {
      if (seen.has(b)) continue;
      let set = touches.get(b);
      if (!set) touches.set(b, set = new Set());
      set.add(a);
    }
    const score = new Map([...touches].map(([id, s]) => [id, s.size]));
    for (const id of score.keys()) seen.add(id);
    if (score.size > GRAPH_CANDIDATE_CAP) truncated = true;
    // Measure degree only for the GRAPH_CANDIDATE_CAP candidates touching the most kept pages (ties: lower id).
    const shortlist = [...score.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0]).slice(0, GRAPH_CANDIDATE_CAP).map(([id]) => id);
    const measured = await pageInfo(engine, shortlist);
    const ranked = [...measured.values()].sort((x, y) =>
      hop === 1 ? byDegree(x, y) : (score.get(y.id)! - score.get(x.id)!) || byDegree(x, y));
    const room = limit - kept.size;
    if (ranked.length > room) truncated = true;
    const added = ranked.slice(0, Math.max(0, room));
    for (const n of added) kept.set(n.id, { ...n, hop });
    if (kept.size >= limit || added.length === 0) break;
    frontier = added.map(n => n.id);
  }

  const ids = [...kept.keys()];
  const edgeRows = await engine.executeRaw<Row>(
    `SELECT l.from_page_id AS "from", l.to_page_id AS "to", l.link_type, count(*)::int AS count
       FROM links l
      WHERE l.from_page_id = ANY($1::int[]) AND l.to_page_id = ANY($1::int[])
        AND l.from_page_id <> l.to_page_id AND NOT (l.link_type = ANY($2::text[]))
      GROUP BY l.from_page_id, l.to_page_id, l.link_type
      ORDER BY l.from_page_id, l.to_page_id, l.link_type
      LIMIT $3`,
    [ids, hideTypes, GRAPH_EDGE_RESULT_CAP + 1], { timeoutMs: GRAPH_QUERY_TIMEOUT_MS });
  if (edgeRows.length > GRAPH_EDGE_RESULT_CAP) truncated = true;
  const edges: GraphEdgeView[] = edgeRows.slice(0, GRAPH_EDGE_RESULT_CAP).map(r => ({
    from: Number(r.from), to: Number(r.to), link_type: String(r.link_type ?? ''), count: Number(r.count),
  }));

  return {
    root: kept.get(rootId)!,
    nodes: [...kept.values()],
    edges,
    depth,
    limit,
    candidates: seen.size - 1,
    truncated,
  };
}

export interface GraphSearchHit extends GraphPageRef {
  degree: number;
}

/**
 * Title / slug substring search for the explorer's search box: exact slug or
 * title first, then prefix matches, then shorter titles. Degree is measured
 * only for the returned page.
 */
export async function searchGraphPages(engine: BrainEngine, query: string, opts: { limit?: number; sourceId?: string } = {}): Promise<GraphSearchHit[]> {
  const q = query.trim();
  if (q.length < 2) throw new GraphRequestError('Search needs at least 2 characters', 400, 'query_too_short');
  if (q.length > 200) throw new GraphRequestError('Search is limited to 200 characters', 400, 'query_too_long');
  const limit = clampGraphLimit(opts.limit, 20, GRAPH_SEARCH_MAX_LIMIT);
  const esc = q.replace(/[\\%_]/g, ch => `\\${ch}`);
  const rows = await engine.executeRaw<Row>(
    `SELECT p.id, p.source_id, p.slug, ${TITLE_SQL} AS title, p.type, ${DEGREE_SQL} AS degree
       FROM (
         SELECT p.id FROM pages p
          WHERE p.deleted_at IS NULL AND ($5::text IS NULL OR p.source_id = $5)
            AND (p.title ILIKE $2 OR p.slug ILIKE $2)
          ORDER BY (p.slug = $1 OR lower(p.title) = lower($1)) DESC, (p.title ILIKE $3) DESC,
                   length(COALESCE(p.title, p.slug)), p.id
          LIMIT $4
       ) hit JOIN pages p ON p.id = hit.id
      ORDER BY (p.slug = $1 OR lower(p.title) = lower($1)) DESC, (p.title ILIKE $3) DESC,
               length(COALESCE(p.title, p.slug)), p.id`,
    [q, `%${esc}%`, `${esc}%`, limit, opts.sourceId ?? null], { timeoutMs: GRAPH_QUERY_TIMEOUT_MS });
  return rows.map(r => ({ ...toPageRef(r), degree: Number(r.degree) }));
}

export interface GraphPageDetail extends GraphPageRef {
  created_at: string | null;
  updated_at: string | null;
  excerpt: string;
  links: Array<{ link_type: string; direction: 'in' | 'out'; count: number }>;
}

function iso(v: unknown): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Side-panel detail for one live page: metadata, link counts by type, a short excerpt. */
export async function queryGraphPage(engine: BrainEngine, id: number): Promise<GraphPageDetail | null> {
  const rows = await engine.executeRaw<Row>(
    `SELECT p.id, p.source_id, p.slug, ${TITLE_SQL} AS title, p.type, p.created_at, p.updated_at,
            left(p.compiled_truth, ${GRAPH_EXCERPT_CHARS * 3}) AS body
       FROM pages p WHERE p.id = $1 AND p.deleted_at IS NULL`,
    [id], { timeoutMs: GRAPH_QUERY_TIMEOUT_MS });
  if (rows.length === 0) return null;
  const r = rows[0];
  const links = await engine.executeRaw<Row>(
    `SELECT 'out' AS direction, link_type, count(*)::int AS count FROM links WHERE from_page_id = $1 GROUP BY link_type
     UNION ALL
     SELECT 'in' AS direction, link_type, count(*)::int AS count FROM links WHERE to_page_id = $1 GROUP BY link_type
     ORDER BY count DESC, link_type, direction LIMIT 200`,
    [id], { timeoutMs: GRAPH_QUERY_TIMEOUT_MS });
  const body = String(r.body ?? '').replace(/\s+/g, ' ').trim();
  return {
    ...toPageRef(r),
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
    excerpt: body.length > GRAPH_EXCERPT_CHARS ? `${body.slice(0, GRAPH_EXCERPT_CHARS).trimEnd()}…` : body,
    links: links.map(l => ({ link_type: String(l.link_type ?? ''), direction: l.direction === 'in' ? 'in' : 'out', count: Number(l.count) })),
  };
}

export interface SourceMapSource {
  id: string;
  name: string;
  archived: boolean;
  pages: number;
  /** Live pages with at least one edge to another live page. */
  connected: number;
  isolated: number;
  /** Edges whose endpoints are both in this source. */
  internal_edges: number;
}

export interface SourceMapResult {
  generated_at: string;
  sources: SourceMapSource[];
  /** Directed source pairs with their edge count (from_source != to_source). */
  cross: Array<{ from_source: string; to_source: string; edges: number }>;
  link_types: Array<{ link_type: string; edges: number }>;
}

/**
 * Whole-brain source map in one aggregate statement, so the pages heap is
 * scanned once (the live-page set is materialized and reused for the page
 * counts, both edge endpoints and the connected-page counts). Only id,
 * source_id and deleted_at are read from pages. Measured on the production
 * brain with the earlier three-scan form: 42.7 s end to end; the endpoint
 * memoizes the result (GRAPH_SOURCE_MAP_TTL_MS).
 */
export async function querySourceMap(engine: BrainEngine): Promise<SourceMapResult> {
  const opts = { timeoutMs: GRAPH_AGGREGATE_TIMEOUT_MS };
  const sourceRows = await engine.executeRaw<Row>(`SELECT id, name, archived FROM sources ORDER BY id LIMIT 1000`, [], opts);
  const rows = await engine.executeRaw<Row>(
    `WITH live AS MATERIALIZED (
       SELECT id, source_id FROM pages WHERE deleted_at IS NULL
     ),
     e AS MATERIALIZED (
       SELECT l.from_page_id AS f, l.to_page_id AS t, pf.source_id AS sf, pt.source_id AS st, l.link_type
         FROM links l
         JOIN live pf ON pf.id = l.from_page_id
         JOIN live pt ON pt.id = l.to_page_id
        WHERE l.from_page_id <> l.to_page_id
     )
     SELECT 'pages' AS kind, source_id AS a, NULL::text AS b, NULL::text AS link_type, count(*)::int AS n FROM live GROUP BY source_id
     UNION ALL
     SELECT 'edges', sf, st, link_type, count(*)::int FROM e GROUP BY sf, st, link_type
     UNION ALL
     SELECT 'connected', s, NULL, NULL, count(*)::int FROM (SELECT f AS id, sf AS s FROM e UNION SELECT t, st FROM e) c GROUP BY s`,
    [], opts);
  const pageRows = rows.filter(r => r.kind === 'pages');
  const connectedRows = rows.filter(r => r.kind === 'connected');
  const edgeRows = rows.filter(r => r.kind === 'edges').map(r => ({ from_source: r.a, to_source: r.b, link_type: r.link_type, edges: r.n }));

  const pages = new Map(pageRows.map(r => [String(r.a), Number(r.n)]));
  const connected = new Map(connectedRows.map(r => [String(r.a), Number(r.n)]));
  const internal = new Map<string, number>();
  const cross = new Map<string, { from_source: string; to_source: string; edges: number }>();
  const types = new Map<string, number>();
  for (const r of edgeRows) {
    const from = String(r.from_source);
    const to = String(r.to_source);
    const n = Number(r.edges);
    const type = String(r.link_type ?? '');
    types.set(type, (types.get(type) ?? 0) + n);
    if (from === to) internal.set(from, (internal.get(from) ?? 0) + n);
    else {
      const key = `${from}\u0000${to}`;
      const entry = cross.get(key) ?? { from_source: from, to_source: to, edges: 0 };
      entry.edges += n;
      cross.set(key, entry);
    }
  }
  const named = new Map(sourceRows.map(r => [String(r.id), r]));
  const ids = new Set([...named.keys(), ...pages.keys()]);
  const sources: SourceMapSource[] = [...ids].map(id => {
    const p = pages.get(id) ?? 0;
    const c = connected.get(id) ?? 0;
    const row = named.get(id);
    return {
      id,
      name: String(row?.name ?? id),
      archived: row?.archived === true,
      pages: p,
      connected: c,
      isolated: Math.max(0, p - c),
      internal_edges: internal.get(id) ?? 0,
    };
  }).sort((a, b) => b.pages - a.pages || a.id.localeCompare(b.id));
  return {
    generated_at: new Date().toISOString(),
    sources,
    cross: [...cross.values()].sort((a, b) => b.edges - a.edges || a.from_source.localeCompare(b.from_source) || a.to_source.localeCompare(b.to_source)),
    link_types: [...types].map(([link_type, edges]) => ({ link_type, edges })).sort((a, b) => b.edges - a.edges || a.link_type.localeCompare(b.link_type)),
  };
}

/** The most connected live pages of one source (entry points from the source map). */
export async function querySourceTopPages(engine: BrainEngine, sourceId: string, limit = 20): Promise<GraphSearchHit[]> {
  const n = clampGraphLimit(limit, 20, GRAPH_TOP_PAGES_MAX_LIMIT);
  const rows = await engine.executeRaw<Row>(
    `SELECT p.id, p.source_id, p.slug, ${TITLE_SQL} AS title, p.type, d.degree
       FROM (
         SELECT x.id, count(*)::int AS degree FROM (
           SELECT l.from_page_id AS id FROM links l JOIN pages s ON s.id = l.from_page_id
            WHERE s.source_id = $1 AND l.from_page_id <> l.to_page_id
           UNION ALL
           SELECT l.to_page_id AS id FROM links l JOIN pages s ON s.id = l.to_page_id
            WHERE s.source_id = $1 AND l.from_page_id <> l.to_page_id
         ) x GROUP BY x.id
       ) d
       JOIN pages p ON p.id = d.id
      WHERE p.deleted_at IS NULL
      ORDER BY d.degree DESC, p.slug, p.id
      LIMIT $2`,
    [sourceId, n], { timeoutMs: GRAPH_AGGREGATE_TIMEOUT_MS });
  return rows.map(r => ({ ...toPageRef(r), degree: Number(r.degree) }));
}

/**
 * Single-flight TTL memo for the aggregate endpoints: concurrent callers
 * share one in-flight query; a failure is not cached.
 */
export function createTtlMemo<T>(ttlMs: number, now: () => number = Date.now) {
  const entries = new Map<string, { at: number; value: Promise<T> }>();
  return (key: string, load: () => Promise<T>): Promise<T> => {
    const hit = entries.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const value = load();
    entries.set(key, { at: now(), value });
    value.catch(() => { if (entries.get(key)?.value === value) entries.delete(key); });
    return value;
  };
}
