import type { BrainEngine } from '../engine.ts';
import { classifyJunkSlugs } from './junk-classify.ts';
import { computeGraphFingerprint, type ScopeOpts } from './fingerprint.ts';
import type { GraphMeasureResult } from './types.ts';

export async function measureGraphUsefulness(
  engine: BrainEngine,
  opts?: ScopeOpts,
): Promise<GraphMeasureResult> {
  const scope = opts?.sourceIds ?? (opts?.sourceId ? [opts.sourceId] : null);
  const inScope = (alias: string) =>
    scope ? `${alias}.source_id = ANY($1::text[])` : 'TRUE';
  // Same active-source predicate as the fingerprint. Archived corpora must
  // not enter average/median degree or junk-slug samples.
  const pageVisible = (alias: string) =>
    `EXISTS (SELECT 1 FROM sources s WHERE s.id = ${alias}.source_id AND NOT s.archived)`;
  const linkScope =
    `EXISTS (SELECT 1 FROM pages pf WHERE pf.id = l.from_page_id AND ${inScope('pf')} AND ${pageVisible('pf')})
     AND EXISTS (SELECT 1 FROM pages pt WHERE pt.id = l.to_page_id AND ${inScope('pt')} AND ${pageVisible('pt')})`;
  const params = scope ? [scope] : [];
  const pageScope = `${inScope('p')} AND ${pageVisible('p')}`;

  const degreeRows = await engine.executeRaw<{
    avg_degree: string | null;
    median_degree: string | null;
  }>(
    `WITH scoped_pages AS (
       SELECT p.id FROM pages p WHERE p.deleted_at IS NULL AND (${pageScope})
     ),
     degrees AS (
       SELECT sp.id,
         (SELECT count(*)::int FROM links l
           JOIN pages fp ON fp.id = l.from_page_id AND fp.deleted_at IS NULL
           JOIN pages tp ON tp.id = l.to_page_id AND tp.deleted_at IS NULL
           WHERE (l.from_page_id = sp.id OR l.to_page_id = sp.id)
             AND (${linkScope})
         ) AS deg
       FROM scoped_pages sp
     )
     SELECT
       COALESCE(avg(deg), 0)::text AS avg_degree,
       COALESCE((percentile_cont(0.5) WITHIN GROUP (ORDER BY deg)), 0)::text AS median_degree
     FROM degrees`,
    params,
  );

  const slugRows = await engine.executeRaw<{ slug: string }>(
    `SELECT slug FROM pages p WHERE p.deleted_at IS NULL AND (${pageScope}) ORDER BY slug LIMIT 50000`,
    params,
  );
  const slugs = slugRows.map(r => r.slug);

  const fingerprint = await computeGraphFingerprint(engine, opts);

  const deg = degreeRows[0];
  return {
    active_pages: fingerprint.active_pages,
    link_rows: fingerprint.link_rows,
    valid_links: fingerprint.valid_links,
    zero_degree_pages: fingerprint.zero_degree_pages,
    avg_degree: Number(deg?.avg_degree ?? 0),
    median_degree: Number(deg?.median_degree ?? 0),
    junk_slug_samples: classifyJunkSlugs(slugs),
    fingerprint,
  };
}
