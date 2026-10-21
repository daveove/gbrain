import type { BrainEngine } from '../../src/core/engine.ts';

/** Minimal coherent read/transaction surface for provider orchestration tests. */
export function mockEmbedProjectionEngine(overrides: Partial<Record<string, any>> = {}): BrainEngine {
  // Raw SQL the stale drain issues (the page-provenance stamp check) reads an
  // empty result set unless a test models it — the Proxy's null default would
  // throw on indexing and count the page as a failed embed.
  const revision = '00000000-0000-4000-8000-000000000001';
  const pages = new Map<string, number>();
  const pageKinds = new Map<number, string>();
  overrides = {
    executeRaw: async (sql: string) => sql.startsWith('SELECT count(*)::int AS n FROM pages p')
      && sql.includes('p.text_projection_revision IS DISTINCT FROM p.knowledge_revision') ? [{ n: 0 }] : [],
    getConfigKeys: async () => [],
    listAllSources: async () => [],
    transaction: async (run: (tx: BrainEngine) => Promise<unknown>) => run(engine),
    readPageSnapshot: async (slug: string, opts?: { sourceId?: string }) => {
      const page = overrides.getPage ? await overrides.getPage(slug, opts) : { slug, compiled_truth: 'Fixture body', timeline: '' };
      if (!page) return null;
      if (!pages.has(slug)) pages.set(slug, pages.size + 1);
      pageKinds.set(pages.get(slug)!, page.page_kind ?? (page.type === 'code' ? 'code' : 'markdown'));
      return { revision, sourceIncarnation: revision, tags: [], withdrawals: [], page: {
        id: pages.get(slug), slug, source_id: opts?.sourceId ?? 'default', title: slug,
        knowledge_revision: revision, text_projection_revision: revision, ...page,
      } };
    },
    ...overrides,
  };
  const executeRaw = overrides.executeRaw;
  overrides.executeRaw = async (sql: string, params?: unknown[]) => {
    // The one-statement indexing context: a test that models config answers it; others read defaults.
    if (sql.startsWith('SELECT (SELECT json_agg(')) {
      const [modeled] = await executeRaw(sql, params) ?? [];
      return [modeled?.found ? modeled : { config: null, found: true, chunker_version: null, corpus_generation: null,
        page_kind: pageKinds.get(Number(params?.[0])) ?? 'markdown' }];
    }
    return sql === 'SELECT archived FROM sources WHERE id=$1' ? [{ archived: false }]
      : sql.includes('FROM persistence_brain') ? [{ enabled: false }]
      : executeRaw(sql, params);
  };
  const calls: { method: string; args: any[] }[] = [];
  const track = (method: string) => (...args: any[]) => {
    calls.push({ method, args });
    if (overrides[method]) return overrides[method](...args);
    return Promise.resolve(null);
  };
  const engine = new Proxy({} as any, {
    get(_, prop: string) {
      if (prop === '_calls') return calls;
      if (overrides[prop] && typeof overrides[prop] !== 'function') return overrides[prop];
      return track(prop);
    },
  });
  return engine;
}

/** One entry per chunk the batched installPageEmbeddings UPDATE wrote: its id, vector text and chunk text. */
export function embeddingUpdates(engine: BrainEngine): Array<{ id: number; vector: string | null; text: string }> {
  // mockEmbedProjectionEngine's Proxy records every call under _calls.
  const recorded = engine as unknown as { _calls: Array<{ method: string; args: [string, unknown[]] }> };
  return recorded._calls.filter(call => call.method === 'executeRaw' && /^UPDATE content_chunks SET/.test(call.args[0])).flatMap(({ args: [, params] }) => {
    const [, ids, vectors, , , texts] = params as [number, number[], Array<string | null>, unknown, unknown, string[]];
    return ids.map((id, i) => ({ id, vector: vectors[i]!, text: texts[i]! }));
  });
}
