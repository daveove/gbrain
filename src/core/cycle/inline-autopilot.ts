/** Inline autopilot holds one tracked promise through its pinned-day maintenance. */
import type { BrainEngine } from '../engine.ts';
import type { CycleOpts, CycleReport } from '../cycle.ts';
import { resolveCycleDate } from './cycle-date.ts';
import { finishFanoutDailyMemory, previousCalendarDay } from './daily-memory-followup.ts';

export async function runInlineAutopilotCycle(engine: BrainEngine, opts: CycleOpts, deps: {
  cycle?: (engine: BrainEngine, opts: CycleOpts) => Promise<CycleReport>;
  now?: () => Date;
  onMaintenanceError?: (error: unknown) => void;
} = {}): Promise<CycleReport> {
  const day = await resolveCycleDate(engine, { explicitDate: opts.synthDate, now: deps.now });
  const cycle = deps.cycle ?? (await import('../cycle.ts')).runCycle;
  const report = await cycle(engine, opts);
  if (['ok', 'clean', 'partial'].includes(report.status) && report.reason !== 'aborted' && !opts.signal?.aborted) {
    try {
      for (const date of [day, previousCalendarDay(day)].filter((value): value is string => !!value)) {
        await finishFanoutDailyMemory(engine, { id: 0, data: { daily_memory_date: date }, signal: opts.signal });
      }
    } catch (error) {
      if (!deps.onMaintenanceError) throw error;
      deps.onMaintenanceError(error);
    }
  }
  return report;
}
