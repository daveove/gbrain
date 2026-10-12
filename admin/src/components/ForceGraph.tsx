import React, { useEffect, useMemo, useRef, useState } from 'react';
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force';
import { select } from 'd3-selection';
import { zoom, zoomIdentity, type ZoomBehavior } from 'd3-zoom';

/**
 * SVG force-directed graph for a few hundred nodes.
 *
 * The layout runs to rest off-screen (fixed tick budget, no live
 * simulation), so the picture never jitters; when the data changes, nodes
 * that survive keep their previous position as the starting point and
 * everything eases to the new layout in 220 ms (instant under
 * prefers-reduced-motion). Nodes are real focusable elements in rank order:
 * Tab walks them, Space selects, Enter (or double-click) activates.
 * d3-zoom owns pan / wheel / pinch on the background.
 */

export interface ForceGraphNode {
  id: string;
  /** Short on-canvas label. */
  label: string;
  /** Accessible name and hover tooltip. */
  title: string;
  radius: number;
  color: string;
  /** Draw a ring (the explorer root, the selected source). */
  ring?: boolean;
  /** Pin at the origin. */
  pinned?: boolean;
  /** Label visible without hover or selection. */
  showLabel: boolean;
}

export interface ForceGraphEdge {
  id: string;
  source: string;
  target: string;
  color: string;
  dash?: string;
  width: number;
  directed: boolean;
  /** Preferred length; defaults to 60. */
  distance?: number;
}

