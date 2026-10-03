import type { BrainEngine } from './engine.ts';
import { resolveCandidateSources, resolveLinkFallbackDefault } from './link-reconciliation.ts';
import { isCrossSourceLinksEnabled, LINK_EXTRACTOR_VERSION_TS } from './link-extraction.ts';
import { loadAllSources, sourceAllowsOutboundCrossSourceLinks } from './sources-load.ts';
import { scanPendingLinkReferences, queuePendingOriginExtraction } from './pending-link-references.ts';
import { queueDeferredStaleSweep } from './deferred-stale-extract.ts';

/** Wall budget for waking dormant origins after a small inline extract. */
export const INLINE_PENDING_PROBE_BUDGET_MS = Math.min(2000, Math.max(
  1000, Number(process.env.GBRAIN_INLINE_PENDING_PROBE_BUDGET_MS) || 2000,
));

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
  const deadline = Math.min(opts.deadline ?? Infinity, Date.now() + INLINE_PENDING_PROBE_BUDGET_MS);
  opts.signal?.throwIfAborted();
  const linkDefaultSourceId = await resolveLinkFallbackDefault(engine);
  const crossSource = await isCrossSourceLinksEnabled(engine);
  const outboundCrossSourceIds = new Set((await loadAllSources(engine))
    .filter(source => sourceAllowsOutboundCrossSourceLinks(source.config)).map(source => source.id));
  const result = await scanPendingLinkReferences(engine, {
    globalBasename: opts.globalBasename, signal: opts.signal, deadline, after: opts.after,
    versionTs: LINK_EXTRACTOR_VERSION_TS, sourceId,
    onReadyOrigin: originSourceId => queuePendingOriginExtraction(engine, originSourceId, sourceId),
  }, (candidate, origin, pendingSlugs, pendingSources) =>
    resolveCandidateSources(candidate, origin.slug, origin.sourceId, pendingSlugs, pendingSources,
      outboundCrossSourceIds.has(origin.sourceId), { crossSource, defaultSourceId: linkDefaultSourceId }).ok);
  if (result.pendingScanIncomplete) {
    opts.signal?.throwIfAborted();
    const accepted = await queueDeferredStaleSweep(engine, {
      sourceId, commit: `pending-target-scan:${result.pendingScanAfter}`,
      reason: 'pending_target_scan_continuation', pendingAfter: result.pendingScanAfter,
    });
    if (accepted === null) throw new Error('Pending target scan continuation was not accepted');
  }
  return result;
}
