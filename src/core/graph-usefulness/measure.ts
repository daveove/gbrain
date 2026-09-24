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
    link_rows: snap.fingerprint.link_rows,
    valid_links: snap.fingerprint.valid_links,
    zero_degree_pages: snap.measure_zero_degree_pages,
    avg_degree: snap.avg_degree,
    median_degree: snap.median_degree,
    junk_slug_samples: snap.junk_slug_samples,
    fingerprint: snap.fingerprint,
  };
}
