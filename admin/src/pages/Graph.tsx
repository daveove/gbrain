import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { ForceGraph, type ForceGraphEdge, type ForceGraphNode } from '../components/ForceGraph';
import {
  DEFAULT_HIDDEN_LINK_TYPES, linkStyle, sourceFamily,
  type GraphNeighbourhood, type GraphPageDetail, type GraphSearchHit, type GraphSourceMap, type GraphSourceStats,
} from '../lib/graph-types';

/**
 * #graph — two views of the link graph.
 *
 * Explorer (#graph?id=N): the ego network of one page, most connected
 * neighbours first, capped server-side. Source map (#graph?view=sources):
 * one node per source, edges = cross-source link counts.
 */

type GraphRoute = { view: 'explorer'; id: number | null } | { view: 'sources' };

function readRoute(): GraphRoute {
  const query = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
  if (query.get('view') === 'sources') return { view: 'sources' };
  const id = Number(query.get('id'));
  return { view: 'explorer', id: Number.isInteger(id) && id > 0 ? id : null };
}

function go(route: GraphRoute): void {
  window.location.hash = route.view === 'sources' ? 'graph?view=sources' : route.id ? `graph?id=${route.id}` : 'graph';
}

const fmt = new Intl.NumberFormat('en-US');
const pct = (part: number, whole: number) => (whole > 0 ? `${((part / whole) * 100).toFixed(part === whole || part === 0 ? 0 : 1)}%` : '—');

