/**
 * DAV-7022: the whole-table config read runs on every CLI and MCP startup.
 * When a deferred-link queue lived in `internal.pending-links.*` config rows,
 * every startup shipped the whole queue (1,453 rows, ~667 KB on one hosted
 * brain). `getAllConfig()` must skip `internal.*`; per-key and prefix reads of
 * those rows must keep working for the code that owns them.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { snapshotConfigReader } from '../src/core/config-snapshot.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw(`DELETE FROM config WHERE key LIKE 'internal.%' OR key LIKE 'test.%' OR key = 'internalish'`);
});

describe('getAllConfig excludes internal.* keys', () => {
  test('many internal rows stay out of the snapshot and remain readable per key', async () => {
    const rows = 500;
    await engine.executeRaw(
      `INSERT INTO config (key, value)
         SELECT 'internal.pending-links.' || lpad(i::text, 4, '0'), repeat('x', 400) FROM generate_series(1, $1::int) AS i`,
      [rows],
    );
    await engine.setConfig('test.user_key', 'user-value');
    // Only the `internal.` namespace is excluded, not every key that starts
    // with the same letters.
    await engine.setConfig('internalish', 'kept');

    const all = await engine.getAllConfig();
    expect(Object.keys(all).filter(key => key.startsWith('internal.'))).toEqual([]);
    expect(all['test.user_key']).toBe('user-value');
    expect(all['internalish']).toBe('kept');

    const reader = await snapshotConfigReader(engine);
    expect(await reader!.getConfig('test.user_key')).toBe('user-value');
    expect(await reader!.getConfig('internal.pending-links.0001')).toBeNull();

    expect(await engine.getConfig('internal.pending-links.0001')).toBe('x'.repeat(400));
    expect((await engine.listConfigKeys('internal.pending-links.')).length).toBe(rows);
  });
});
