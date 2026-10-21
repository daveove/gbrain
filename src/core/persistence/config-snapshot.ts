/**
 * One read of the brain config for a single write's preparation (Phase 4.3).
 * Preparation runs outside every lock and reads a dozen config keys one
 * round trip at a time; this view answers `getConfig` and the equivalent
 * `SELECT value FROM config WHERE key=$1` from one read of the config table,
 * minus `internal.*` rows, taken when preparation starts, as one batch's
 * shared reads do (page-mutations.ts `batchSharedReads`). `internal.*` keys
 * are machine-owned queues and cursors that can grow large, so the startup
 * read skips them (as every engine's `getAllConfig` does, see
 * src/core/config-snapshot.ts) and a per-key read of one reaches the engine.
 * Every other call reaches the engine unchanged. Publication reads its config
 * again inside its transaction.
 */
import type { BrainEngine } from '../engine.ts';
import { registerEngineView } from './switches.ts';

const KEY_READ = 'SELECT value FROM config WHERE key=$1';
const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim();

export async function preparationConfigView(engine: BrainEngine): Promise<BrainEngine> {
  const rows = await engine.executeRaw<{ key: string; value: string }>("SELECT key,value FROM config WHERE key NOT LIKE 'internal.%'");
  const values = new Map(rows.map(row => [row.key, row.value]));
  return registerEngineView(new Proxy(engine, { get(target, key) {
    if (key === 'getConfig') return async (name: string) =>
      name.startsWith('internal.') ? target.getConfig(name) : values.has(name) ? values.get(name)! : null;
    if (key === 'getAllConfig') return async () => Object.fromEntries(values);
    if (key === 'executeRaw') return (sql: string, params?: unknown[], opts?: { signal?: AbortSignal }) =>
      flat(sql) === KEY_READ && typeof params?.[0] === 'string' && !params[0].startsWith('internal.')
        ? Promise.resolve(values.has(params[0]) ? [{ value: values.get(params[0]) }] : [])
        : target.executeRaw(sql, params, opts);
    const member = Reflect.get(target, key, target);
    return typeof member === 'function' ? member.bind(target) : member;
  } }), engine);
}
