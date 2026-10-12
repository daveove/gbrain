/** Print brain DB cycle.timezone for the daily-memory launcher (stdout only). */
import { loadConfig, toEngineConfig } from '../src/core/config.ts';
import { createEngine } from '../src/core/engine-factory.ts';
import { connectWithRetry } from '../src/core/db.ts';

const config = loadConfig();
if (!config) process.exit(0);
const engineConfig = { ...toEngineConfig(config), poolSize: 1 };
const engine = await createEngine(engineConfig);
try {
  // A full session pooler waits out GBRAIN_CONNECT_RETRY_BUDGET_MS rather than
  // letting the launcher fall back to another zone and pin the wrong day.
  await connectWithRetry(engine, engineConfig);
  const zone = (await engine.getConfig('cycle.timezone'))?.trim();
  if (zone) process.stdout.write(zone);
} finally {
  await engine.disconnect();
}
