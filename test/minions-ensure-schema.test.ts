import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';

let engine: PGLiteEngine;

beforeEach(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  await engine.executeRaw('TRUNCATE config');
});

afterEach(async () => {
  await engine.disconnect();
});

describe('MinionQueue.ensureSchema reads the real schema', () => {
  test('config truncated and table present: add works', async () => {
    const queue = new MinionQueue(engine);
    const job = await queue.add('sync', {});
    expect(job.status).toBe('waiting');
  });

  test('config truncated and table missing: same storage error', async () => {
    await engine.executeRaw('DROP TABLE minion_jobs CASCADE');
    const queue = new MinionQueue(engine);
    await expect(queue.add('sync', {})).rejects.toThrow('minion_jobs table not found (schema version 1, need 7)');
  });
});
