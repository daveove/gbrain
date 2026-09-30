import { loadConfig, toEngineConfig } from '../src/core/config.ts';
import { createEngine } from '../src/core/engine-factory.ts';
import { writeDailyMemoryFromSources } from '../src/core/cycle/daily-memory.ts';

/** An explicit YYYY-MM-DD is a cycle date, not an instant in a timezone. */
export function dailyMemoryArgs(day: string | undefined): { date?: string } {
  if (!day) return {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) {
    throw new Error('date must be YYYY-MM-DD');
  }
  return { date: day };
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config) throw new Error('no gbrain config');
  const engineConfig = { ...toEngineConfig(config), poolSize: 1 };
  const engine = await createEngine(engineConfig);
  try {
    await engine.connect(engineConfig);
    const result = await writeDailyMemoryFromSources(engine, dailyMemoryArgs(process.argv[2]));
    const page = result.slug ? await engine.getPage(result.slug, { sourceId: 'default', includeDeleted: true }) : null;
    console.log(JSON.stringify({ ...result, dream_generated: page?.frontmatter?.dream_generated === true, deleted: Boolean(page?.deleted_at) }));
    if (result.reason === 'error') process.exitCode = 1;
  } finally {
    await engine.disconnect();
  }
}

if (import.meta.main) await main();
