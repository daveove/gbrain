import type { BrainEngine } from './engine.ts';

/** Explicit cross-source opt-in: environment override, database setting, then false. */
export async function isCrossSourceLinksEnabled(engine: BrainEngine): Promise<boolean> {
  const envVal = process.env.GBRAIN_LINK_RESOLUTION_CROSS_SOURCE;
  if (envVal != null) {
    const normalized = envVal.trim().toLowerCase();
    return ['1', 'true', 'yes', 'on'].includes(normalized);
  }
  const val = await engine.getConfig('link_resolution.cross_source');
  if (val == null) return false;
  const normalized = val.trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}
