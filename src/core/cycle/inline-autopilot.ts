/** Inline autopilot holds one tracked promise through its pinned-day maintenance. */
import type { BrainEngine } from '../engine.ts';
import type { CycleOpts, CycleReport } from '../cycle.ts';
import { calendarDateInTimeZone, resolveCycleTimeZone } from './cycle-date.ts';
import type { extractStaleFromDB } from '../../commands/extract.ts';
import { writeDailyMemoryFromSources } from './daily-memory.ts';
import { extractOneShotDailyMemory } from './daily-memory-extract.ts';
import { drainInlineDailyMemory } from './inline-daily-memory-drain.ts';
import { previousCalendarDay } from './daily-memory-followup.ts';

export async function runInlineAutopilotCycle(engine: BrainEngine, opts: CycleOpts, deps: {
  cycle?: (engine: BrainEngine, opts: CycleOpts) => Promise<CycleReport>;
  now?: () => Date;
  extract?: typeof extractStaleFromDB;
  onMaintenanceError?: (error: unknown) => void;
} = {}): Promise<CycleReport> {
  // Pin day + timezone together so a mid-cycle cycle.timezone flip cannot
  // rewrite the selected day's timestamp filters.
  const timezone = await resolveCycleTimeZone(engine);
  const day = opts.synthDate ?? calendarDateInTimeZone(deps.now?.() ?? new Date(), timezone);
  const cycle = deps.cycle ?? (await import('../cycle.ts')).runCycle;
  const report = await cycle(engine, opts);
  const notAborted = report.reason !== 'aborted' && !opts.signal?.aborted;
  const canWrite = ['ok', 'clean', 'partial'].includes(report.status) && notAborted;
  if (notAborted) {
    try {
      // Match the one-shot writer: only owned generated daily/source-record
      // indexes, never a source-wide stale sweep that can touch human pages.
      const afterWrite = async (daily: import('./daily-memory.ts').DailyMemoryWrite, signal = opts.signal) => {
        await extractOneShotDailyMemory(engine, daily, {
          extract: deps.extract,
          signal,
          timeBudgetMs: 60_000,
        });
      };
      if (canWrite) {
        for (const date of [day, previousCalendarDay(day)].filter((value): value is string => !!value)) {
          const daily = await writeDailyMemoryFromSources(engine, { date, timezone, signal: opts.signal });
          if (daily.reason === 'error') throw new Error(`Inline daily memory write failed for ${date}`);
          await afterWrite(daily);
        }
      }
      // Queued historical jobs are independent of this cycle's success.
      await drainInlineDailyMemory(engine, { signal: opts.signal, afterWrite });
    } catch (error) {
      if (!deps.onMaintenanceError) throw error;
      deps.onMaintenanceError(error);
    }
  }
  return report;
}
