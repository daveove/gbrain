/**
 * #4352 — page-level `visibility: private` enforcement for untrusted callers.
 *
 * Pages have carried `frontmatter.visibility` for a long time (the `remember`
 * verb documents "private: local CLI reads only"), but nothing on the READ
 * side ever enforced it for pages: a remote/MCP caller could retrieve a
 * `visibility: private` page through search, recall's query arm, entity
 * cards, context_pack — and the sibling read ops (get_page/fetch/list_pages,
 * get_chunks/get_versions/get_timeline/get_raw_data, resolve_slugs,
 * get_links/get_backlinks/traverse_graph). This module is the single
 * trust+config resolver:
 *
 *   ctx.remote === false          → see everything (trusted local CLI)
 *   GBRAIN_REMOTE_PRIVATE_PAGES=1 → operator opt-out, retain owner aggregate protection
 *   config search.remote_private_pages ∈ {visible,true,1}
 *                                 → operator opt-out, retain owner aggregate protection
 *   otherwise                     → exclude private pages (FAIL-CLOSED default)
 *
 * The SQL predicate itself lives in buildVisibilityClause (sql-ranking.ts)
 * behind SearchOpts.excludePrivate; this resolver decides whether to set it.
 */

import type { BrainEngine } from '../engine.ts';

export const REMOTE_PRIVATE_PAGES_KEY = 'search.remote_private_pages';

/**
 * Raw SQL predicate hiding `visibility: private` pages (absent visibility
 * defaults to 'world'). Single source of truth for the fragment — consumed by
 * buildVisibilityClause (search paths), both engines' listPages, the
 * relational-arm hydrate, and get_page's fuzzy-candidate filter. `pageAlias`
 * is a code-provided literal, never user input.
 */
/** Ordinary private visibility can be opted out; generated owner aggregates cannot. */
export type PageVisibilityFilter = boolean | 'owner-only';

export function privatePagesFilterFragment(pageAlias: string, filter: PageVisibilityFilter = true,
  identityAlias = pageAlias): string {
  if (!filter) return 'TRUE';
  const owner = `NOT COALESCE((${pageAlias}.frontmatter @> '{"dream_generated":true}'::jsonb
    AND ${identityAlias}.source_id IN ('default', 'dream')
    AND (${identityAlias}.slug ~ '^daily-memory/[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      OR (${identityAlias}.slug LIKE 'source-records/%'
        AND ${pageAlias}.frontmatter ? 'source_record_id'
        AND ${pageAlias}.frontmatter ? 'source_record_type'
        AND ${pageAlias}.frontmatter ? 'source_record_ref'))), false)`;
  return filter === 'owner-only' ? owner
    : `(COALESCE(${pageAlias}.frontmatter->>'visibility', 'world') <> 'private' AND ${owner})`;
}

