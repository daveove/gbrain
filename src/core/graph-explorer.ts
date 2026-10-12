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
 * Every statement carries `bound(ms)` and a LIMIT or a GROUP BY over indexed
 * keys. On Postgres `timeoutMs` is a transaction-local statement_timeout (the
 * server ends the statement); PGLite ignores it and has no cancellation, so
 * the paired abort signal bounds the caller's wait and the request fails with
 * a timeout while the in-process query runs to completion.
 */
import type { BrainEngine } from './engine.ts';
import { validateSlug } from './utils.ts';
import { edgeValidityEnabled, relationshipFilterSql } from './link-validity.ts';

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

/**
 * Deadline for one statement: `timeoutMs` (Postgres statement_timeout) plus
 * an abort signal that also fires when `cancel` does (the HTTP client went
 * away). On Postgres the signal only releases a caller still waiting for a
 * pooled connection; a running statement ends at its timeout.
 */
function bound(ms: number, cancel?: AbortSignal): { timeoutMs: number; signal: AbortSignal } {
  const deadline = AbortSignal.timeout(ms);
  return { timeoutMs: ms, signal: cancel ? AbortSignal.any([deadline, cancel]) : deadline };
}

const DEGREE_SQL = `((SELECT count(*) FROM links o WHERE o.from_page_id = p.id) + (SELECT count(*) FROM links i WHERE i.to_page_id = p.id))::int`;
const TITLE_SQL = `COALESCE(NULLIF(p.title, ''), p.slug)`;

/**
 * Live pages with exactly this slug, one probe of the (source_id, slug) key
 * per source. A bare `slug = $1` cannot use that key's leading column and
 * scans the whole index.
 */
const SLUG_LOOKUP_SQL = `SELECT p.id, p.source_id, p.slug, ${TITLE_SQL} AS title, p.type, ${DEGREE_SQL} AS degree
  FROM sources s
  CROSS JOIN LATERAL (SELECT p.id, p.source_id, p.slug, p.title, p.type FROM pages p
                       WHERE p.source_id = s.id AND p.slug = $1 AND p.deleted_at IS NULL) p
 WHERE ($2::text IS NULL OR s.id = $2)
 ORDER BY p.source_id LIMIT $3`;

/** Resolve the root page. Without a source, a slug shared by two sources is ambiguous. */
export async function resolveGraphRoot(engine: BrainEngine, slug: string, sourceId?: string): Promise<GraphPageRef | null> {
  // Ten rows are enough to report an ambiguous slug.
  const rows = await engine.executeRaw<Row>(SLUG_LOOKUP_SQL, [slug, sourceId ?? null, 10], bound(GRAPH_QUERY_TIMEOUT_MS));
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
    [ids], bound(GRAPH_QUERY_TIMEOUT_MS));
  for (const r of rows) out.set(Number(r.id), { ...toPageRef(r), degree: Number(r.degree) });
  return out;
}

/**
 * The live-by-default graph contract (`graph.edge_validity`, link-validity.ts):
 * a WHERE fragment per `links` alias that hides ended temporal relationships
 * (`TRUE` when the policy is off). Applies to every edge these views count or
 * draw; `degree` stays the raw stored-row count.
 */
async function liveLinkFilter(engine: BrainEngine): Promise<(alias: string) => string> {
  const disabled = !(await edgeValidityEnabled(engine));
  return alias => relationshipFilterSql(alias, { disabled });
}

/**
 * One hop: link rows touching `frontier` whose far endpoint is live, not in a
 * hidden source, and whose type is not hidden. Each direction reads at most
 * GRAPH_EDGE_SCAN_CAP rows in link-id order.
 */
