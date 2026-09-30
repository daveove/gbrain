import type { BrainEngine } from './engine.ts';
import { resolveCandidateSources, resolveLinkFallbackDefault } from './link-reconciliation.ts';
import { isCrossSourceLinksEnabled, LINK_EXTRACTOR_VERSION_TS } from './link-extraction.ts';
import { loadAllSources, sourceAllowsOutboundCrossSourceLinks } from './sources-load.ts';
import { pendingLinkReferenceBatches, probePendingLinkReferences, queuePendingOriginExtraction } from './pending-link-references.ts';

/** Inline extraction stamps only affected pages; arriving targets must also wake dormant origins. */
export async function probePendingOriginsForArrivedTargets(
  engine: BrainEngine,
  sourceId: string,
  opts: { globalBasename: boolean; signal?: AbortSignal; deadline?: number } = { globalBasename: false },
): Promise<void> {
  const linkDefaultSourceId = await resolveLinkFallbackDefault(engine);
  const crossSource = await isCrossSourceLinksEnabled(engine);
  const outboundCrossSourceIds = new Set((await loadAllSources(engine))
    .filter(source => sourceAllowsOutboundCrossSourceLinks(source.config)).map(source => source.id));
  for await (const pendingLinks of pendingLinkReferenceBatches(engine, sourceId, {
    signal: opts.signal, deadline: opts.deadline,
  })) {
    await probePendingLinkReferences(engine, pendingLinks, {
      globalBasename: opts.globalBasename, signal: opts.signal, deadline: opts.deadline,
      versionTs: LINK_EXTRACTOR_VERSION_TS, sourceId,
      onReadyOrigin: originSourceId => queuePendingOriginExtraction(engine, originSourceId, sourceId),
    }, (candidate, origin, pendingSlugs, pendingSources) =>
      resolveCandidateSources(candidate, origin.slug, origin.sourceId, pendingSlugs, pendingSources,
        outboundCrossSourceIds.has(origin.sourceId), { crossSource, defaultSourceId: linkDefaultSourceId }).ok);
  }
}
