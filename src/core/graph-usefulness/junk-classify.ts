/**
 * Heuristic junk-slug classification for post-import graph audits (DAV-6220).
 * Patterns are intentionally conservative — counts are evidence, not delete lists.
 *
 * `sql` is the same predicate as `test`, with `SLUG` standing in for the
 * slug column. Measure aggregates with `sql` so counts cover the whole
 * scoped corpus; `test` remains the in-memory oracle.
 */

import type { JunkSlugSample } from './types.ts';

export const JUNK_EXAMPLE_LIMIT = 3;

interface JunkPattern {
  id: string;
  test: (slug: string) => boolean;
  /** Boolean SQL. `SLUG` is replaced with the slug expression. */
  sql: string;
}

const PATTERNS: readonly JunkPattern[] = [
  {
    id: 'pnpm_store',
    test: s => s.includes('.pnpm-store') || s.includes('pnpm-store'),
    sql: `position('pnpm-store' in SLUG) > 0`,
  },
  {
    id: 'uuid_blob',
    test: s => /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(s),
    sql: `SLUG ~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'`,
  },
  {
    id: 'tana_span_html',
    test: s => s.includes('<span') || s.includes('data-type='),
    sql: `(position('<span' in SLUG) > 0 OR position('data-type=' in SLUG) > 0)`,
  },
  {
    id: 'deep_path_noise',
    test: s => s.split('/').length >= 8,
    sql: `(length(SLUG) - length(replace(SLUG, '/', ''))) >= 7`,
  },
  {
    id: 'dotfile_segment',
    test: s => s.split('/').some(seg => seg.startsWith('.') && seg.length > 1),
    sql: `EXISTS (SELECT 1 FROM unnest(string_to_array(SLUG, '/')) AS seg WHERE left(seg, 1) = '.' AND length(seg) > 1)`,
  },
];

export function classifyJunkSlugs(slugs: string[], maxExamples = JUNK_EXAMPLE_LIMIT): JunkSlugSample[] {
  const out: JunkSlugSample[] = [];
  for (const { id, test } of PATTERNS) {
    const hits = slugs.filter(test);
    if (hits.length === 0) continue;
    out.push({
      pattern: id,
      count: hits.length,
      examples: hits.slice(0, maxExamples),
    });
  }
  return out;
}

/** Count + capped example columns. Counts have no row limit; examples do. */
export function junkMeasureSelectSql(): string {
  return PATTERNS.map(p => {
    const pred = p.sql.replaceAll('SLUG', 'sp.slug');
    const id = p.id;
    return `(SELECT count(*)::text FROM scoped_pages sp WHERE ${pred}) AS junk_${id}_n,
       COALESCE((
         SELECT json_agg(slug ORDER BY slug, source_id)
         FROM (
           SELECT sp.slug AS slug, sp.source_id AS source_id
           FROM scoped_pages sp
           WHERE ${pred}
           ORDER BY sp.slug, sp.source_id
           LIMIT ${JUNK_EXAMPLE_LIMIT}
         ) junk_${id}_ex
       ), '[]'::json) AS junk_${id}_examples`;
  }).join(',\n       ');
}

export function junkPatternIds(): string[] {
  return PATTERNS.map(p => p.id);
}

export function slugLooksReadwise(slug: string, sourceId: string | null | undefined): boolean {
  const sid = (sourceId ?? '').toLowerCase();
  const sl = slug.toLowerCase();
  return sid === 'readwise' || sid.includes('readwise')
    || sl.startsWith('readwise/') || sl.includes('/readwise/');
}