async function expand(engine: BrainEngine, live: (alias: string) => string, frontier: number[], hideTypes: string[], hideSources: string[]): Promise<{ edges: Array<{ a: number; b: number }>; truncated: boolean }> {
  const rows = await engine.executeRaw<Row>(
    `(SELECT 'out' AS dir, l.from_page_id AS a, l.to_page_id AS b FROM links l JOIN pages p ON p.id = l.to_page_id
       WHERE l.from_page_id = ANY($1::int[]) AND l.to_page_id <> l.from_page_id AND p.deleted_at IS NULL
         AND NOT (l.link_type = ANY($2::text[])) AND NOT (p.source_id = ANY($3::text[])) AND ${live('l')}
       ORDER BY l.id LIMIT $4)
     UNION ALL
     (SELECT 'in' AS dir, l.to_page_id AS a, l.from_page_id AS b FROM links l JOIN pages p ON p.id = l.from_page_id
       WHERE l.to_page_id = ANY($1::int[]) AND l.to_page_id <> l.from_page_id AND p.deleted_at IS NULL
         AND NOT (l.link_type = ANY($2::text[])) AND NOT (p.source_id = ANY($3::text[])) AND ${live('l')}
       ORDER BY l.id LIMIT $4)`,
    [frontier, hideTypes, hideSources, GRAPH_EDGE_SCAN_CAP], bound(GRAPH_QUERY_TIMEOUT_MS));
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
  const live = await liveLinkFilter(engine);

  const kept = new Map<number, GraphNodeView>([[rootId, { ...rootInfo, hop: 0 }]]);
  const seen = new Set<number>([rootId]);

  let frontier = [rootId];
  for (let hop = 1; hop <= depth; hop++) {
    const step = await expand(engine, live, frontier, hideTypes, hideSources);
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
        AND l.from_page_id <> l.to_page_id AND NOT (l.link_type = ANY($2::text[])) AND ${live('l')}
      GROUP BY l.from_page_id, l.to_page_id, l.link_type
      ORDER BY l.from_page_id, l.to_page_id, l.link_type
      LIMIT $3`,
    [ids, hideTypes, GRAPH_EDGE_RESULT_CAP + 1], bound(GRAPH_QUERY_TIMEOUT_MS));
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
 * Input that can be a stored slug: valid under the canonical grammar
 * (validateSlug, Unicode letters and CJK allowed), already lower-case, and
 * free of whitespace.
 */
function isSlugShaped(q: string): boolean {
  if (/\s/.test(q)) return false;
  try { return validateSlug(q) === q; } catch { return false; }
}

/**
 * Title substring search for the page picker, `ILIKE '%q%'` on `title` only,
 * which the title trigram index (`idx_pages_trgm`) serves. There is no slug
 * trigram index, so slugs are matched exactly instead, and only when the
 * input is slug-shaped (see SLUG_LOOKUP_SQL). Exact slug hits come first,
 * then exact titles, prefix matches and shorter titles.
 *
 * `OFFSET 0` keeps the match scan to the title predicate alone. With
 * `deleted_at IS NULL` beside it, the planner can instead pick the partial
 * `pages_dedup_idx` (same predicate), which visits every live page; the
 * deleted and source filters run on the matches instead.
 */
export const GRAPH_TITLE_SEARCH_SQL = `SELECT p.id, p.source_id, p.slug, ${TITLE_SQL} AS title, p.type, ${DEGREE_SQL} AS degree
  FROM (
    SELECT m.id FROM (SELECT p.id, p.title, p.source_id, p.deleted_at FROM pages p WHERE p.title ILIKE $2 OFFSET 0) m
     WHERE m.deleted_at IS NULL AND ($5::text IS NULL OR m.source_id = $5)
     ORDER BY lower(m.title) = lower($1) DESC, m.title ILIKE $3 DESC, length(m.title), m.id
     LIMIT $4
  ) hit JOIN pages p ON p.id = hit.id
 ORDER BY lower(p.title) = lower($1) DESC, p.title ILIKE $3 DESC, length(p.title), p.id`;

export async function searchGraphPages(engine: BrainEngine, query: string,
  opts: { limit?: number; sourceId?: string; signal?: AbortSignal } = {}): Promise<GraphSearchHit[]> {
  const q = query.trim();
  const slugShaped = isSlugShaped(q);
  // Fewer than 3 characters give the trigram index nothing to match, so a
  // title search would read every title; only an exact slug lookup is cheap.
  if (q.length < (slugShaped ? 2 : 3)) throw new GraphRequestError('Search needs at least 3 characters (2 for an exact slug)', 400, 'query_too_short');
  if (q.length > 200) throw new GraphRequestError('Search is limited to 200 characters', 400, 'query_too_long');
  const limit = clampGraphLimit(opts.limit, 20, GRAPH_SEARCH_MAX_LIMIT);
  const bySlug = slugShaped
    ? await engine.executeRaw<Row>(SLUG_LOOKUP_SQL, [q, opts.sourceId ?? null, limit], bound(GRAPH_QUERY_TIMEOUT_MS, opts.signal))
    : [];
  const esc = q.replace(/[\\%_]/g, ch => `\\${ch}`);
  const byTitle = q.length < 3 ? [] : await engine.executeRaw<Row>(GRAPH_TITLE_SEARCH_SQL,
    [q, `%${esc}%`, `${esc}%`, limit, opts.sourceId ?? null], bound(GRAPH_QUERY_TIMEOUT_MS, opts.signal));
  const seen = new Set<number>();
  const hits: GraphSearchHit[] = [];
  for (const r of [...bySlug, ...byTitle]) {
    const id = Number(r.id);
    if (seen.has(id)) continue;
    seen.add(id);
    hits.push({ ...toPageRef(r), degree: Number(r.degree) });
  }
  return hits.slice(0, limit);
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

/** Tana node bodies above this size keep the plain-text excerpt instead of being parsed. */
const TANA_BODY_PARSE_MAX = 200_000;

/**
 * Tana imports store the node document as JSON (`{"children":[…],"id":…,
 * "props":{"name":…}}`), so the leading characters of the body are node ids.
 * Returns the readable part of such a body: `props.name`, then ` — ` and
 * `props.description`, with HTML removed and inline references replaced by
 * their text (or `[ref]` / `[date]` when the span is empty). Returns '' for
 * a Tana node that has neither, and null when the body is not a Tana node.
 */
export function tanaExcerpt(body: string): string | null {
  if (!body.startsWith('{')) return null;
  let doc: unknown;
  try { doc = JSON.parse(body); } catch { return null; }
  // A Tana node document: a string `id` and a `props` object.
  if (!doc || typeof doc !== 'object' || !('id' in doc) || typeof doc.id !== 'string'
    || !('props' in doc) || !doc.props || typeof doc.props !== 'object') return null;
  const props = doc.props;
  const clean = (raw: unknown): string => typeof raw !== 'string' ? '' : raw
    .replace(/<span[^>]*data-inlineref-(node|date)=[^>]*>(.*?)<\/span>/gis, (_m, kind: string, text: string) => text.trim() || (kind.toLowerCase() === 'date' ? '[date]' : '[ref]'))
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
  const name = clean('name' in props ? props.name : undefined);
  const description = clean('description' in props ? props.description : undefined);
  return [name, description].filter(Boolean).join(' — ');
}

/** Side-panel detail for one live page: metadata, link counts by type, a short excerpt. */
export async function queryGraphPage(engine: BrainEngine, id: number): Promise<GraphPageDetail | null> {
  // A JSON body (Tana) is read whole, up to TANA_BODY_PARSE_MAX, so it can be
  // parsed; any other body only to the excerpt window.
  const rows = await engine.executeRaw<Row>(
    `SELECT p.id, p.source_id, p.slug, ${TITLE_SQL} AS title, p.type, p.created_at, p.updated_at,
            CASE WHEN left(p.compiled_truth, 1) = '{' AND length(p.compiled_truth) <= ${TANA_BODY_PARSE_MAX}
                 THEN p.compiled_truth ELSE left(p.compiled_truth, ${GRAPH_EXCERPT_CHARS * 3}) END AS body,
            length(p.compiled_truth) AS body_length
       FROM pages p WHERE p.id = $1 AND p.deleted_at IS NULL`,
    [id], bound(GRAPH_QUERY_TIMEOUT_MS));
  if (rows.length === 0) return null;
  const r = rows[0];
  const live = await liveLinkFilter(engine);
  const links = await engine.executeRaw<Row>(
    `SELECT 'out' AS direction, l.link_type, count(*)::int AS count FROM links l WHERE l.from_page_id = $1 AND ${live('l')} GROUP BY l.link_type
     UNION ALL
     SELECT 'in' AS direction, l.link_type, count(*)::int AS count FROM links l WHERE l.to_page_id = $1 AND ${live('l')} GROUP BY l.link_type
     ORDER BY count DESC, link_type, direction LIMIT 200`,
    [id], bound(GRAPH_QUERY_TIMEOUT_MS));
  const raw = String(r.body ?? '');
  // Tana is identified by the parsed node shape, or, for a node body too large
  // to parse (cut to the excerpt window), by a Tana source holding JSON. Any
  // other body, including ordinary JSON, keeps its text.
  const tana = tanaExcerpt(raw);
  const isTana = tana !== null || (String(r.source_id).startsWith('tana') && raw.startsWith('{"') && Number(r.body_length) > TANA_BODY_PARSE_MAX);
  let text = tana ?? (isTana ? '' : raw.replace(/\s+/g, ' ').trim());
  if (isTana && text === '') {
    // A Tana node with no name or description: name what it links to instead,
    // children (`contains`) first.
    const near = await engine.executeRaw<Row>(
      `SELECT l.link_type, ${TITLE_SQL} AS title FROM links l JOIN pages p ON p.id = l.to_page_id
        WHERE l.from_page_id = $1 AND l.to_page_id <> l.from_page_id AND p.deleted_at IS NULL AND ${live('l')}
        ORDER BY (l.link_type = 'contains') DESC, l.id LIMIT 6`,
      [id], bound(GRAPH_QUERY_TIMEOUT_MS));
    if (near.length > 0) {
      const label = near[0].link_type === 'contains' ? 'contains' : 'links to';
      const titles = near.slice(0, 5).map(n => String(n.title));
      text = `${label}: ${titles.join(', ')}${near.length > 5 ? ', …' : ''}`;
    }
  }
  return {
    ...toPageRef(r),
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
    excerpt: text.length > GRAPH_EXCERPT_CHARS ? `${text.slice(0, GRAPH_EXCERPT_CHARS).trimEnd()}…` : text,
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
  const sourceRows = await engine.executeRaw<Row>(`SELECT id, name, archived FROM sources ORDER BY id LIMIT 1000`, [], bound(GRAPH_QUERY_TIMEOUT_MS));
  const live = await liveLinkFilter(engine);
  const rows = await engine.executeRaw<Row>(
    `WITH live AS MATERIALIZED (
       SELECT id, source_id FROM pages WHERE deleted_at IS NULL
     ),
     e AS MATERIALIZED (
       SELECT l.from_page_id AS f, l.to_page_id AS t, pf.source_id AS sf, pt.source_id AS st, l.link_type
         FROM links l
         JOIN live pf ON pf.id = l.from_page_id
         JOIN live pt ON pt.id = l.to_page_id
        WHERE l.from_page_id <> l.to_page_id AND ${live('l')}
     )
     SELECT 'pages' AS kind, source_id AS a, NULL::text AS b, NULL::text AS link_type, count(*)::int AS n FROM live GROUP BY source_id
     UNION ALL
     SELECT 'edges', sf, st, link_type, count(*)::int FROM e GROUP BY sf, st, link_type
     UNION ALL
     SELECT 'connected', s, NULL, NULL, count(*)::int FROM (SELECT f AS id, sf AS s FROM e UNION SELECT t, st FROM e) c GROUP BY s`,
    [], bound(GRAPH_AGGREGATE_TIMEOUT_MS));
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
  const live = await liveLinkFilter(engine);
  const rows = await engine.executeRaw<Row>(
    `SELECT p.id, p.source_id, p.slug, ${TITLE_SQL} AS title, p.type, d.degree
       FROM (
         SELECT x.id, count(*)::int AS degree FROM (
           -- Both endpoints live, as in the source map: a link to a soft-deleted
           -- page (kept for the recovery window) does not count.
           SELECT l.from_page_id AS id FROM links l JOIN pages s ON s.id = l.from_page_id
             JOIN pages o ON o.id = l.to_page_id AND o.deleted_at IS NULL
            WHERE s.source_id = $1 AND l.from_page_id <> l.to_page_id AND ${live('l')}
           UNION ALL
           SELECT l.to_page_id AS id FROM links l JOIN pages s ON s.id = l.to_page_id
             JOIN pages o ON o.id = l.from_page_id AND o.deleted_at IS NULL
            WHERE s.source_id = $1 AND l.from_page_id <> l.to_page_id AND ${live('l')}
         ) x GROUP BY x.id
       ) d
       JOIN pages p ON p.id = d.id
      WHERE p.deleted_at IS NULL
      ORDER BY d.degree DESC, p.slug, p.id
      LIMIT $2`,
    [sourceId, n], bound(GRAPH_AGGREGATE_TIMEOUT_MS));
  return rows.map(r => ({ ...toPageRef(r), degree: Number(r.degree) }));
}

/**
 * Single-flight TTL memo for the aggregate endpoints: concurrent callers
 * share one in-flight query, a result is kept for `ttlMs`, and a failure for
 * `failureTtlMs`, so reopening a view after a timeout does not run the same
 * 30-second scan again at once. At most `maxEntries` keys are kept (oldest
 * dropped first).
 */
export function createTtlMemo<T>(opts: { ttlMs: number; failureTtlMs: number; maxEntries: number; now?: () => number }) {
  const now = opts.now ?? Date.now;
  const entries = new Map<string, { at: number; ttl: number; value: Promise<T> }>();
  return (key: string, load: () => Promise<T>): Promise<T> => {
    const hit = entries.get(key);
    if (hit && now() - hit.at < hit.ttl) return hit.value;
    entries.delete(key);
    const value = load();
    const entry = { at: now(), ttl: opts.ttlMs, value };
    entries.set(key, entry);
    while (entries.size > opts.maxEntries) entries.delete(entries.keys().next().value!);
    value.catch(() => { entry.at = now(); entry.ttl = opts.failureTtlMs; });
    return value;
  };
}
