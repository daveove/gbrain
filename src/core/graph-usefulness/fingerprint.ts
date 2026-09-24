import { createHash } from 'crypto';
import type { BrainEngine } from '../engine.ts';
import type { GraphFingerprint } from './types.ts';

export interface ScopeOpts {
  sourceId?: string;
  sourceIds?: string[];
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

/**
 * Cheap brain fingerprint for before/after mutation receipts.
 */
export async function computeGraphFingerprint(
  engine: BrainEngine,
  opts?: ScopeOpts,
): Promise<GraphFingerprint> {
  const scope = resolveScope(opts);
  const params: unknown[] = scope ? [scope] : [];
  const inScope = (alias: string) =>
    scope ? `${alias}.source_id = ANY($1::text[])` : 'TRUE';
  const linkInScope = scope
    ? `EXISTS (SELECT 1 FROM pages pf WHERE pf.id = l.from_page_id AND ${inScope('pf')})
       AND EXISTS (SELECT 1 FROM pages pt WHERE pt.id = l.to_page_id AND ${inScope('pt')})`
    : 'TRUE';

  // One statement: Postgres assigns a single snapshot, so counts, page
  // identities, and link identities cannot tear across a concurrent commit.
  const rows = await engine.executeRaw<{
    active_pages: string;
    link_rows: string;
    valid_links: string;
    zero_degree_pages: string;
    page_identities: unknown;
    link_identities: unknown;
    corpus_revision: string | null;
  }>(
    `WITH scoped_pages AS (
       SELECT p.id, p.source_id, p.slug FROM pages p
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
     )
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
               ), '')
             ) AS page_rev
           FROM scoped_pages sp
           JOIN pages p ON p.id = sp.id
         ) corpus
       ), '') AS corpus_revision`,
    params,
  );

  const r = rows[0] ?? {
    active_pages: '0', link_rows: '0', valid_links: '0', zero_degree_pages: '0',
    page_identities: [],
    link_identities: [],
    corpus_revision: '',
  };
  const pages = identityMatrix(r.page_identities);
  const links = identityMatrix(r.link_identities);
  const corpusRevision = typeof r.corpus_revision === 'string' ? r.corpus_revision : '';

  const fp: GraphFingerprint = {
    active_pages: Number(r.active_pages),
    link_rows: Number(r.link_rows),
    valid_links: Number(r.valid_links),
    zero_degree_pages: Number(r.zero_degree_pages),
    sha256: '',
  };
  // Counts stay on the public receipt. The hash also covers identities and
  // a content/chunk revision, so replacing one edge with another, or
  // rewriting page content, chunks, or embeddings without changing
  // (source_id, slug) or links, changes sha256. All of those inputs come
  // from the same statement, so they share one snapshot.
  const hash = createHash('sha256');
  hash.update('graph-fingerprint-v3\n');
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
  fp.sha256 = hash.digest('hex');
  return fp;
}
