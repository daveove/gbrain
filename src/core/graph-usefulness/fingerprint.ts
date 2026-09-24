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

  const rows = await engine.executeRaw<{
    active_pages: string;
    link_rows: string;
    valid_links: string;
    zero_degree_pages: string;
  }>(
    `WITH scoped_pages AS (
       SELECT p.id FROM pages p
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
       (SELECT count(*)::text FROM degrees WHERE deg = 0) AS zero_degree_pages`,
    params,
  );

  const r = rows[0] ?? {
    active_pages: '0', link_rows: '0', valid_links: '0', zero_degree_pages: '0',
  };
  const pages = await engine.executeRaw<{ source_id: string; slug: string }>(
    `SELECT p.source_id, p.slug
     FROM pages p
     WHERE p.deleted_at IS NULL AND ${inScope('p')}
     ORDER BY p.source_id, p.slug`,
    params,
  );
  const links = await engine.executeRaw<{
    from_source_id: string;
    from_slug: string;
    to_source_id: string;
    to_slug: string;
    link_type: string;
    context: string;
    link_source: string;
    link_kind: string;
    origin_source_id: string;
    origin_slug: string;
  }>(
    `SELECT
       fp.source_id AS from_source_id,
       fp.slug AS from_slug,
       tp.source_id AS to_source_id,
       tp.slug AS to_slug,
       l.link_type,
       l.context,
       COALESCE(l.link_source, '') AS link_source,
       COALESCE(l.link_kind, '') AS link_kind,
       COALESCE(op.source_id, '') AS origin_source_id,
       COALESCE(op.slug, '') AS origin_slug
     FROM links l
     JOIN pages fp ON fp.id = l.from_page_id
     JOIN pages tp ON tp.id = l.to_page_id
     LEFT JOIN pages op ON op.id = l.origin_page_id
     WHERE ${linkInScope}
     ORDER BY
       fp.source_id, fp.slug,
       tp.source_id, tp.slug,
       l.link_type,
       COALESCE(l.link_source, ''),
       COALESCE(l.link_kind, ''),
       l.context,
       COALESCE(op.source_id, ''),
       COALESCE(op.slug, ''),
       l.id`,
    params,
  );

  const fp: GraphFingerprint = {
    active_pages: Number(r.active_pages),
    link_rows: Number(r.link_rows),
    valid_links: Number(r.valid_links),
    zero_degree_pages: Number(r.zero_degree_pages),
    sha256: '',
  };
  // Counts stay on the public receipt. The hash also covers identities so
  // replacing one edge with another (same counts) changes sha256.
  const hash = createHash('sha256');
  hash.update('graph-fingerprint-v2\n');
  hash.update(JSON.stringify({
    active_pages: fp.active_pages,
    link_rows: fp.link_rows,
    valid_links: fp.valid_links,
    zero_degree_pages: fp.zero_degree_pages,
  }));
  hash.update('\n');
  for (const p of pages) {
    hash.update(JSON.stringify([p.source_id, p.slug]));
    hash.update('\n');
  }
  hash.update('\n');
  for (const l of links) {
    hash.update(JSON.stringify([
      l.from_source_id, l.from_slug,
      l.to_source_id, l.to_slug,
      l.link_type, l.context, l.link_source, l.link_kind,
      l.origin_source_id, l.origin_slug,
    ]));
    hash.update('\n');
  }
  fp.sha256 = hash.digest('hex');
  return fp;
}
