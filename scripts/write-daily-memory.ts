import { loadConfig, toEngineConfig } from '../src/core/config.ts';
import { createEngine } from '../src/core/engine-factory.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import {
  DAILY_MEMORY_SOURCE_ID,
  writeDailyMemoryFromSources,
  type DailyMemoryWrite,
} from '../src/core/cycle/daily-memory.ts';
import { extractOneShotDailyMemory } from '../src/core/cycle/daily-memory-extract.ts';
import { previousCalendarDay } from '../src/core/cycle/daily-memory-followup.ts';
import { calendarDateInTimeZone, resolveCycleTimeZone } from '../src/core/cycle/cycle-date.ts';
import { drainInlineDailyMemory } from '../src/core/cycle/inline-daily-memory-drain.ts';

export { extractOneShotDailyMemory };

/** An explicit YYYY-MM-DD is a cycle date, not an instant in a timezone. */
export function dailyMemoryArgs(day: string | undefined): { date?: string } {
  if (!day) return {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) {
    throw new Error('date must be YYYY-MM-DD');
  }
  return { date: day };
}


/** Config key: recovery completed through this calendar day (inclusive). */
const DAILY_MEMORY_LOOKBACK_WATERMARK = 'cycle.daily_memory_last_lookback_day';

function lookbackMaxDays(): number {
  // The inclusive watermark consumes one slot; leave one for forward progress.
  return Math.min(30, Math.max(2, Number(process.env.GBRAIN_DAILY_MEMORY_LOOKBACK_DAYS) || 14));
}

function nextCalendarDay(day: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const dt = new Date(`${day}T00:00:00.000Z`);
  if (dt.toISOString().slice(0, 10) !== day) return null;
  dt.setUTCDate(dt.getUTCDate() + 1);
  const next = dt.toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(next) ? next : null;
}

/** Selected day, late-record predecessor, and a capped oldest-first drain from the watermark. */
export function lookbackRecoveryDays(selectedDay: string, watermark: string | null | undefined): string[] {
  const days = new Set<string>([selectedDay]);
  const prev = previousCalendarDay(selectedDay);
  if (prev) days.add(prev);
  if (watermark && /^\d{4}-\d{2}-\d{2}$/.test(watermark) && watermark < selectedDay) {
    let cursor: string | null = watermark;
    let guard = 0;
    const max = lookbackMaxDays();
    while (cursor && cursor <= selectedDay && guard < max) {
      days.add(cursor);
      if (cursor === selectedDay) break;
      cursor = nextCalendarDay(cursor);
      guard++;
    }
  }
  return [...days].sort();
}

/** Advance watermark only through the backlog this run actually drained. */
export function lookbackWatermarkAfter(selectedDay: string, watermark: string | null | undefined): string {
  if (!watermark || !/^\d{4}-\d{2}-\d{2}$/.test(watermark) || watermark >= selectedDay) {
    return selectedDay;
  }
  let cursor: string | null = watermark;
  let last = watermark;
  let guard = 0;
  const max = lookbackMaxDays();
  while (cursor && cursor <= selectedDay && guard < max) {
    last = cursor;
    if (cursor === selectedDay) return selectedDay;
    cursor = nextCalendarDay(cursor);
    guard++;
  }
  return last;
}

export async function runOneShotDailyMemoryWrite(
  engine: BrainEngine,
  day: string | undefined,
  deps: Parameters<typeof extractOneShotDailyMemory>[2] & { now?: () => Date } = {},
): Promise<DailyMemoryWrite> {
  // Launcher exports the resolved calendar zone so timestamp filters match day selection.
  const selected = (process.env.GBRAIN_DAILY_MEMORY_ZONE || '').trim();
  // Scheduled launcher pins the day argv and sets LOOKBACK=1; bare undefined day
  // (unit tests / direct calls) also looks back. Explicit backfills omit the flag.
  const lookback = day === undefined || process.env.GBRAIN_DAILY_MEMORY_LOOKBACK === '1';
  const { now, ...extractDeps } = deps;

  let result: DailyMemoryWrite;
  if (!lookback) {
    result = await writeDailyMemoryFromSources(engine, {
      ...dailyMemoryArgs(day),
      ...(selected ? { timezone: selected } : {}),
      ...(now ? { now } : {}),
    });
  } else {
    // Prefer the launcher-pinned day when present so a mid-run midnight cannot
    // drift the primary write away from the day already used for ingest.
    const timezone = selected || await resolveCycleTimeZone(engine);
    if (day !== undefined) dailyMemoryArgs(day); // validate format
    const selectedDay = day ?? calendarDateInTimeZone(now?.() ?? new Date(), timezone);
    const watermark = await engine.getConfig(DAILY_MEMORY_LOOKBACK_WATERMARK);
    let primary: DailyMemoryWrite | undefined;
    for (const date of lookbackRecoveryDays(selectedDay, watermark)) {
      const daily = await writeDailyMemoryFromSources(engine, { date, timezone, ...(now ? { now } : {}) });
      if (daily.reason === 'error') throw new Error(`Daily memory write failed for ${date}`);
      if (date === selectedDay) primary = daily;
    }
    if (!primary) throw new Error(`Daily memory write missed selected day ${selectedDay}`);
    await engine.setConfig(DAILY_MEMORY_LOOKBACK_WATERMARK, lookbackWatermarkAfter(selectedDay, watermark));
    result = primary;
  }

  // Transcript ingest can enqueue non-current dates; no Minions worker here, so drain.
  // The callback defers each day's extraction to the single pass below; without
  // one, the drained job would queue an extract job no worker here runs. A day
  // write takes over a minute on a large brain, so the nightly run drains under
  // its own budget instead of the inline autopilot's 60 seconds.
  let drainError: unknown;
  try {
    await drainInlineDailyMemory(engine, {
      signal: deps.signal, afterWrite: async () => {}, maxJobs: Number.MAX_SAFE_INTEGER,
      timeBudgetMs: Number(process.env.GBRAIN_DAILY_MEMORY_DRAIN_MS) || 30 * 60_000,
    });
  } catch (error) {
    if (deps.signal?.aborted) throw error;
    drainError = error;
  }
  // Extract once after every write so the whole-brain link setup is paid once
  // and stale generated indexes from earlier nights drain with tonight's. A
  // failed or timed-out drain still extracts what was written, then fails.
  await extractOneShotDailyMemory(engine, { written: false, needs_extract: true }, { ...extractDeps, signal: deps.signal });
  if (drainError) throw drainError;
  return result;
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config) throw new Error('no gbrain config');
  // putPage can need a second connection inside its transaction; one deadlocks.
  const engineConfig = { ...toEngineConfig(config), poolSize: 2 };
  const engine = await createEngine(engineConfig);
  try {
    await engine.connect(engineConfig);
    const result = await runOneShotDailyMemoryWrite(engine, process.argv[2]);
    const page = result.slug ? await engine.getPage(result.slug, { sourceId: result.source_id ?? DAILY_MEMORY_SOURCE_ID, includeDeleted: true }) : null;
    console.log(JSON.stringify({ ...result, dream_generated: page?.frontmatter?.dream_generated === true, deleted: Boolean(page?.deleted_at) }));
    if (result.reason === 'error') process.exitCode = 1;
  } finally {
    await engine.disconnect();
  }
}

if (import.meta.main) await main();
