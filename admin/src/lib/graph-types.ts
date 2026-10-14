/** Wire shapes of /admin/api/graph/* (src/core/graph-explorer.ts) and their visual encoding. */

export interface GraphPageRef {
  id: number;
  source_id: string;
  slug: string;
  title: string;
  type: string;
}

export interface GraphSearchHit extends GraphPageRef {
  degree: number;
}

export interface GraphNodeView extends GraphSearchHit {
  hop: number;
}

export interface GraphEdgeView {
  from: number;
  to: number;
  link_type: string;
  count: number;
}

export interface GraphNeighbourhood {
  root: GraphNodeView;
  nodes: GraphNodeView[];
  edges: GraphEdgeView[];
  depth: number;
  limit: number;
  candidates: number;
  truncated: boolean;
}

export interface GraphLinkCount {
  link_type: string;
  direction: 'in' | 'out';
  count: number;
}

export interface GraphPageDetail extends GraphPageRef {
  created_at: string | null;
  updated_at: string | null;
  excerpt: string;
  links: GraphLinkCount[];
}

export interface GraphSourceStats {
  id: string;
  name: string;
  archived: boolean;
  pages: number;
  connected: number;
  isolated: number;
  internal_edges: number;
}

export interface GraphSourceMap {
  generated_at: string;
  sources: GraphSourceStats[];
  cross: Array<{ from_source: string; to_source: string; edges: number }>;
  link_types: Array<{ link_type: string; edges: number }>;
}

/**
 * Colour = source family (which tool the note came from). Families are
 * matched on the source id, so dated export ids (tana-cache-20260126,
 * heptabase-export-20250411, ...) share one colour.
 */
const SOURCE_FAMILIES: Array<{ family: string; label: string; color: string; match: (id: string) => boolean }> = [
  { family: 'default', label: 'Brain (default)', color: '#6ea8fe', match: id => id === 'default' },
  { family: 'tana', label: 'Tana', color: '#b39dff', match: id => id.startsWith('tana') },
  { family: 'heptabase', label: 'Heptabase', color: '#ffb454', match: id => id.includes('heptabase') },
  { family: 'notion', label: 'Notion', color: '#d4d4d8', match: id => id.includes('notion') },
  { family: 'bear', label: 'Bear', color: '#ff7a7a', match: id => id.includes('bear') },
  { family: 'logseq', label: 'Logseq', color: '#3cc9b0', match: id => id.includes('logseq') },
  { family: 'apple-notes', label: 'Apple Notes', color: '#f5e663', match: id => id.includes('apple-notes') },
  { family: 'evernote', label: 'Evernote', color: '#9ae66e', match: id => id.includes('evernote') },
  { family: 'dream', label: 'Dream', color: '#f0abfc', match: id => id === 'dream' },
  { family: 'legacy', label: 'Legacy recovery', color: '#a3a3a3', match: id => id.startsWith('legacy') },
];
const OTHER_SOURCE = { family: 'other', label: 'Other', color: '#8b949e' };

export function sourceFamily(sourceId: string): { family: string; label: string; color: string } {
  return SOURCE_FAMILIES.find(f => f.match(sourceId)) ?? OTHER_SOURCE;
}

/** Colour + dash = link type. `duplicate` is hidden by default in the explorer. */
const LINK_STYLES: Record<string, { color: string; dash?: string }> = {
  contains: { color: '#7c8db5' },
  mentions: { color: '#9a9aab', dash: '2 3' },
  tagged: { color: '#c084fc', dash: '5 3' },
  field: { color: '#2dd4bf' },
  on_whiteboard: { color: '#f59e0b', dash: '7 3' },
  connected: { color: '#f472b6' },
  wikilink: { color: '#60a5fa' },
  'wikilink-resolved': { color: '#60a5fa' },
  duplicate: { color: '#ef4444', dash: '1 3' },
};
const OTHER_LINK = { color: '#6b6b7b' };

export function linkStyle(linkType: string): { color: string; dash?: string } {
  return LINK_STYLES[linkType] ?? OTHER_LINK;
}

export const DEFAULT_HIDDEN_LINK_TYPES = ['duplicate'];
