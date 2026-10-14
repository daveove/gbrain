/** Daily refresh failure is a failed CLI outcome, with hash-skipped retry recovery. */
import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { runTranscripts } from '../src/commands/transcripts.ts';
import { currentExitCode, _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { runTranscriptsRecover } from '../src/commands/transcripts-recover.ts';
import { renderSessionParts } from '../src/core/transcripts/render.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { recordCompleted, loadOpCheckpoint } from '../src/core/op-checkpoint.ts';
import type { ParsedSession } from '../src/core/transcripts/types.ts';

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

// Recovery also imports successfully before the day-refresh handoff. The
// existing ingest-only case cannot catch recovery swallowing that failure or
// omitting it from its JSON summary. Only the queue outage is injected; parsing,
// recovery planning, re-importing and the CLI verdict are the real path.
for (const mode of ['human', 'json'] as const) {
  test(`recover codex ${mode}: an accepted restoration with failed daily handoff exposes failure and a nonzero verdict`, async () => {
    const sessionId = '01a0a325-0407-7fe2-867a-c98e6e63a000';
    const rollout = join(dir, `rollout-${sessionId}.jsonl`);
    copyFileSync(join(import.meta.dir, 'fixtures', 'transcripts', 'codex-rollout-0154.jsonl'), rollout);
    const session: ParsedSession = {
      meta: { harness: 'codex', sessionId, cwd: '/home/alice-example/agent-workspace',
        startedAt: '2026-10-01T09:00:00.000Z', raw: { session_id: sessionId } },
      messages: [
        { role: 'assistant', timestamp: '2026-10-01T09:00:06.000Z', text: 'fund-a led the widget-co seed.' },
        { role: 'assistant', timestamp: '2026-10-01T09:00:09.000Z', text: 'Noted: bridge check-in every Thursday.' },
      ],
    };
    const rendered = renderSessionParts({ session, redactionCount: 0, imperativesFlagged: 0 } as never,
      { sourcePath: rollout });
    for (const part of rendered.parts) {
      const seeded = await importFromContent(engine, part.slug, part.content, {
        noEmbed: true, sourceId: 'default', source_kind: 'transcript:codex',
        source_uri: rollout, ingested_via: 'cli:transcripts-ingest',
      });
      expect(seeded.status).toBe('imported');
    }
    const checkpoint = { op: 'transcripts-ingest', fingerprint: 'synthetic-recovery-watermark' };
    const watermark = ['since:2026-10-02T00:00:00.000Z'];
    await recordCompleted(engine, checkpoint, watermark);
    expect((await engine.getPage(rendered.baseSlug, { sourceId: 'default' }))!.compiled_truth).not.toContain('**User**');
    await withEnv({ GBRAIN_HOME: dir }, async () => {
      const log = spyOn(console, 'log').mockImplementation(() => {});
      const error = spyOn(console, 'error').mockImplementation(() => {});
      const rejected = spyOn(MinionQueue.prototype, 'add').mockRejectedValue(new Error('synthetic recovery daily queue outage'));
      try {
        await runTranscriptsRecover(engine, ['codex', rollout, '--apply', '--source-id', 'default',
          ...(mode === 'json' ? ['--json'] : [])]);
        expect(currentExitCode()).toBe(1);
        expect(error.mock.calls.some(call => String(call[0]).includes('requires retry: synthetic recovery daily queue outage'))).toBe(true);
        const restored = (await engine.getPage(rendered.baseSlug, { sourceId: 'default' }))!;
        expect(restored.compiled_truth).toContain('**User**');
        expect(restored.compiled_truth).toContain('Which fund led the widget-co seed round?');
        expect(await loadOpCheckpoint(engine, checkpoint)).toEqual(watermark);
        expect(await engine.executeRaw("SELECT id FROM facts WHERE source_id='default'")).toEqual([]);
        expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE name='autopilot-daily-memory'")).toEqual([]);
        // The historical refresh still has durable work to retry, despite the
        // restored transcript no longer matching the userless recovery query.
        expect(await engine.executeRaw("SELECT path FROM op_checkpoint_paths WHERE op='transcript-ingest-daily-memory'"))
          .not.toHaveLength(0);
        if (mode === 'json') {
          const result = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
          expect(result.applied).toBe(true);
          expect(result.plan.recoverable).toHaveLength(1);
          expect(result.ingest).toMatchObject({
            sessions_imported: 1, sessions_errored: 0,
            pages: { imported: 1 },
            dailyMemoryError: 'synthetic recovery daily queue outage',
          });
        } else {
          expect(log.mock.calls.some(call => String(call[0]).includes('restored: 1 page(s) re-imported, 0 session error(s)'))).toBe(true);
        }
      } finally {
        rejected.mockRestore(); log.mockRestore(); error.mockRestore();
      }
    });
  });
}
