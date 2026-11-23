import type { EntityRef } from './link-extraction.ts';

/** Keep offsets stable while removing excluded references from every edge's context. */
export function maskExcludedLinkReferences(content: string, references: readonly EntityRef[], excluded: (ref: EntityRef) => boolean): string {
  let masked = content;
  for (const ref of references) {
    if (!excluded(ref) || ref.index === undefined) continue;
    const start = ref.index;
    const wikilink = content.startsWith('[[', start);
    const close = content.indexOf(wikilink ? ']]' : ')', start);
    if (close < 0) continue;
    const end = close + (wikilink ? 2 : 1);
    masked = masked.slice(0, start) + content.slice(start, end).replace(/[^\n]/g, ' ') + masked.slice(end);
  }
  return masked;
}
