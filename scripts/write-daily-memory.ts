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

export async function runOneShotDailyMemoryWrite(
  engine: BrainEngine,
  day: string | undefined,
  deps: Parameters<typeof extractOneShotDailyMemory>[2] & { now?: () => Date } = {},
): Promise<DailyMemoryWrite> {
  // Launcher exports the resolved calendar zone so timestamp filters match day selection.
  const selected = (process.env.GBRAIN_DAILY_MEMORY_ZONE || '').trim();
  const { now, ...extractDeps } = deps;
  const zoneOpts = {
    ...(selected ? { timezone: selected } : {}),
    ...(now ? { now } : {}),
  };

  const afterWrite = async (daily: DailyMemoryWrite, signal = deps.signal) => {
    await extractOneShotDailyMemory(engine, daily, { ...extractDeps, signal });
  };

  let result: DailyMemoryWrite;
  // Explicit-date backfills stay single-day. Scheduled runs also refresh the
  // previous calendar day so late source_records still land (match inline/fanout).
  if (day !== undefined) {
    result = await writeDailyMemoryFromSources(engine, {
      ...dailyMemoryArgs(day),
      ...zoneOpts,
    });
    await afterWrite(result);
  } else {
    const timezone = selected || await resolveCycleTimeZone(engine);
    const selectedDay = calendarDateInTimeZone(now?.() ?? new Date(), timezone);
    let primary: DailyMemoryWrite | undefined;
    for (const date of [selectedDay, previousCalendarDay(selectedDay)].filter((value): value is string => !!value)) {
      const daily = await writeDailyMemoryFromSources(engine, { date, timezone, ...(now ? { now } : {}) });
      if (daily.reason === 'error') throw new Error(`Daily memory write failed for ${date}`);
      await afterWrite(daily);
      primary ??= daily;
    }
    result = primary!;
  }

  // Transcript ingest can enqueue non-current dates; no Minions worker here, so drain.
  await drainInlineDailyMemory(engine, {
    signal: deps.signal,
    afterWrite,
  });
  return result;
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config) throw new Error('no gbrain config');
  const engineConfig = { ...toEngineConfig(config), poolSize: 1 };
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
