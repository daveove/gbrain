/**
 * CLI seam for DAV-6220 graph usefulness.
 *
 * Returns false when the invocation is bare traversal so `gbrain graph <slug>`
 * keeps going through the operation dispatcher (makeContext, source scope,
 * thin-client MCP for traverse_graph). Returns true after handling a
 * usefulness subcommand locally.
 */

import type { BrainEngine } from '../core/engine.ts';
import { finishCliTeardown } from '../core/cli-force-exit.ts';
import { isThinClient, loadConfig } from '../core/config.ts';
import {
  graphUsefulnessSubcommand,
  graphUsefulnessWantsHelp,
  printGraphUsefulnessHelp,
  runGraphUsefulness,
} from './graph-usefulness.ts';

export async function dispatchGraphUsefulness(
  args: string[],
  connectEngine: () => Promise<BrainEngine>,
): Promise<boolean> {
  const sub = graphUsefulnessSubcommand(args);
  if (!sub) return false;

  // Help is local text. Do this before config load, thin-client refusal, and
  // engine connect so `gbrain graph measure --help` works with no brain.
  if (graphUsefulnessWantsHelp(args)) {
    printGraphUsefulnessHelp();
    return true;
  }

  const cfg = loadConfig();
  if (isThinClient(cfg)) {
    const url = cfg?.remote_mcp?.mcp_url ?? 'the remote host';
    console.error(
      `\`gbrain graph ${sub}\` runs on the local brain. This install is a thin client of ${url}.`,
    );
    console.error('Run it on the host. Bare `gbrain graph <slug>` still routes traverse_graph.');
    process.exit(1);
  }

  const engine = await connectEngine();
  try {
    await runGraphUsefulness(engine, args);
  } finally {
    await finishCliTeardown({ engine });
  }
  return true;
}
