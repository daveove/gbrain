import { createHash } from 'crypto';
import type { BrainEngine } from '../engine.ts';
import { EXTRACTION_PROVENANCE_KEY, EXTRACTION_STATUS_KEY } from '../extraction-review.ts';
import { junkMeasureSelectSql, junkPatternIds } from './junk-classify.ts';
import type { GraphFingerprint, JunkSlugSample } from './types.ts';

export interface ScopeOpts {
  sourceId?: string;
  sourceIds?: string[];
}

export interface SnapshotOpts extends ScopeOpts {
  /**
   * Canonical retrieval config from `readProofSearchPin`. When set, it is
   * part of sha256 (graph-fingerprint-v5), including `expansion_expander`
   * (`expandQuery` when the pinned mode enables expansion, otherwise null).
   * Omitted on graph-only receipts.
   */
  searchConfig?: string;
  /** Degree stats and full-corpus junk samples from this same statement. */
  measure?: boolean;
}

export interface GraphSnapshot {
  fingerprint: GraphFingerprint;
  avg_degree: number;
  median_degree: number;
  junk_slug_samples: JunkSlugSample[];
  /**
   * Zero-degree count from incident edges in either direction.
   * Zero when `measure` was not requested. The fingerprint's
   * `zero_degree_pages` stays on the retrieval predicate.
   */
  measure_zero_degree_pages: number;
}

function resolveScope(opts?: ScopeOpts): string[] | null {
  return opts?.sourceIds ?? (opts?.sourceId ? [opts.sourceId] : null);
}

/** json/jsonb from either engine: a parsed array, or a JSON string of one. */
function identityMatrix(value: unknown): unknown[][] {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(Array.isArray);
}

function stringList(value: unknown): string[] {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is string => typeof item === 'string');
}

