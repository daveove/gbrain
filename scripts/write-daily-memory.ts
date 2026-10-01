import { loadConfig, toEngineConfig } from '../src/core/config.ts';
import { createEngine } from '../src/core/engine-factory.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { extractStaleFromDB } from '../src/commands/extract.ts';
import {
  DAILY_MEMORY_SOURCE_ID,
  writeDailyMemoryFromSources,
  type DailyMemoryWrite,
} from '../src/core/cycle/daily-memory.ts';

/** An explicit YYYY-MM-DD is a cycle date, not an instant in a timezone. */
export function dailyMemoryArgs(day: string | undefined): { date?: string } {
  if (!day) return {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) {
    throw new Error('date must be YYYY-MM-DD');
  }
  return { date: day };
}

/**
 * One-shot launcher has no Minions worker. Match inline autopilot: run bounded
 * dream-scoped extraction in-process after the write.
 */
export async function extractOneShotDailyMemory(
  engine: BrainEngine,
  result: DailyMemoryWrite,
  deps: {
    extract?: typeof extractStaleFromDB;
    signal?: AbortSignal;
    timeBudgetMs?: number;
  } = {},
): Promise<void> {
  if (!result.written && !result.needs_extract) return;
  const extract = deps.extract ?? (await import('../src/commands/extract.ts')).extractStaleFromDB;
  const extracted = await extract(engine, {
    dryRun: false,
    jsonMode: true,
    quiet: true,
    sourceIdFilter: DAILY_MEMORY_SOURCE_ID,
    catchUp: false,
    timeBudgetMs: deps.timeBudgetMs ?? 60_000,
    signal: deps.signal,
  });
  if (extracted.staleRemaining > 0) {
    throw new Error(`Daily memory extraction needs retry: ${extracted.staleRemaining} dream-source pages remain`);
  }
}

export async function runOneShotDailyMemoryWrite(
  engine: BrainEngine,
  day: string | undefined,
  deps: Parameters<typeof extractOneShotDailyMemory>[2] = {},
): Promise<DailyMemoryWrite> {
  const result = await writeDailyMemoryFromSources(engine, dailyMemoryArgs(day));
  await extractOneShotDailyMemory(engine, result, deps);
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
