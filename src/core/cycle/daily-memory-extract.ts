/** Bounded dream-index extraction shared by one-shot and inline autopilot. */
import type { BrainEngine } from '../engine.ts';
import type { extractStaleFromDB } from '../../commands/extract.ts';
import {
  DAILY_MEMORY_SOURCE_ID,
  dailyMemoryExtractTargets,
  countDailyMemoryExtractTargets,
  type DailyMemoryWrite,
} from './daily-memory.ts';

/**
 * Restrict extraction to owned generated daily/source-record indexes.
 * Never run a source-wide stale sweep that can rewrite human pages.
 */
export async function extractOneShotDailyMemory(
  engine: BrainEngine,
  result: Pick<DailyMemoryWrite, 'written' | 'needs_extract' | 'extract_slugs'>,
  deps: {
    extract?: typeof extractStaleFromDB;
    signal?: AbortSignal;
    timeBudgetMs?: number;
  } = {},
): Promise<void> {
  if (!result.written && !result.needs_extract) return;
  const extract = deps.extract ?? (await import('../../commands/extract.ts')).extractStaleFromDB;
  const budget = deps.timeBudgetMs ?? 60_000;
  const runTargets = async (slugs: readonly string[], timeBudgetMs: number) => {
    const extracted = await extract(engine, {
      dryRun: false, jsonMode: true, quiet: true, sourceIdFilter: DAILY_MEMORY_SOURCE_ID,
      slugs, catchUp: false, timeBudgetMs, signal: deps.signal,
    });
    if (extracted.staleRemaining > 0) {
      throw new Error(`Daily memory extraction needs retry: ${extracted.staleRemaining} selected daily-index pages remain`);
    }
  };
  if (result.extract_slugs?.length) return runTargets(result.extract_slugs, budget);
  // Historical recovery selects only owned generated targets before reading bodies.
  const deadline = Date.now() + Math.max(0, budget);
  let after = '';
  deps.signal?.throwIfAborted();
  while (Date.now() < deadline) {
    const slugs = await dailyMemoryExtractTargets(engine, after);
    deps.signal?.throwIfAborted();
    if (!slugs.length || Date.now() >= deadline) break;
    await runTargets(slugs, Math.max(0, deadline - Date.now()));
    after = slugs.at(-1)!;
  }
  deps.signal?.throwIfAborted();
  const remaining = await countDailyMemoryExtractTargets(engine);
  if (remaining) throw new Error(`Daily memory extraction needs retry: ${remaining} generated daily-index pages remain`);
}