function finiteNumber(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Cheap brain fingerprint for before/after mutation receipts.
 * Pass `searchConfig` to fold the proof's retrieval settings into sha256.
 */
export async function computeGraphFingerprint(
  engine: BrainEngine,
  opts?: SnapshotOpts,
): Promise<GraphFingerprint> {
  return (await computeGraphSnapshot(engine, opts)).fingerprint;
}

/**
 * Counts, identities, corpus revision, and source archive state from one
 * statement. With `measure`, degree stats and junk samples come from that
 * same statement so a concurrent writer cannot tear the report.
 */
export async function computeGraphSnapshot(
  engine: BrainEngine,
  opts?: SnapshotOpts,
): Promise<GraphSnapshot> {
  const scope = resolveScope(opts);
  const params: unknown[] = scope ? [scope] : [];
  const inScope = (alias: string) =>
    scope ? `${alias}.source_id = ANY($1::text[])` : 'TRUE';
  // Search hides every page on an archived source. The fingerprint uses the
  // same predicate so an archive between questions changes the snapshot.
  const pageVisible = (alias: string) =>
    `EXISTS (SELECT 1 FROM sources s WHERE s.id = ${alias}.source_id AND NOT s.archived)`;
  // Edges whose two endpoints are both in scope. Unscoped proofs keep this
  // predicate alone so an archived endpoint still drops the edge.
  const bothEndsInScope =
    `EXISTS (SELECT 1 FROM pages pf WHERE pf.id = l.from_page_id AND ${inScope('pf')} AND ${pageVisible('pf')})
     AND EXISTS (SELECT 1 FROM pages pt WHERE pt.id = l.to_page_id AND ${inScope('pt')} AND ${pageVisible('pt')})`;
  // getBacklinkCounts ranks a scoped hit by every inbound link and does not
  // filter the from-page's source. Mention edges are excluded there
  // (`IS DISTINCT FROM 'mentions'`). A scoped fingerprint must hash the same
  // edges, or a cross-source relation can reorder later proof questions
  // while sha256 stays equal.
  const inboundRankingEdge = scope
    ? `EXISTS (SELECT 1 FROM pages pt WHERE pt.id = l.to_page_id AND ${inScope('pt')} AND ${pageVisible('pt')})
       AND l.link_source IS DISTINCT FROM 'mentions'`
    : 'FALSE';
  const linkInScope = `(${bothEndsInScope}) OR (${inboundRankingEdge})`;
  // Degree for `graph measure` is connectivity, not backlink ranking.
  // linkInScope admits a cross-source edge only when its target is in scope,
  // so an in-scope page with only an outgoing edge looks zero-degree.
  // Incident edges count in either direction, including mentions, as long as
  // both endpoints are live pages on non-archived sources. Retrieval
  // fingerprints keep linkInScope.
  const measureDegreesCte = opts?.measure
    ? `,
     measure_degrees AS (
       SELECT sp.id,
         (SELECT count(*)::int FROM links l
           JOIN pages fp ON fp.id = l.from_page_id AND fp.deleted_at IS NULL
           JOIN pages tp ON tp.id = l.to_page_id AND tp.deleted_at IS NULL
           WHERE (l.from_page_id = sp.id OR l.to_page_id = sp.id)
             AND ${pageVisible('fp')}
             AND ${pageVisible('tp')}
         ) AS deg
       FROM scoped_pages sp
     )`
    : '';
  const sourceInScope = scope ? 's.id = ANY($1::text[])' : 'TRUE';
  const rowInScope = (alias: string) =>
    scope ? `${alias}.source_id = ANY($1::text[])` : 'TRUE';

  // One statement: Postgres assigns a single snapshot, so counts, page
  // identities, link identities, corpus revision, and source archive state
  // cannot tear across a concurrent commit.
  const measureSql = opts?.measure
    ? `,
       (SELECT COALESCE(avg(deg), 0)::text FROM measure_degrees) AS avg_degree,
       (SELECT COALESCE((percentile_cont(0.5) WITHIN GROUP (ORDER BY deg)), 0)::text FROM measure_degrees) AS median_degree,
       (SELECT count(*)::text FROM measure_degrees WHERE deg = 0) AS measure_zero_degree_pages,
       ${junkMeasureSelectSql()}`
    : '';
  const rows = await engine.executeRaw<Record<string, unknown> & {
    active_pages: string;
    link_rows: string;
    valid_links: string;
    zero_degree_pages: string;
    page_identities: unknown;
    link_identities: unknown;
    corpus_revision: string | null;
    source_archive: unknown;
    page_alias_revision: string | null;
    slug_alias_revision: string | null;
    measure_zero_degree_pages?: string;
  }>(
    `WITH scoped_pages AS (
       SELECT p.id, p.source_id, p.slug FROM pages p
       JOIN sources s ON s.id = p.source_id AND NOT s.archived
       WHERE p.deleted_at IS NULL AND ${inScope('p')}
     ),
     degrees AS (
       SELECT sp.id,
         (SELECT count(*)::int FROM links l
           JOIN pages fp ON fp.id = l.from_page_id AND fp.deleted_at IS NULL
           JOIN pages tp ON tp.id = l.to_page_id AND tp.deleted_at IS NULL
           WHERE (l.from_page_id = sp.id OR l.to_page_id = sp.id)
             AND (${linkInScope})
         ) AS deg
       FROM scoped_pages sp
     )${measureDegreesCte}
     SELECT
       (SELECT count(*)::text FROM scoped_pages) AS active_pages,
       (SELECT count(*)::text FROM links l WHERE ${linkInScope}) AS link_rows,
       (SELECT count(*)::text FROM links l
          JOIN pages fp ON fp.id = l.from_page_id AND fp.deleted_at IS NULL
          JOIN pages tp ON tp.id = l.to_page_id AND tp.deleted_at IS NULL
        WHERE ${linkInScope}) AS valid_links,
       (SELECT count(*)::text FROM degrees WHERE deg = 0) AS zero_degree_pages,
       COALESCE((
         SELECT json_agg(json_build_array(sp.source_id, sp.slug) ORDER BY sp.source_id, sp.slug)
         FROM scoped_pages sp
       ), '[]'::json) AS page_identities,
       COALESCE((
         SELECT json_agg(json_build_array(
           fp.source_id, fp.slug,
           tp.source_id, tp.slug,
           l.link_type, l.context,
           COALESCE(l.link_source, ''),
           COALESCE(l.link_kind, ''),
           COALESCE(op.source_id, ''),
           COALESCE(op.slug, '')
         ) ORDER BY
           fp.source_id, fp.slug,
           tp.source_id, tp.slug,
           l.link_type,
           COALESCE(l.link_source, ''),
           COALESCE(l.link_kind, ''),
           l.context,
           COALESCE(op.source_id, ''),
           COALESCE(op.slug, ''),
           l.id)
         FROM links l
         JOIN pages fp ON fp.id = l.from_page_id
         JOIN pages tp ON tp.id = l.to_page_id
         LEFT JOIN pages op ON op.id = l.origin_page_id
         WHERE ${linkInScope}
       ), '[]'::json) AS link_identities,
       COALESCE((
         SELECT md5(string_agg(page_rev, E'\n' ORDER BY source_id, slug))
         FROM (
           SELECT
             sp.source_id,
             sp.slug,
             md5(
               sp.source_id || E'\n' || sp.slug || E'\n' ||
               p.generation::text || E'\n' ||
               COALESCE(p.content_hash, '') || E'\n' ||
               md5(COALESCE(p.compiled_truth, '')) || E'\n' ||
               COALESCE((
                 SELECT md5(string_agg(
                   c.chunk_index::text || E'\n' ||
                   md5(c.chunk_text) || E'\n' ||
                   COALESCE(c.embedded_text_hash, '') || E'\n' ||
                   COALESCE(c.embedded_at::text, '') || E'\n' ||
                   COALESCE(md5(c.embedding::text), '') || E'\n' ||
                   COALESCE(md5(c.embedding_image::text), '') || E'\n' ||
                   COALESCE(md5(c.embedding_multimodal::text), '') || E'\n' ||
                   COALESCE(c.model, '') || E'\n' ||
                   COALESCE(c.modality, '')
                 , E'\n' ORDER BY c.chunk_index, c.id))
                 FROM content_chunks c
                 WHERE c.page_id = sp.id
               ), '') || E'\\n' ||
               COALESCE(p.effective_date::text, '') || E'\\n' ||
               COALESCE(p.updated_at::text, '') || E'\\n' ||
               COALESCE(p.created_at::text, '') || E'\\n' ||
               COALESCE(p.emotional_weight::text, '') || E'\\n' ||
               COALESCE(p.title, '') || E'\\n' ||
               COALESCE(p.type, '') || E'\\n' ||
               COALESCE(p.frontmatter->>'${EXTRACTION_STATUS_KEY}', '') || E'\\n' ||
               COALESCE(p.frontmatter->>'${EXTRACTION_PROVENANCE_KEY}', '') || E'\\n' ||
               COALESCE((
                 SELECT md5(string_agg(
                   t.id::text || E'\\n' || CASE WHEN t.active THEN '1' ELSE '0' END,
                   E'\\n' ORDER BY t.id))
                 FROM takes t
                 WHERE t.page_id = sp.id
               ), '')
             ) AS page_rev
           FROM scoped_pages sp
           JOIN pages p ON p.id = sp.id
         ) corpus
       ), '') AS corpus_revision,
       COALESCE((
         SELECT json_agg(json_build_array(
           s.id,
           CASE WHEN s.archived THEN 'true' ELSE 'false' END
         ) ORDER BY s.id)
         FROM sources s
         WHERE ${sourceInScope}
       ), '[]'::json) AS source_archive,
       COALESCE((
         SELECT md5(string_agg(
           pa.source_id || E'\\n' || pa.alias_norm || E'\\n' || pa.slug,
           E'\\n' ORDER BY pa.source_id, pa.alias_norm, pa.slug, pa.id))
         FROM page_aliases pa
         WHERE ${rowInScope('pa')}
       ), '') AS page_alias_revision,
       COALESCE((
         SELECT md5(string_agg(
           sa.source_id || E'\\n' || sa.alias_slug || E'\\n' || sa.canonical_slug,
           E'\\n' ORDER BY sa.source_id, sa.alias_slug, sa.canonical_slug, sa.id))
         FROM slug_aliases sa
         WHERE ${rowInScope('sa')}
       ), '') AS slug_alias_revision${measureSql}`,
    params,
  );

  const r = rows[0] ?? {
    active_pages: '0', link_rows: '0', valid_links: '0', zero_degree_pages: '0',
    page_identities: [],
    link_identities: [],
    corpus_revision: '',
    source_archive: [],
  };
  const pages = identityMatrix(r.page_identities);
  const links = identityMatrix(r.link_identities);
  const sourceArchive = identityMatrix(r.source_archive);
  const corpusRevision = typeof r.corpus_revision === 'string' ? r.corpus_revision : '';
  const pageAliasRevision = typeof r.page_alias_revision === 'string' ? r.page_alias_revision : '';
  const slugAliasRevision = typeof r.slug_alias_revision === 'string' ? r.slug_alias_revision : '';

  const fp: GraphFingerprint = {
    active_pages: Number(r.active_pages),
    link_rows: Number(r.link_rows),
    valid_links: Number(r.valid_links),
    zero_degree_pages: Number(r.zero_degree_pages),
    sha256: '',
  };
  // Counts stay on the public receipt. The hash also covers identities, a
  // content/chunk/ranking revision, alias tables, and each source's archived
  // flag. Replacing one edge with another, rewriting page content, changing
  // a ranking input (effective date, emotional weight, active takes, title,
  // type, aliases), or archiving a source changes sha256. Archived sources
  // are omitted from page inputs, matching search. Scoped link inputs also
  // keep every non-mention inbound edge into those pages, including edges
  // whose from-page is outside the source, matching getBacklinkCounts. All of those
  // inputs come from the same statement, so they share one snapshot. Proof
  // callers also pass the effective search configuration; that uses a
  // distinct version tag so graph-only receipts stay comparable with each
  // other.
  const searchConfig = opts?.searchConfig;
  const hash = createHash('sha256');
  hash.update(searchConfig !== undefined ? 'graph-fingerprint-v5\n' : 'graph-fingerprint-v4\n');
  hash.update(JSON.stringify({
    active_pages: fp.active_pages,
    link_rows: fp.link_rows,
    valid_links: fp.valid_links,
    zero_degree_pages: fp.zero_degree_pages,
  }));
  hash.update('\n');
  for (const p of pages) {
    hash.update(JSON.stringify(p));
    hash.update('\n');
  }
  hash.update('\n');
  for (const l of links) {
    hash.update(JSON.stringify(l));
    hash.update('\n');
  }
  hash.update('\n');
  hash.update(corpusRevision);
  hash.update('\n');
  for (const source of sourceArchive) {
    hash.update(JSON.stringify(source));
    hash.update('\n');
  }
  hash.update(pageAliasRevision);
  hash.update('\n');
  hash.update(slugAliasRevision);
  hash.update('\n');
  if (searchConfig !== undefined) {
    hash.update('\n');
    hash.update(searchConfig);
    hash.update('\n');
  }
  fp.sha256 = hash.digest('hex');
  const junk_slug_samples: JunkSlugSample[] = [];
  if (opts?.measure) {
    for (const id of junkPatternIds()) {
      const count = finiteNumber(r[`junk_${id}_n`]);
      if (count <= 0) continue;
      junk_slug_samples.push({
        pattern: id,
        count,
        examples: stringList(r[`junk_${id}_examples`]),
      });
    }
  }
  return {
    fingerprint: fp,
    avg_degree: opts?.measure ? finiteNumber(r.avg_degree) : 0,
    median_degree: opts?.measure ? finiteNumber(r.median_degree) : 0,
    junk_slug_samples,
    measure_zero_degree_pages: opts?.measure ? finiteNumber(r.measure_zero_degree_pages) : 0,
  };
}
