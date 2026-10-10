/** Print brain DB cycle.timezone for the daily-memory launcher (stdout only). */
import { loadConfig, toEngineConfig } from '../src/core/config.ts';
import { createEngine } from '../src/core/engine-factory.ts';

const config = loadConfig();
if (!config) process.exit(0);
const engineConfig = { ...toEngineConfig(config), poolSize: 1 };
const engine = await createEngine(engineConfig);
try {
  await engine.connect(engineConfig);
  const zone = (await engine.getConfig('cycle.timezone'))?.trim();
  if (zone) process.stdout.write(zone);
} finally {
  await engine.disconnect();
}