export function GraphPage() {
  const [route, setRoute] = useState<GraphRoute>(readRoute);
  const [sourceMap, setSourceMap] = useState<GraphSourceMap | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);

  useEffect(() => {
    const onHash = () => setRoute(readRoute());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // The source map is a whole-brain aggregate: load it only when its tab is
  // opened (once per visit; the server memoizes it for five minutes).
  const wantsMap = route.view === 'sources';
  useEffect(() => {
    if (!wantsMap || sourceMap) return;
    setMapError(null);
    api.graphSources().then(setSourceMap, (e: unknown) => setMapError(e instanceof Error ? e.message : String(e)));
  }, [wantsMap, sourceMap]);

  return (
    <div>
      <h1 className="page-title">Graph</h1>
      <div className="tabs" role="tablist" aria-label="Graph views">
        <button type="button" role="tab" aria-selected={route.view === 'explorer'} className={`tab tab-button${route.view === 'explorer' ? ' active' : ''}`}
          onClick={() => go({ view: 'explorer', id: route.view === 'explorer' ? route.id : null })}>Explorer</button>
        <button type="button" role="tab" aria-selected={route.view === 'sources'} className={`tab tab-button${route.view === 'sources' ? ' active' : ''}`}
          onClick={() => go({ view: 'sources' })}>Source map</button>
      </div>
      {wantsMap && mapError && <div className="warning-bar">Source map unavailable: {mapError}</div>}
      {route.view === 'sources'
        ? <SourceMapView map={sourceMap} />
        : <ExplorerView rootId={route.id} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function PageSearch({ onPick }: { onPick: (hit: GraphSearchHit) => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<GraphSearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // "/" focuses search from anywhere on the page that is not a text field.
    const onKey = (event: KeyboardEvent) => {
      const el = document.activeElement;
      if (event.key === '/' && !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    // Results always belong to the text in the box: drop the previous list as
    // soon as the query changes and reopen only for this query's response.
    setHits([]);
    setOpen(false);
    const term = q.trim();
    if (term.length < 2) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      api.graphSearch(term, abort.signal).then(found => { setHits(found); setActive(0); setOpen(true); }, () => {});
    }, 220);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [q]);

  const pick = (hit: GraphSearchHit) => { onPick(hit); setOpen(false); setQ(''); inputRef.current?.blur(); };

  return (
    <div className="graph-search">
      <label htmlFor="graph-search-input" className="visually-hidden">Search pages by title or slug</label>
      <input id="graph-search-input" ref={inputRef} type="search" role="combobox" autoComplete="off"
        aria-expanded={open && hits.length > 0} aria-controls="graph-search-results"
        aria-activedescendant={open && hits[active] ? `graph-hit-${hits[active].id}` : undefined}
        placeholder="Search a page by title or slug  ( / )" value={q}
        onChange={event => setQ(event.target.value)}
        onFocus={() => hits.length > 0 && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={event => {
          if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); setActive(i => Math.min(hits.length - 1, i + 1)); }
          else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(i => Math.max(0, i - 1)); }
          else if (event.key === 'Enter' && hits[active]) { event.preventDefault(); pick(hits[active]); }
          else if (event.key === 'Escape') setOpen(false);
        }} />
      {open && q.trim().length >= 2 && (
        <ul id="graph-search-results" role="listbox" className="graph-results">
          {hits.length === 0 && <li className="graph-results-empty">No page matches “{q.trim()}”.</li>}
          {hits.map((hit, i) => (
            <li key={hit.id} id={`graph-hit-${hit.id}`} role="option" aria-selected={i === active}
              className={i === active ? 'active' : ''}
              onMouseDown={event => { event.preventDefault(); pick(hit); }} onMouseEnter={() => setActive(i)}>
              <span className="graph-swatch" style={{ background: sourceFamily(hit.source_id).color }} aria-hidden="true" />
              <span className="graph-result-title">{hit.title}</span>
              <span className="graph-result-meta mono">{hit.source_id} · {fmt.format(hit.degree)} links</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Explorer
// ---------------------------------------------------------------------------

const NODE_CAPS = [50, 150, 300];

function ExplorerView({ rootId }: { rootId: number | null }) {
  const [depth, setDepth] = useState(2);
  const [limit, setLimit] = useState(150);
  const [hiddenTypes, setHiddenTypes] = useState<string[]>(DEFAULT_HIDDEN_LINK_TYPES);
  const [hiddenSources, setHiddenSources] = useState<string[]>([]);
  const [data, setData] = useState<GraphNeighbourhood | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<GraphPageDetail | null>(null);

  useEffect(() => {
    if (rootId === null) { setData(null); return; }
    let alive = true;
    setLoading(true);
    api.graphNeighbourhood(rootId, { depth, limit, hideTypes: hiddenTypes, hideSources: hiddenSources })
      .then(next => { if (alive) { setData(next); setError(null); setSelected(null); } },
        // A failed request must not leave the previous neighbourhood on screen
        // under controls that now describe a different request.
        (e: unknown) => { if (alive) { setData(null); setSelected(null); setError(e instanceof Error ? e.message : String(e)); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [rootId, depth, limit, hiddenTypes, hiddenSources]);

  const focusId = selected ?? data?.root.id ?? null;
  useEffect(() => {
    if (focusId === null) { setDetail(null); return; }
    let alive = true;
    api.graphPage(focusId).then(d => { if (alive) setDetail(d); }, () => { if (alive) setDetail(null); });
    return () => { alive = false; };
  }, [focusId]);

  const { nodes, edges } = useMemo(() => {
    if (!data) return { nodes: [] as ForceGraphNode[], edges: [] as ForceGraphEdge[] };
    const graphNodes: ForceGraphNode[] = data.nodes.map((n, rank) => {
      const family = sourceFamily(n.source_id);
      return {
        id: String(n.id),
        label: n.title.length > 30 ? `${n.title.slice(0, 29)}…` : n.title,
        title: `${n.title} — ${family.label} (${n.source_id}), ${fmt.format(n.degree)} links, hop ${n.hop}`,
        radius: n.hop === 0 ? 13 : 4 + Math.min(13, Math.sqrt(n.degree) * 1.3),
        color: family.color,
        ring: n.hop === 0,
        pinned: n.hop === 0,
        showLabel: rank < 16,
      };
    });
    const graphEdges: ForceGraphEdge[] = data.edges.map(e => {
      const style = linkStyle(e.link_type);
      return {
        id: `${e.from}-${e.to}-${e.link_type}`,
        source: String(e.from), target: String(e.to),
        color: style.color, dash: style.dash,
        width: 1 + Math.min(2, Math.log2(e.count)),
        directed: true,
        distance: e.link_type === 'contains' ? 46 : 72,
      };
    });
    return { nodes: graphNodes, edges: graphEdges };
  }, [data]);

  // Filters list what this view contains (edges / pages per value) plus
  // whatever is hidden, so a hidden value can always be shown again.
  const tally = (values: string[], hidden: string[]) => {
    const counts = new Map<string, number>();
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    for (const v of hidden) if (!counts.has(v)) counts.set(v, 0);
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  };
  const linkTypes = useMemo(() => tally((data?.edges ?? []).map(e => e.link_type), hiddenTypes), [data, hiddenTypes]);
  const sources = useMemo(() => tally((data?.nodes ?? []).map(n => n.source_id), hiddenSources), [data, hiddenSources]);
  const toggle = (list: string[], value: string) => (list.includes(value) ? list.filter(v => v !== value) : [...list, value]);
  const rootSource = data?.root.source_id;

  return (
    <div className="graph-layout">
      <section className="graph-main" aria-label="Neighbourhood explorer">
        <div className="graph-toolbar">
          <PageSearch onPick={hit => go({ view: 'explorer', id: hit.id })} />
          <div className="segmented" role="group" aria-label="Depth">
            {[1, 2].map(d => (
              <button key={d} type="button" aria-pressed={depth === d} className={depth === d ? 'active' : ''} onClick={() => setDepth(d)}>
                {d} hop{d > 1 ? 's' : ''}
              </button>
            ))}
          </div>
          <label className="graph-inline-label">
            Nodes
            <select value={limit} onChange={event => setLimit(Number(event.target.value))}>
              {NODE_CAPS.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        </div>
        <p className="graph-status" role="status">
          {rootId === null ? 'Pick a page to explore.'
            : error ? <span className="graph-error">{error}</span>
            : data ? <>
                {fmt.format(data.nodes.length)} of {fmt.format(data.candidates + 1)} reachable pages within {data.depth} hop{data.depth > 1 ? 's' : ''}
                {' · '}{fmt.format(data.edges.length)} edges
                {data.truncated && ' · capped: most connected shown first'}
                {loading && ' · updating…'}
              </>
            : 'Loading…'}
        </p>
        {rootId === null || !data ? (
          <div className="graph-empty">
            {rootId !== null && error
              ? <p>This neighbourhood could not be loaded. Try 1 hop, fewer nodes, or more filters.</p>
              : <p>Search for a page above, or open the <a href="#graph?view=sources">source map</a> and pick one of a source's most connected pages.</p>}
          </div>
        ) : data.nodes.length === 1 ? (
          <div className="graph-empty">
            <p>“{data.root.title}” has no links under the current filters.</p>
          </div>
        ) : (
          <ForceGraph nodes={nodes} edges={edges}
            label={`Neighbourhood of ${data.root.title}`}
            selectedId={selected === null ? null : String(selected)}
            onSelect={id => setSelected(id === null ? null : Number(id))}
            onActivate={id => go({ view: 'explorer', id: Number(id) })} />
        )}
      </section>

      <aside className="graph-panel" aria-label="Page details and filters">
        {detail && (
          <div className="graph-detail">
            <h2>{detail.title}</h2>
            <p className="graph-detail-meta">
              <span className="graph-swatch" style={{ background: sourceFamily(detail.source_id).color }} aria-hidden="true" />
              {sourceFamily(detail.source_id).label} · <span className="mono">{detail.source_id}</span>
            </p>
            <p className="graph-detail-meta mono">{detail.slug}</p>
            <p className="graph-detail-meta">Type {detail.type || '—'}{detail.updated_at ? ` · updated ${detail.updated_at.slice(0, 10)}` : ''}</p>
            {detail.id !== data?.root.id && (
              <button type="button" className="btn btn-primary graph-recentre" onClick={() => go({ view: 'explorer', id: detail.id })}>
                Explore from here
              </button>
            )}
            <h3 className="section-title">Links</h3>
            {detail.links.length === 0 ? <p className="graph-muted">No links.</p> : (
              <table className="graph-table">
                <thead><tr><th>Type</th><th>Out</th><th>In</th></tr></thead>
                <tbody>
                  {[...new Set(detail.links.map(l => l.link_type))].map(type => (
                    <tr key={type}>
                      <td><span className="graph-line-swatch" style={{ borderTopColor: linkStyle(type).color, borderTopStyle: linkStyle(type).dash ? 'dashed' : 'solid' }} aria-hidden="true" />{type || '(untyped)'}</td>
                      <td className="mono">{fmt.format(detail.links.find(l => l.link_type === type && l.direction === 'out')?.count ?? 0)}</td>
                      <td className="mono">{fmt.format(detail.links.find(l => l.link_type === type && l.direction === 'in')?.count ?? 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {detail.excerpt && <><h3 className="section-title">Excerpt</h3><p className="graph-excerpt">{detail.excerpt}</p></>}
          </div>
        )}

        <h3 className="section-title">Link types</h3>
        <ul className="graph-filter-list">
          {linkTypes.map(([type, count]) => (
            <li key={type}>
              <label className="checkbox-label">
                <input type="checkbox" checked={!hiddenTypes.includes(type)} onChange={() => setHiddenTypes(list => toggle(list, type))} />
                <span className="graph-line-swatch" style={{ borderTopColor: linkStyle(type).color, borderTopStyle: linkStyle(type).dash ? 'dashed' : 'solid' }} aria-hidden="true" />
                {type || '(untyped)'}
                <span className="graph-count mono">{fmt.format(count)}</span>
              </label>
            </li>
          ))}
        </ul>

        <h3 className="section-title">Sources</h3>
        <ul className="graph-filter-list">
          {sources.map(([id, count]) => (
            <li key={id}>
              <label className="checkbox-label" title={id === rootSource ? 'The root page’s source is always shown' : undefined}>
                <input type="checkbox" checked={!hiddenSources.includes(id)} disabled={id === rootSource}
                  onChange={() => setHiddenSources(list => toggle(list, id))} />
                <span className="graph-swatch" style={{ background: sourceFamily(id).color }} aria-hidden="true" />
                <span className="mono graph-source-id">{id}</span>
                <span className="graph-count mono">{fmt.format(count)}</span>
              </label>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Source map
// ---------------------------------------------------------------------------

function SourceMapView({ map }: { map: GraphSourceMap | null }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [top, setTop] = useState<GraphSearchHit[] | null>(null);
  const [topError, setTopError] = useState<string | null>(null);

  useEffect(() => {
    setTop(null);
    setTopError(null);
    if (!selected) return;
    let alive = true;
    api.graphSourceTop(selected).then(rows => { if (alive) setTop(rows); },
      (e: unknown) => { if (alive) setTopError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [selected]);

  const crossBySource = useMemo(() => {
    const out = new Map<string, number>();
    for (const c of map?.cross ?? []) {
      out.set(c.from_source, (out.get(c.from_source) ?? 0) + c.edges);
      out.set(c.to_source, (out.get(c.to_source) ?? 0) + c.edges);
    }
    return out;
  }, [map]);

  const { nodes, edges } = useMemo(() => {
    const live = (map?.sources ?? []).filter(s => s.pages > 0);
    const maxPages = Math.max(1, ...live.map(s => s.pages));
    const graphNodes: ForceGraphNode[] = live.map(s => ({
      id: s.id,
      label: `${s.name.length > 30 ? `${s.name.slice(0, 29)}…` : s.name}\n${fmt.format(s.pages)} pages · ${pct(s.isolated, s.pages)} isolated`,
      title: `${s.name}: ${fmt.format(s.pages)} pages, ${pct(s.isolated, s.pages)} isolated, ${fmt.format(s.internal_edges)} internal edges, ${fmt.format(crossBySource.get(s.id) ?? 0)} cross-source edges`,
      radius: 7 + 38 * Math.sqrt(s.pages / maxPages),
      color: sourceFamily(s.id).color,
      showLabel: true,
    }));
    const pairs = new Map<string, { a: string; b: string; edges: number }>();
    for (const c of map?.cross ?? []) {
      const [a, b] = [c.from_source, c.to_source].sort();
      const key = `${a}\u0000${b}`;
      const entry = pairs.get(key) ?? { a, b, edges: 0 };
      entry.edges += c.edges;
      pairs.set(key, entry);
    }
    const graphEdges: ForceGraphEdge[] = [...pairs.values()].map(p => ({
      id: `${p.a}|${p.b}`, source: p.a, target: p.b,
      color: '#7c8db5', width: 1 + Math.min(7, Math.log10(p.edges + 1) * 1.8),
      directed: false, distance: 190,
    }));
    return { nodes: graphNodes, edges: graphEdges };
  }, [map, crossBySource]);

  if (!map) return <p className="graph-status">Loading source map…</p>;
  const chosen: GraphSourceStats | undefined = map.sources.find(s => s.id === selected);
  const totals = map.sources.reduce((t, s) => ({ pages: t.pages + s.pages, isolated: t.isolated + s.isolated }), { pages: 0, isolated: 0 });

  return (
    <div className="graph-layout">
      <section className="graph-main" aria-label="Source map">
        <p className="graph-status" role="status">
          {fmt.format(totals.pages)} live pages in {fmt.format(nodes.length)} sources · {pct(totals.isolated, totals.pages)} isolated
          {' · '}{fmt.format(map.cross.reduce((n, c) => n + c.edges, 0))} cross-source edges · as of {new Date(map.generated_at).toLocaleTimeString()}
        </p>
        <ForceGraph nodes={nodes} edges={edges} charge={-900} labelsBelow
          label="Sources sized by page count, linked by cross-source edges"
          selectedId={selected} onSelect={setSelected} />
        <table className="graph-table graph-source-table">
          <thead>
            <tr><th>Source</th><th>Pages</th><th>Connected</th><th>Isolated</th><th>Internal edges</th><th>Cross-source edges</th></tr>
          </thead>
          <tbody>
            {map.sources.map(s => (
              <tr key={s.id} className={s.id === selected ? 'selected' : ''}>
                <td>
                  <button type="button" className="client-name-button" onClick={() => setSelected(s.id)}>
                    <span className="graph-swatch" style={{ background: sourceFamily(s.id).color }} aria-hidden="true" />
                    <span className="mono">{s.id}</span>
                  </button>
                </td>
                <td className="mono">{fmt.format(s.pages)}</td>
                <td className="mono">{fmt.format(s.connected)}</td>
                <td className="mono">{pct(s.isolated, s.pages)}</td>
                <td className="mono">{fmt.format(s.internal_edges)}</td>
                <td className="mono">{fmt.format(crossBySource.get(s.id) ?? 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <aside className="graph-panel" aria-label="Source details">
        {!chosen ? (
          <p className="graph-muted">Select a source to list its most connected pages.</p>
        ) : (
          <div className="graph-detail">
            <h2>{chosen.name}</h2>
            <p className="graph-detail-meta">
              <span className="graph-swatch" style={{ background: sourceFamily(chosen.id).color }} aria-hidden="true" />
              {sourceFamily(chosen.id).label} · <span className="mono">{chosen.id}</span>
            </p>
            <p className="graph-detail-meta">
              {fmt.format(chosen.pages)} pages · {fmt.format(chosen.connected)} connected · {pct(chosen.isolated, chosen.pages)} isolated
            </p>
            <h3 className="section-title">Most connected pages</h3>
            {topError ? <p className="graph-status graph-error">Could not load this source's pages: {topError}</p>
              : top === null ? <p className="graph-muted">Loading…</p>
              : top.length === 0 ? <p className="graph-muted">No page in this source has a link yet.</p>
              : (
                <ol className="graph-top-list">
                  {top.map(p => (
                    <li key={p.id}>
                      <a href={`#graph?id=${p.id}`}>{p.title}</a>
                      <span className="graph-count mono">{fmt.format(p.degree)}</span>
                    </li>
                  ))}
                </ol>
              )}
          </div>
        )}
      </aside>
    </div>
  );
}
