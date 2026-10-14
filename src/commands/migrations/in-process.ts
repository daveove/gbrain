/**
 * In-process migration helpers (v0.41.37.0 #1605).
 *
 * Why this exists: migration schema phases used to shell out to a child
 * `gbrain init --migrate-only` via `execSync`. On Windows + bun + Supabase
 * pooler, the spawned CHILD process dies with `getaddrinfo ENOTFOUND` before it
 * can connect — even though the PARENT connects fine and `env: process.env` is
 * passed. It is a bun-on-Windows child-process DNS-resolution failure, not an
 * env-propagation bug. The only robust fix is to not spawn at all: run the
 * schema bring-up IN-PROCESS. The PGLite path at v0_11_0.ts already proved the
 * pattern; this generalizes it to every engine + every schema phase.
 *
 * `runMigrateOnlyCore` is the single source of truth for "bring schema to head"
 * — `init.ts:initMigrateOnly` (the `gbrain init --migrate-only` CLI path) and
 * the migration orchestrators both call it, so the configureGateway-before-
 * initSchema fix can't drift between them.
 *
 * `runGbrainSubprocess` is the diagnostic wrapper for the REMAINING (non-schema)
 * gbrain-subprocess spawns (extract/repair/stats). It captures child stderr and
 * folds it into the thrown error so a Windows failure shows the real
 * `getaddrinfo ENOTFOUND` line instead of the bare `Command failed: ...`.
 */

import { execSync } from 'child_process';
import { resolveChildCliInvocation } from '../../core/minions/job-isolation.ts';

import { loadConfig, toEngineConfig } from '../../core/config.ts';
import { buildGatewayConfig } from '../../core/ai/build-gateway-config.ts';
import { createEngine } from '../../core/engine-factory.ts';
import { runInitSchemaWithRetry } from '../../core/init-schema-retry.ts';

/** Migrate-only gets a 30-minute DDL/overall deadline. Ordinary engines retain
 * their existing startup timeouts; this private engine is closed on expiry. */
export const MIGRATE_ONLY_TIMEOUT_MS = 30 * 60 * 1000;
const SUBPROCESS_TIMEOUT_MS = 600_000;

/** Large stderr buffer for captured subprocess output. `execSync`'s default
 *  ~1MB maxBuffer overflows on long backfills (extract/repair) and turns a
 *  successful run into a spurious failure. */
const SUBPROCESS_MAX_BUFFER = 64 * 1024 * 1024;

export interface MigrateOnlyResult {
  /** The engine kind that was brought to head ('pglite' | 'postgres'). */
  engine: string;
}

export class MigrateOnlyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrateOnlyError';
  }
}

/**
 * Bring the configured brain's schema to head, in-process. Mirrors what
 * `gbrain init --migrate-only` did via subprocess: configureGateway →
 * createEngine → connect → initSchema → disconnect. Idempotent (initSchema is
 * a no-op when already at head). Throws `MigrateOnlyError` on no-config or
 * timeout so callers report a failed phase rather than hanging.
 */
export async function runMigrateOnlyCore(opts?: { timeoutMs?: number }): Promise<MigrateOnlyResult> {
  const config = loadConfig();
  if (!config) {
    throw new MigrateOnlyError(
      'No brain configured. Run `gbrain init` (interactive) or `gbrain init --pglite` / `gbrain init --supabase` first.',
    );
  }

  // configureGateway BEFORE initSchema (init.ts B.3): a schema bump on a brain
  // whose file config is missing embedding fields must not fall through to
  // stale hardcoded fallbacks. loadConfig already merged env; propagate it.
  const { configureGateway } = await import('../../core/ai/gateway.ts');
  configureGateway(buildGatewayConfig(config));

  const timeoutMs = opts?.timeoutMs ?? MIGRATE_ONLY_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new MigrateOnlyError('migration deadline must be positive');
  // A private one-connection read pool plus the existing one-connection DDL
  // route (and at most one lock diagnostic) preserves the peak <= 3 footprint.
  const engineConfig = {
    ...toEngineConfig(config),
    ...(config.engine === 'postgres' ? { poolSize: 1, migrationStatementTimeoutMs: timeoutMs } : {}),
  };
  const engine = await createEngine(engineConfig);
  const deadline = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let cancellation: Promise<void> | undefined;
  try {
    await engine.connect(engineConfig);
    const work = runInitSchemaWithRetry(engine, { signal: deadline.signal });
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new MigrateOnlyError(`schema init timed out after ${Math.round(timeoutMs / 1000)}s`);
        deadline.abort(error);
        cancellation = engine.cancelSchemaInitialization?.() ?? engine.disconnect();
        // Closing owned sockets, not a non-cancelling Promise.race. Do not
        // return until the cancellation and the runner itself have settled.
        cancellation.then(() => reject(error), reject);
      }, timeoutMs);
    });
    try {
      await Promise.race([work, expired]);
    } finally {
      clearTimeout(timer);
      if (deadline.signal.aborted) {
        await cancellation;
        await work.catch(() => {});
      }
    }
  } finally {
    try { await engine.disconnect(); } catch { /* best-effort */ }
  }

  return { engine: config.engine };
}

