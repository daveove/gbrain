import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
});

beforeEach(async () => {
  await engine.executeRaw('TRUNCATE config');
});

afterAll(async () => {
  await engine.disconnect();
});

describe('MinionQueue.ensureSchema reads the real schema', () => {
  test('config truncated and table present: add works', async () => {
    const queue = new MinionQueue(engine);
    const job = await queue.add('sync', {});
    expect(job.status).toBe('waiting');
  });

  test('config truncated and table missing: same storage error', async () => {
    await engine.executeRaw('ALTER TABLE minion_jobs RENAME TO minion_jobs_hold');
    try {
      const queue = new MinionQueue(engine);
      await expect(queue.add('sync', {})).rejects.toThrow('minion_jobs table not found (schema version 1, need 7)');
    } finally {
      await engine.executeRaw('ALTER TABLE minion_jobs_hold RENAME TO minion_jobs');
    }
  });
});
