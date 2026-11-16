#!/usr/bin/env bun
// scripts/postinstall.ts
//
// Postinstall hook: after `bun install`, apply pending schema migrations ONLY
// when the operator opts in with GBRAIN_POSTINSTALL_APPLY_MIGRATIONS=1. Without
// it this script never runs `gbrain apply-migrations`: the gbrain on PATH reads
// the default home (~/.gbrain), so an install in a worktree or CI checkout
// would otherwise migrate the live brain. Wired via package.json
// ("postinstall": "bun run scripts/postinstall.ts") as a real Bun script rather
// than an inline `node -e` one-liner.
//
// Why a script file and not an inline command:
//   Embedding a program inside the package.json postinstall string lets the
//   lifecycle shell mangle it. Bun's Windows script-runner expands `\n` in the
//   hint string into a REAL newline before node sees it, producing
//   `SyntaxError: Invalid or unexpected token` and aborting the whole install.
//   `node` is also not guaranteed present under a Bun install (bun is the
//   guaranteed runtime), and `shell: win32` re-opens a quoting surface. A
//   checked-in .ts run by `bun run` sidesteps all three.
//
// Uses Bun APIs only — `which()` for Windows-aware PATH resolution (finds
// gbrain.exe / gbrain.cmd) and an argv-array `Bun.spawnSync` (no shell, nothing
// to quote). It NEVER fails the install: every path exits 0.

import { which } from 'bun';

export const APPLY_OPT_IN_ENV = 'GBRAIN_POSTINSTALL_APPLY_MIGRATIONS';

export type PostinstallDecision = 'upgrade-owns' | 'no-opt-in' | 'apply';

// #5693: under `gbrain upgrade`, post-upgrade owns migrations. Running them
// here too would run them twice, and a slow run here outlives the install
// timeout that `gbrain upgrade` reads as a failed upgrade. That skip wins even
// when the opt-in is also set. Otherwise migrations run only on an explicit
// opt-in; the default is to leave the brain untouched.
export function decidePostinstall(env: Record<string, string | undefined>): PostinstallDecision {
  if (env.GBRAIN_UPGRADE_OWNS_MIGRATIONS === '1') return 'upgrade-owns';
  if (env[APPLY_OPT_IN_ENV] !== '1') return 'no-opt-in';
  return 'apply';
}

// Repo modules load dynamically inside try/catch: a static import of a file
// that is not on disk (a Docker dependency layer, a partial checkout) would
// exit 1 before any line here runs and fail the whole install.
async function runtimeRefusalMessage(): Promise<string | null> {
  try {
    const { unsupportedBunMessage } = await import('../src/core/runtime-version.ts');
    return unsupportedBunMessage();
  } catch {
    return null;
  }
}

const HINT =
  '[gbrain] postinstall skipped. If installed via bun install -g github:...: ' +
  'run `gbrain doctor` and `gbrain apply-migrations --yes` manually. ' +
  'See https://github.com/garrytan/gbrain/issues/218';

async function main(): Promise<never> {
  // The install itself runs on the user's Bun, so this is the first place an
  // upgrade onto a newer Bun floor can say so. Nothing else here would work:
  // every gbrain command refuses until Bun is upgraded.
  const runtimeRefusal = await runtimeRefusalMessage();
  if (runtimeRefusal) {
    console.error(`[gbrain] Installed, but gbrain will not start on this Bun.\n${runtimeRefusal}`);
    process.exit(0);
  }

  // Decide before resolving gbrain on PATH or spawning anything.
  const decision = decidePostinstall(process.env);
  if (decision === 'upgrade-owns') {
    console.error('[gbrain] postinstall: migrations deferred to `gbrain post-upgrade`.');
    process.exit(0);
  }
  if (decision === 'no-opt-in') {
    console.error(
      `[gbrain] postinstall: migrations not applied. To apply them on install, set ${APPLY_OPT_IN_ENV}=1 ` +
        '(or run `gbrain apply-migrations --yes`).',
    );
    process.exit(0);
  }

  // Windows-aware PATH resolution — finds gbrain, gbrain.exe or gbrain.cmd.
  const bin = which('gbrain');

  if (!bin) {
    // Fresh clone / global install where gbrain isn't on PATH yet: skip cleanly.
    console.error(HINT);
    process.exit(0);
  }

  try {
    const r = Bun.spawnSync({
      cmd: [bin, 'apply-migrations', '--yes', '--non-interactive'],
      stdout: 'inherit',
      stderr: 'inherit',
    });
    if (r.exitCode !== 0) console.error(HINT);
  } catch {
    console.error(HINT);
  }

  process.exit(0); // never abort the install
}

// Importing this module (the decision unit test) must not run the hook.
if (import.meta.main) await main();