/** Reserved owner-aggregate source+slug identities, independent of page metadata. */
export function isReservedOwnerAggregateIdentity(sourceId: string, slug: string): boolean {
  if (!['default', 'dream'].includes(sourceId)) return false;
  return /^daily-memory\/[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(slug)
    || slug.startsWith('source-records/');
}

export function isOwnerAggregate(page: { source_id: string; slug: string; frontmatter: Record<string, unknown> }): boolean {
  if (page.frontmatter.dream_generated !== true || !isReservedOwnerAggregateIdentity(page.source_id, page.slug)) return false;
  return /^daily-memory\/[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(page.slug)
    || ['source_record_id', 'source_record_type', 'source_record_ref'].every(key => Object.hasOwn(page.frontmatter, key));
}

export function isPageHidden(page: { source_id: string; slug: string; frontmatter: Record<string, unknown> },
  filter: PageVisibilityFilter): boolean {
  return !!filter && (isOwnerAggregate(page) || (filter === true && isPrivatePage(page.frontmatter)));
}

/** Check the actual origin, independently of joins that redact its source. */
export function privateLinkOriginFilterFragment(linkAlias: string, filter: PageVisibilityFilter = true): string {
  return `(${linkAlias}.origin_page_id IS NULL OR EXISTS (
    SELECT 1 FROM pages origin_private
    WHERE origin_private.id = ${linkAlias}.origin_page_id
      AND ${privatePagesFilterFragment('origin_private', filter)}
  ))`;
}

/** A projection's private event must stay hidden even when its join is source-redacted. */
export function privateTimelineEventFilterFragment(timelineAlias: string, filter: PageVisibilityFilter = true): string {
  return `(${timelineAlias}.event_page_id IS NULL OR EXISTS (
    SELECT 1 FROM pages event_private
    WHERE event_private.id = ${timelineAlias}.event_page_id
      AND ${privatePagesFilterFragment('event_private', filter)}
  ))`;
}

/**
 * Fact-row twin for ontology provenance: hide an observation whose provenance
 * page (`source_markdown_slug`, looked up in the fact's own source) is
 * private. Non-page provenance (e.g. `manual`) has no page row and passes;
 * deleted page rows still count (fail-closed). Keys on (facts.source_id, slug),
 * so a provenance page living in a DIFFERENT source than the fact is not
 * consulted — fail-open for cross-source provenance, acceptable under source
 * isolation because ontology_propose stamps the fact with ctx.sourceId.
 */
export function privateProvenanceFilterFragment(factAlias: string, filter: PageVisibilityFilter = true): string {
  return `NOT EXISTS (SELECT 1 FROM pages pp WHERE pp.source_id = ${factAlias}.source_id ` +
    `AND pp.slug = ${factAlias}.source_markdown_slug AND NOT (${privatePagesFilterFragment('pp', filter)}))`;
}

/**
 * Row-side twin of privatePagesFilterFragment for pages already fetched
 * (get_page / fetch read one row by slug; re-querying just to filter would
 * be a second round-trip). Same semantics: only the exact string 'private'
 * hides an ordinary page; mandatory owner aggregates use their source and identity.
 */
export function isPrivatePage(frontmatter: unknown): boolean {
  return (
    typeof frontmatter === 'object' &&
    frontmatter !== null &&
    (frontmatter as Record<string, unknown>).visibility === 'private'
  );
}

/**
 * Slugs an untrusted caller must not see enumerated: every in-scope page row
 * for the slug is `visibility: private`. A slug with at least one non-private
 * in-scope page stays visible (multi-source: private in one source, world in
 * another). Slugs with no page row at all (dangling link endpoints) are not
 * returned — they reveal nothing private. Used only for get_page's fuzzy
 * candidate enumeration; data-bearing reads authorize concrete rows in the
 * engine instead of treating a visible namesake as authorization. `scope` follows the
 * canonical precedence (federated array > scalar > nothing); with
 * `includeDeleted` unset, only live rows are considered.
 */
export async function findPrivateOnlySlugs(
  engine: BrainEngine,
  slugs: string[],
  scope: { sourceId?: string; sourceIds?: string[] } = {},
  opts: { includeDeleted?: boolean; excludePrivate?: PageVisibilityFilter } = {},
): Promise<Set<string>> {
  if (slugs.length === 0) return new Set();
  const params: unknown[] = [slugs];
  let scopeClause = '';
  if (scope.sourceIds && scope.sourceIds.length > 0) {
    params.push(scope.sourceIds);
    scopeClause = `AND p.source_id = ANY($${params.length}::text[])`;
  } else if (scope.sourceId) {
    params.push(scope.sourceId);
    scopeClause = `AND p.source_id = $${params.length}`;
  }
  const rows = await engine.executeRaw<{ slug: string }>(
    `SELECT p.slug FROM pages p
      WHERE p.slug = ANY($1::text[])
        ${opts.includeDeleted ? '' : 'AND p.deleted_at IS NULL'}
        ${scopeClause}
      GROUP BY p.slug
      HAVING bool_and(NOT (${privatePagesFilterFragment('p', opts.excludePrivate ?? true)}))`,
    params,
  );
  return new Set(rows.map(r => r.slug));
}

const CACHE_TTL_MS = 30_000;
let cache = new WeakMap<BrainEngine, { at: number; expose: boolean }>();

/** Test helper: drop the per-engine config cache. */
export function __resetPrivateVisibilityCacheForTests(): void {
  cache = new WeakMap();
}

/**
 * Should this caller's page reads exclude `visibility: private` pages?
 * `remote` follows the repo trust convention: anything that is not strictly
 * `false` is untrusted. Config lookups are cached 30s per engine; a failed
 * lookup counts as "not opted out" (fail-closed).
 */
export async function resolveExcludePrivatePages(
  engine: BrainEngine,
  remote: boolean | undefined,
): Promise<PageVisibilityFilter> {
  if (remote === false) return false; // trusted local CLI sees everything
  if (process.env.GBRAIN_REMOTE_PRIVATE_PAGES === '1') return 'owner-only'; // incident escape hatch
  const hit = cache.get(engine);
  let expose: boolean;
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    expose = hit.expose;
  } else {
    try {
      const v = await engine.getConfig(REMOTE_PRIVATE_PAGES_KEY);
      expose = v === 'visible' || v === 'true' || v === '1';
    } catch {
      expose = false; // config unreadable → enforce (fail-closed)
    }
    cache.set(engine, { at: Date.now(), expose });
  }
  return expose ? 'owner-only' : true;
}