interface Props {
  nodes: ForceGraphNode[];
  edges: ForceGraphEdge[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onActivate?: (id: string) => void;
  /** Accessible name of the whole figure. */
  label: string;
  /** Repulsion between nodes (negative). */
  charge?: number;
  /** Centre labels under their node, one line per '\n', and keep room for them (few, large nodes). */
  labelsBelow?: boolean;
}

type Point = { x: number; y: number };
type SimNode = SimulationNodeDatum & { id: string; radius: number };
type SimLink = SimulationLinkDatum<SimNode> & { distance: number };

const TICKS = 320;
const EASE_MS = 220;

function computeLayout(nodes: ForceGraphNode[], edges: ForceGraphEdge[], previous: Map<string, Point>, charge: number, labelsBelow: boolean): Map<string, Point> {
  const neighbours = new Map<string, string[]>();
  for (const e of edges) {
    neighbours.set(e.source, [...(neighbours.get(e.source) ?? []), e.target]);
    neighbours.set(e.target, [...(neighbours.get(e.target) ?? []), e.source]);
  }
  const simNodes: SimNode[] = nodes.map((n, i) => {
    const seed = previous.get(n.id)
      ?? (neighbours.get(n.id) ?? []).map(id => previous.get(id)).find(Boolean)
      ?? { x: Math.cos(i * 2.399) * (20 + 6 * Math.sqrt(i)), y: Math.sin(i * 2.399) * (20 + 6 * Math.sqrt(i)) };
    const jitter = previous.has(n.id) ? 0 : 8;
    return {
      id: n.id, radius: n.radius,
      x: seed.x + (Math.random() - 0.5) * jitter, y: seed.y + (Math.random() - 0.5) * jitter,
      ...(n.pinned ? { fx: 0, fy: 0 } : {}),
    };
  });
  const byId = new Set(simNodes.map(n => n.id));
  const simLinks: SimLink[] = edges
    .filter(e => byId.has(e.source) && byId.has(e.target))
    .map(e => ({ source: e.source, target: e.target, distance: e.distance ?? 60 }));
  const sim = forceSimulation(simNodes)
    .force('link', forceLink<SimNode, SimLink>(simLinks).id(d => d.id).distance(l => l.distance).strength(0.6))
    .force('charge', forceManyBody<SimNode>().strength(charge).distanceMax(600))
    .force('collide', forceCollide<SimNode>(d => (labelsBelow ? Math.max(d.radius + 34, 78) : d.radius + 3)))
    .force('x', forceX<SimNode>(0).strength(0.04))
    .force('y', forceY<SimNode>(0).strength(0.04))
    .stop();
  for (let i = 0; i < TICKS; i++) sim.tick();
  return new Map(simNodes.map(n => [n.id, { x: n.x ?? 0, y: n.y ?? 0 }]));
}

export function ForceGraph({ nodes, edges, selectedId, onSelect, onActivate, label, charge = -160, labelsBelow = false }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const viewportRef = useRef<SVGGElement>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const shownRef = useRef<Map<string, Point>>(new Map());
  const [positions, setPositions] = useState<Map<string, Point>>(new Map());
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });

  // Pan / zoom: the transform is written straight to the viewport group, so
  // panning never re-renders React.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const behaviour = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.15, 4])
      .on('zoom', event => { viewportRef.current?.setAttribute('transform', event.transform.toString()); });
    select(svg).call(behaviour).on('dblclick.zoom', null);
    zoomRef.current = behaviour;
    const observer = new ResizeObserver(([entry]) => setSize({ w: entry.contentRect.width, h: entry.contentRect.height }));
    observer.observe(svg);
    return () => { observer.disconnect(); select(svg).on('.zoom', null); };
  }, []);

  const target = useMemo(() => computeLayout(nodes, edges, shownRef.current, charge, labelsBelow), [nodes, edges, charge, labelsBelow]);

  // Ease from what is on screen to the new rest layout. Frames are only an
  // animation: a timer lands the rest layout even when the browser pauses or
  // throttles requestAnimationFrame (background tab, low-power iPad), and the
  // render below draws any node without an eased position at its rest
  // position, so a new neighbourhood is never missing from the canvas.
  useEffect(() => {
    const from = shownRef.current;
    const land = () => { shownRef.current = target; setPositions(target); };
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce || from.size === 0) {
      land();
      return;
    }
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / EASE_MS);
      const k = 1 - (1 - t) * (1 - t);
      const next = new Map<string, Point>();
      for (const [id, to] of target) {
        const at = from.get(id) ?? to;
        next.set(id, { x: at.x + (to.x - at.x) * k, y: at.y + (to.y - at.y) * k });
      }
      shownRef.current = next;
      setPositions(next);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    const settle = setTimeout(() => { cancelAnimationFrame(frame); land(); }, EASE_MS + 80);
    return () => { cancelAnimationFrame(frame); clearTimeout(settle); };
  }, [target]);

  const fit = () => {
    const svg = svgRef.current;
    const behaviour = zoomRef.current;
    if (!svg || !behaviour || target.size === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const radius = new Map(nodes.map(n => [n.id, n.radius]));
    for (const [id, p] of target) {
      const r = (radius.get(id) ?? 6) + 40;
      minX = Math.min(minX, p.x - r); maxX = Math.max(maxX, p.x + r);
      minY = Math.min(minY, p.y - r); maxY = Math.max(maxY, p.y + r);
    }
    const k = Math.max(0.15, Math.min(2.2, Math.min(size.w / (maxX - minX), size.h / (maxY - minY))));
    const transform = zoomIdentity.translate(size.w / 2, size.h / 2).scale(k).translate(-(minX + maxX) / 2, -(minY + maxY) / 2);
    select(svg).call(behaviour.transform, transform);
  };
  // Refit whenever the layout or the canvas size changes.
  useEffect(fit, [target, size.w, size.h]);

  const zoomBy = (factor: number) => {
    if (svgRef.current && zoomRef.current) select(svgRef.current).call(zoomRef.current.scaleBy, factor);
  };

  const focusId = hoverId ?? selectedId;
  const lit = useMemo(() => {
    if (!focusId) return null;
    const set = new Set([focusId]);
    for (const e of edges) {
      if (e.source === focusId) set.add(e.target);
      if (e.target === focusId) set.add(e.source);
    }
    return set;
  }, [focusId, edges]);
  const radiusOf = useMemo(() => new Map(nodes.map(n => [n.id, n.radius])), [nodes]);
  const markerColors = useMemo(() => [...new Set(edges.filter(e => e.directed).map(e => e.color))], [edges]);

  return (
    <div className="graph-canvas">
      <svg ref={svgRef} role="group" aria-label={label} onClick={event => { if (event.target === svgRef.current) onSelect(null); }}>
        <defs>
          {markerColors.map(color => (
            <marker key={color} id={`arrow-${color.slice(1)}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
            </marker>
          ))}
        </defs>
        <g ref={viewportRef}>
          <g>
            {edges.map(e => {
              const a = positions.get(e.source) ?? target.get(e.source);
              const b = positions.get(e.target) ?? target.get(e.target);
              if (!a || !b) return null;
              const dx = b.x - a.x, dy = b.y - a.y;
              const len = Math.hypot(dx, dy) || 1;
              const ra = (radiusOf.get(e.source) ?? 0) + 1;
              const rb = (radiusOf.get(e.target) ?? 0) + (e.directed ? 3 : 1);
              const dim = focusId !== null && e.source !== focusId && e.target !== focusId;
              return (
                <line key={e.id}
                  x1={a.x + dx / len * ra} y1={a.y + dy / len * ra} x2={b.x - dx / len * rb} y2={b.y - dy / len * rb}
                  stroke={e.color} strokeWidth={e.width} strokeDasharray={e.dash}
                  strokeOpacity={dim ? 0.12 : 0.75}
                  markerEnd={e.directed ? `url(#arrow-${e.color.slice(1)})` : undefined} />
              );
            })}
          </g>
          <g>
            {nodes.map(n => {
              const p = positions.get(n.id) ?? target.get(n.id);
              if (!p) return null;
              const dim = lit !== null && !lit.has(n.id);
              const showLabel = n.showLabel || n.id === focusId || (lit !== null && lit.has(n.id));
              return (
                <g key={n.id} className={`graph-node${n.id === selectedId ? ' selected' : ''}`}
                  transform={`translate(${p.x},${p.y})`} opacity={dim ? 0.3 : 1}
                  tabIndex={0} role="button" aria-label={n.title} aria-pressed={n.id === selectedId}
                  onClick={() => onSelect(n.id)}
                  onDoubleClick={() => onActivate?.(n.id)}
                  onKeyDown={event => {
                    if (event.key === 'Enter') { event.preventDefault(); onActivate ? onActivate(n.id) : onSelect(n.id); }
                    else if (event.key === ' ') { event.preventDefault(); onSelect(n.id); }
                    else if (event.key === 'Escape') { onSelect(null); }
                  }}
                  onMouseEnter={() => setHoverId(n.id)} onMouseLeave={() => setHoverId(null)}
                  onFocus={() => setHoverId(n.id)} onBlur={() => setHoverId(null)}>
                  <title>{n.title}</title>
                  <circle r={Math.max(n.radius + 4, 14)} fill="transparent" />
                  {n.ring && <circle r={n.radius + 5} fill="none" stroke="#e0e0e0" strokeWidth={1.5} />}
                  <circle r={n.radius} fill={n.color} stroke={n.id === selectedId ? '#ffffff' : '#0a0a0f'} strokeWidth={n.id === selectedId ? 2.5 : 1.2} />
                  {showLabel && (
                    labelsBelow
                      ? <text y={n.radius + 15} textAnchor="middle" className="graph-label">
                          {n.label.split('\n').map((line, i) => <tspan key={i} x={0} dy={i === 0 ? 0 : 14}>{line}</tspan>)}
                        </text>
                      : <text x={n.radius + 4} y={4} className="graph-label">{n.label}</text>
                  )}
                </g>
              );
            })}
          </g>
        </g>
      </svg>
      <div className="graph-zoom" role="toolbar" aria-label="Zoom">
        <button type="button" className="btn btn-secondary" onClick={() => zoomBy(1.3)} aria-label="Zoom in">+</button>
        <button type="button" className="btn btn-secondary" onClick={() => zoomBy(1 / 1.3)} aria-label="Zoom out">−</button>
        <button type="button" className="btn btn-secondary" onClick={fit}>Fit</button>
      </div>
    </div>
  );
}
