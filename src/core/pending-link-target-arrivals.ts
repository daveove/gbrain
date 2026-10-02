import type { BrainEngine } from './engine.ts';
import { resolveCandidateSources, resolveLinkFallbackDefault } from './link-reconciliation.ts';
import { isCrossSourceLinksEnabled, LINK_EXTRACTOR_VERSION_TS } from './link-extraction.ts';
import { loadAllSources, sourceAllowsOutboundCrossSourceLinks } from './sources-load.ts';
import { scanPendingLinkReferences, queuePendingOriginExtraction } from './pending-link-references.ts';

/** Wall budget for waking dormant origins after a small inline extract. */
export const INLINE_PENDING_PROBE_BUDGET_MS = Math.max(
  1000,
  Number(process.env.GBRAIN_INLINE_PENDING_PROBE_BUDGET_MS) || 60_000,
);

/** Inline extraction stamps only affected pages; arriving targets must also wake dormant origins. */
export async function probePendingOriginsForArrivedTargets(
  engine: BrainEngine,
  sourceId: string,
  opts: {
    globalBasename: boolean;
    signal?: AbortSignal;
    deadline?: number;
    after?: string;
  } = { globalBasename: false },
): Promise<{ pendingScanIncomplete: boolean; pendingScanAfter: string }> {
  const linkDefaultSourceId = await resolveLinkFallbackDefault(engine);
  const crossSource = await isCrossSourceLinksEnabled(engine);
  const outboundCrossSourceIds = new Set((await loadAllSources(engine))
    .filter(source => sourceAllowsOutboundCrossSourceLinks(source.config)).map(source => source.id));
  return scanPendingLinkReferences(engine, {
    globalBasename: opts.globalBasename,
    signal: opts.signal,
    deadline: opts.deadline,
    after: opts.after,
    versionTs: LINK_EXTRACTOR_VERSION_TS,
    sourceId,
    onReadyOrigin: originSourceId => queuePendingOriginExtraction(engine, originSourceId, sourceId),
  }, (candidate, origin, pendingSlugs, pendingSources) =>
    resolveCandidateSources(candidate, origin.slug, origin.sourceId, pendingSlugs, pendingSources,
      outboundCrossSourceIds.has(origin.sourceId), { crossSource, defaultSourceId: linkDefaultSourceId }).ok);
}
