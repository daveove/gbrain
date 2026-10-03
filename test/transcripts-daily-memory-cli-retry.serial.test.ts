/** Daily refresh failure is a failed CLI outcome, with hash-skipped retry recovery. */
import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { runTranscripts } from '../src/commands/transcripts.ts';
import { currentExitCode, _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let schemaVersion: string | null;
let dir: string;
beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  schemaVersion = await engine.getConfig('version');
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  if (schemaVersion) await engine.setConfig('version', schemaVersion);
  _resetCliExitVerdictForTests();
  dir = mkdtempSync(join(tmpdir(), 'gb-transcript-cli-retry-'));
});
afterEach(() => {
  _resetCliExitVerdictForTests(); process.exitCode = 0;
  rmSync(dir, { recursive: true, force: true });
});

for (const mode of ['--quiet', '--json']) {
  test(`${mode} reports daily refresh failure, retains watermark, and recovers without another import`, async () => {
    const file = join(dir, 'conversation.json');
    writeFileSync(file, JSON.stringify([{ title: 'Fixture session', conversation_id: 'retry-fixture',
      create_time: 1786080000, update_time: 1786080015, current_node: 'message', mapping: {
        root: { id: 'root', parent: null, children: ['message'], message: null },
        message: { id: 'message', parent: 'root', children: [], message: {
          author: { role: 'user' }, create_time: 1786080015,
          content: { content_type: 'text', parts: ['Synthetic fixture question.'] },
        } },
      } }]));
    await withEnv({ GBRAIN_HOME: dir }, async () => {
      const log = spyOn(console, 'log').mockImplementation(() => {});
      const error = spyOn(console, 'error').mockImplementation(() => {});
      const rejected = spyOn(MinionQueue.prototype, 'add').mockRejectedValue(new Error('synthetic daily queue outage'));
      const args = ['ingest', file, '--format', 'chatgpt', '--source', 'default', mode];
      try {
        await runTranscripts(engine, args);
        expect(currentExitCode()).toBe(1);
        expect(error.mock.calls.some(call => String(call[0]).includes('requires retry: synthetic daily queue outage'))).toBe(true);
        expect(await engine.executeRaw("SELECT op FROM op_checkpoints WHERE op='transcripts-ingest'")).toHaveLength(0);
        if (mode === '--json') {
          const result = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
          expect(result.cleanScan).toBe(false);
          expect(result.dailyMemoryError).toBe('synthetic daily queue outage');
          expect(result.pages.imported).toBe(1);
        }
        rejected.mockRestore();
        _resetCliExitVerdictForTests(); log.mockClear(); error.mockClear();
        await runTranscripts(engine, args);
        expect(currentExitCode()).toBe(0);
        expect(await engine.executeRaw("SELECT op FROM op_checkpoints WHERE op='transcripts-ingest'")).toHaveLength(1);
        expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE name='autopilot-daily-memory'")).toHaveLength(2);
        if (mode === '--json') {
          const result = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
          expect(result.cleanScan).toBe(true); expect(result.dailyMemoryError).toBeUndefined();
          expect(result.pages.imported).toBe(0); expect(result.pages.skipped).toBe(1);
        }
      } finally { rejected.mockRestore(); log.mockRestore(); error.mockRestore(); }
    });
  });
}
