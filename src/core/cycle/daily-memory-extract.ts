/** Bounded dream-index extraction shared by one-shot and inline autopilot. */
import type { BrainEngine, PageSnapshot } from '../engine.ts';
import type { extractStaleFromDB } from '../../commands/extract.ts';
import {
  DAILY_MEMORY_SOURCE_ID,
  dailyMemoryExtractTargets,
  isOwnedGeneratedDailyIndex,
  type DailyMemoryWrite,
} from './daily-memory.ts';

/**
 * Restrict extraction to owned generated daily/source-record indexes.
 * Never run a source-wide stale sweep that can rewrite human pages.
 * One extract call per run: its setup reads every page ref in the brain
 * (minutes on a large Postgres brain), so batching calls repeats that cost.
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
  const extractModule = await import('../../commands/extract.ts');
  const extract = deps.extract ?? extractModule.extractStaleFromDB;
  const budget = deps.timeBudgetMs ?? extractModule.STALE_TIME_BUDGET_MS;
  const originGuard = async (snapshot: PageSnapshot) => {
    const page = snapshot.page;
    if (page.source_id !== DAILY_MEMORY_SOURCE_ID
      || !isOwnedGeneratedDailyIndex(page.slug, page.frontmatter)) return false;
    const [source] = await engine.executeRaw<{ owned: boolean }>(`SELECT archived IS NOT TRUE AND
      (config @> '{"system_index":true}'::jsonb OR
        (name='Dream cycle indexes' AND config @> '{"federated":false}'::jsonb)) AS owned
      FROM sources WHERE id=$1`, [DAILY_MEMORY_SOURCE_ID]);
    return source?.owned === true;
  };
  deps.signal?.throwIfAborted();
  const slugs = result.extract_slugs?.length ? result.extract_slugs : await dailyMemoryExtractTargets(engine);
  deps.signal?.throwIfAborted();
  if (!slugs.length) return;
  const remaining = budget > 0
    ? (await extract(engine, {
      dryRun: false, jsonMode: true, quiet: true, sourceIdFilter: DAILY_MEMORY_SOURCE_ID,
      slugs, originGuard, catchUp: false, timeBudgetMs: budget, signal: deps.signal,
    })).staleRemaining
    : slugs.length;
  if (remaining > 0) throw new Error(`Daily memory extraction needs retry: ${remaining} generated daily-index pages remain`);
}
