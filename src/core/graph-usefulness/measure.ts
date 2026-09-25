import type { BrainEngine } from '../engine.ts';
import { computeGraphSnapshot, type ScopeOpts } from './fingerprint.ts';
import type { GraphMeasureResult } from './types.ts';

export async function measureGraphUsefulness(
  engine: BrainEngine,
  opts?: ScopeOpts,
): Promise<GraphMeasureResult> {
  // One statement: degrees, full-corpus junk counts, example rows, and the
  // fingerprint share a single snapshot.
  const snap = await computeGraphSnapshot(engine, { ...opts, measure: true });
  return {
    active_pages: snap.fingerprint.active_pages,
    link_rows: snap.measure_link_rows,
    // Incident scope, same as link_rows and degree. fingerprint.valid_links
    // drops an outgoing edge whose target is outside this source.
    valid_links: snap.measure_valid_links,
    zero_degree_pages: snap.measure_zero_degree_pages,
    avg_degree: snap.avg_degree,
    median_degree: snap.median_degree,
    junk_slug_samples: snap.junk_slug_samples,
    fingerprint: snap.fingerprint,
  };
}
