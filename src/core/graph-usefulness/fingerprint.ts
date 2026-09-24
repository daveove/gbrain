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
  const fp: GraphFingerprint = {
    active_pages: Number(r.active_pages),
    link_rows: Number(r.link_rows),
    valid_links: Number(r.valid_links),
    zero_degree_pages: Number(r.zero_degree_pages),
    sha256: '',
  };
  fp.sha256 = createHash('sha256').update(JSON.stringify({
    active_pages: fp.active_pages,
    link_rows: fp.link_rows,
    valid_links: fp.valid_links,
    zero_degree_pages: fp.zero_degree_pages,
  })).digest('hex');
  return fp;
}