/**
 * #5184: point every `gbrain` command word in a migration's shell command at
 * the CLI that is running this migration (the compiled executable, or bun plus
 * the source entrypoint), through the same `resolveChildCliInvocation` the
 * supervisor and autopilot use. A bare `gbrain` resolved from PATH can be a
 * different version, or a wrapper that sets its own GBRAIN_HOME or database
 * URL, so backfills and installs would act on another brain. When the running
 * CLI cannot be identified the command is left as written (PATH resolution).
 */
export function gbrainChildCommand(
  cmd: string,
  env: Record<string, string | undefined> = process.env,
  execPath: string = process.execPath,
  argv1: string | undefined = process.argv[1],
  platform: NodeJS.Platform = process.platform,
): string {
  const inv = resolveChildCliInvocation(env, execPath, argv1, () => null);
  if (!inv) return cmd;
  // execSync runs cmd.exe on Windows, which does not understand single quotes.
  const quote = platform === 'win32'
    ? (s: string) => `"${s}"`
    : (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  const prefix = [inv.cmd, ...inv.argsPrefix].map(quote).join(' ');
  return cmd.replace(/(^|\|\||&&|;)(\s*)gbrain(?=\s|$)/g, (_m, sep: string, space: string) => `${sep}${space}${prefix}`);
}

/**
 * Run a `gbrain ...` subcommand as a subprocess, capturing child stderr so a
 * failure surfaces the real reason. Used for the non-schema backfill phases
 * (extract/repair/stats) that aren't yet in-process. On Windows these may still
 * fail with `getaddrinfo ENOTFOUND`, but the operator now sees WHY instead of a
 * bare `Command failed`. Returns captured stdout (utf-8) on success.
 *
 * Note: stderr is piped (captured), so gbrain progress lines (which go to
 * stderr) are not shown live during these phases — acceptable for a one-shot
 * `apply-migrations` run; the failure reason matters more than live progress.
 */
export function runGbrainSubprocess(cmd: string, opts?: { timeoutMs?: number }): string {
  try {
    // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- cmd is a fixed migration subcommand string from the orchestrators; gbrainChildCommand prefixes the running CLI (#5184)
    const out = execSync(gbrainChildCommand(cmd), {
      stdio: ['inherit', 'pipe', 'pipe'],
      timeout: opts?.timeoutMs ?? SUBPROCESS_TIMEOUT_MS,
      env: process.env,
      maxBuffer: SUBPROCESS_MAX_BUFFER,
      encoding: 'utf-8',
    });
    return typeof out === 'string' ? out : '';
  } catch (e: unknown) {
    const err = e as { message?: string; stderr?: Buffer | string };
    const stderrRaw = err?.stderr
      ? (Buffer.isBuffer(err.stderr) ? err.stderr.toString('utf-8') : String(err.stderr))
      : '';
    const tail = stderrRaw.split('\n').filter(Boolean).slice(-10).join('\n');
    const base = err?.message ?? String(e);
    throw new Error(tail ? `${base}\n--- child stderr (tail) ---\n${tail}` : base);
  }
}

