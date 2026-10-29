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
 *
 * Returns how many generated indexes were left for a later run because the
 * time budget ran out. That count is only non-zero with `allowBudgetDeferral`;
 * without it, and always when pages remain although the budget was not used
 * up (a write raced the sweep), the call throws so its caller retries.
 */
export async function extractOneShotDailyMemory(
  engine: BrainEngine,
  result: Pick<DailyMemoryWrite, 'written' | 'needs_extract' | 'extract_slugs'>,
  deps: {
    extract?: typeof extractStaleFromDB;
    signal?: AbortSignal;
    timeBudgetMs?: number;
    /** A backlog left because the time budget ran out is success, not failure. */
    allowBudgetDeferral?: boolean;
  } = {},
): Promise<number> {
  if (!result.written && !result.needs_extract) return 0;
  const extractModule = await import('../../commands/extract.ts');
  const extract = deps.extract ?? extractModule.extractStaleFromDB;
  const budget = deps.timeBudgetMs ?? extractModule.STALE_TIME_BUDGET_MS;
  const originGuard = async (snapshot: PageSnapshot, reader = engine) => {
    const page = snapshot.page;
    if (page.source_id !== DAILY_MEMORY_SOURCE_ID
      || !isOwnedGeneratedDailyIndex(page.slug, page.frontmatter)) return false;
    const [source] = await reader.executeRaw<{ owned: boolean }>(`SELECT archived IS NOT TRUE AND
      (config @> '{"system_index":true}'::jsonb OR
        (name='Dream cycle indexes' AND config @> '{"federated":false}'::jsonb)) AS owned
      FROM sources WHERE id=$1`, [DAILY_MEMORY_SOURCE_ID]);
    return source?.owned === true;
  };
  deps.signal?.throwIfAborted();
  const exact = Boolean(result.extract_slugs?.length);
  const slugs = exact ? result.extract_slugs! : await dailyMemoryExtractTargets(engine);
  deps.signal?.throwIfAborted();
  if (!slugs.length) return 0;
  let remaining = slugs.length;
  // The sweep stops at the first batch boundary past its deadline, so a run
  // that used its whole budget is the only way a backlog is budget-deferred.
  let budgetSpent = budget <= 0;
  if (budget > 0) {
    const started = Date.now();
    await extract(engine, {
      dryRun: false, jsonMode: true, quiet: true, sourceIdFilter: DAILY_MEMORY_SOURCE_ID,
      slugs, originGuard, catchUp: false, timeBudgetMs: budget, signal: deps.signal,
    });
    budgetSpent = Date.now() - started >= budget;
    // Recount ownership as well as staleness: a human replacement is no longer
    // index debt. Exact calls stay bounded to their frozen target set; broad
    // nightly sweeps also discover generated indexes written during setup.
    remaining = (await dailyMemoryExtractTargets(engine, exact ? slugs : undefined)).length;
  }
  if (remaining === 0) return 0;
  if (deps.allowBudgetDeferral && budgetSpent) return remaining;
  throw new Error(`Daily memory extraction needs retry: ${remaining} generated daily-index pages remain`);
}
