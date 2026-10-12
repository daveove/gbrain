/**
 * Owner-only graph explorer endpoints for the admin SPA (#graph):
 *
 *   GET /admin/api/graph/search?q=&source=&limit=
 *   GET /admin/api/graph/neighbourhood?id= | ?slug=&source= [&depth=&limit=&hide_types=&hide_sources=]
 *   GET /admin/api/graph/page?id=
 *   GET /admin/api/graph/sources                 (memoized GRAPH_SOURCE_MAP_TTL_MS)
 *   GET /admin/api/graph/sources/:id/top?limit=  (memoized per source and limit)
 *
 * Every route carries requireAdmin; the SQL and its bounds live in
 * src/core/graph-explorer.ts.
 */
import type { Express, Request, Response } from 'express';
import {
  GraphRequestError,
  createTtlMemo,
  queryGraphNeighbourhood,
  queryGraphPage,
  querySourceMap,
  querySourceTopPages,
  resolveGraphRoot,
  searchGraphPages,
  type GraphSearchHit,
  type SourceMapResult,
} from '../core/graph-explorer.ts';
import type { ServeHttpContext } from './serve-http.ts';

export const GRAPH_SOURCE_MAP_TTL_MS = 5 * 60_000;

function sendGraphError(res: Response, e: unknown): void {
  if (e instanceof GraphRequestError) {
    res.status(e.status).json({ error: e.code, message: e.message, ...e.details });
    return;
  }
  // Postgres SQLSTATE 57014: the statement ran past its transaction-local
  // statement_timeout. AbortError / TimeoutError: the paired signal deadline
  // fired (PGLite, or a saturated Postgres pool).
  const timedOut = (e && typeof e === 'object' && 'code' in e && e.code === '57014')
    || (e instanceof DOMException && (e.name === 'AbortError' || e.name === 'TimeoutError'));
  if (timedOut) {
    res.status(503).json({ error: 'graph_query_timeout', message: 'The graph query hit its statement timeout. Narrow the request (depth 1, fewer nodes) and retry.' });
    return;
  }
  res.status(503).json({ error: 'service_unavailable' });
}

/** Comma list query param -> trimmed non-empty values (max 50). */
function graphListParam(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw === '') return [];
  return raw.split(',').map(s => s.trim()).filter(Boolean).slice(0, 50);
}

function graphIdParam(raw: unknown): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) throw new GraphRequestError('id must be a positive integer', 400, 'invalid_id');
  return id;
}

function graphStringParam(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw !== '' ? raw : undefined;
}

export function mountAdminGraphApi(app: Express, ctx: ServeHttpContext): void {
  const { engine, requireAdmin } = ctx;
  const sourceMapMemo = createTtlMemo<SourceMapResult>(GRAPH_SOURCE_MAP_TTL_MS);
  const topPagesMemo = createTtlMemo<GraphSearchHit[]>(GRAPH_SOURCE_MAP_TTL_MS);

  app.get('/admin/api/graph/search', requireAdmin, async (req: Request, res: Response) => {
    try {
      res.json(await searchGraphPages(engine, String(req.query.q ?? ''), {
        limit: req.query.limit === undefined ? undefined : Number(req.query.limit),
        sourceId: graphStringParam(req.query.source),
      }));
    } catch (e) {
      sendGraphError(res, e);
    }
  });

  app.get('/admin/api/graph/neighbourhood', requireAdmin, async (req: Request, res: Response) => {
    try {
      let rootId: number;
      if (req.query.id !== undefined) rootId = graphIdParam(req.query.id);
      else {
        const slug = graphStringParam(req.query.slug);
        if (!slug) throw new GraphRequestError('Pass id, or slug (and source when the slug exists in several sources).', 400, 'missing_root');
        const root = await resolveGraphRoot(engine, slug, graphStringParam(req.query.source));
        if (!root) throw new GraphRequestError('Page not found', 404, 'not_found');
        rootId = root.id;
      }
      res.json(await queryGraphNeighbourhood(engine, rootId, {
        depth: req.query.depth === undefined ? undefined : Number(req.query.depth),
        limit: req.query.limit === undefined ? undefined : Number(req.query.limit),
        hideLinkTypes: graphListParam(req.query.hide_types),
        hideSources: graphListParam(req.query.hide_sources),
      }));
    } catch (e) {
      sendGraphError(res, e);
    }
  });

  app.get('/admin/api/graph/page', requireAdmin, async (req: Request, res: Response) => {
    try {
      const page = await queryGraphPage(engine, graphIdParam(req.query.id));
      if (!page) throw new GraphRequestError('Page not found', 404, 'not_found');
      res.json(page);
    } catch (e) {
      sendGraphError(res, e);
    }
  });

  app.get('/admin/api/graph/sources', requireAdmin, async (_req: Request, res: Response) => {
    try {
      res.json(await sourceMapMemo('all', () => querySourceMap(engine)));
    } catch (e) {
      sendGraphError(res, e);
    }
  });

  app.get('/admin/api/graph/sources/:id/top', requireAdmin, async (req: Request, res: Response) => {
    try {
      const sourceId = String(req.params.id);
      const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
      res.json(await topPagesMemo(`${sourceId}\u0000${limit}`, () => querySourceTopPages(engine, sourceId, limit)));
    } catch (e) {
      sendGraphError(res, e);
    }
  });
}
