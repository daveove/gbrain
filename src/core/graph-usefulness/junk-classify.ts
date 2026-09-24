/**
 * Heuristic junk-slug classification for post-import graph audits (DAV-6220).
 * Patterns are intentionally conservative — counts are evidence, not delete lists.
 */

import type { JunkSlugSample } from './types.ts';

const PATTERNS: { id: string; test: (slug: string) => boolean }[] = [
  { id: 'pnpm_store', test: s => s.includes('.pnpm-store') || s.includes('pnpm-store') },
  { id: 'uuid_blob', test: s => /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(s) },
  { id: 'tana_span_html', test: s => s.includes('<span') || s.includes('data-type=') },
  { id: 'deep_path_noise', test: s => s.split('/').length >= 8 },
  { id: 'dotfile_segment', test: s => s.split('/').some(seg => seg.startsWith('.') && seg.length > 1) },
];

export function classifyJunkSlugs(slugs: string[], maxExamples = 3): JunkSlugSample[] {
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

export function slugLooksReadwise(slug: string, sourceId: string | null | undefined): boolean {
  const sid = (sourceId ?? '').toLowerCase();
  const sl = slug.toLowerCase();
  return sid === 'readwise' || sid.includes('readwise')
    || sl.startsWith('readwise/') || sl.includes('/readwise/');
}
