import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { computeGraphFingerprint } from '../src/core/graph-usefulness/fingerprint.ts';
import { runPagedMeasure } from '../src/core/graph-usefulness/paged-runner.ts';

describe('graph fingerprint session-independent timestamp format', () => {
  let engine: PGLiteEngine;
  let dir: string;
  let timezone: string;
  let dateStyle: string;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    dir = mkdtempSync(join(tmpdir(), 'gbrain-fingerprint-format-'));
    const [settings] = await engine.executeRaw<{ timezone: string; date_style: string }>(
      `SELECT current_setting('TimeZone') AS timezone, current_setting('DateStyle') AS date_style`,
    );
    timezone = settings!.timezone;
    dateStyle = settings!.date_style;
    await engine.putPage('topics/format-page', { title: 'Format', type: 'note', compiled_truth: 'Synthetic format fixture' });
    await engine.upsertChunks('topics/format-page', [{ chunk_index: 0, chunk_text: 'Synthetic format fixture', chunk_source: 'compiled_truth' }]);
    await engine.executeRaw(`UPDATE pages SET effective_date='2026-01-02T03:04:05.123456Z'::timestamptz,
      updated_at='2026-01-03T04:05:06.234567Z'::timestamptz,
      created_at='2026-01-01T02:03:04.345678Z'::timestamptz WHERE slug='topics/format-page' AND source_id='default'`);
    await engine.executeRaw(`UPDATE content_chunks SET embedded_at='2026-01-04T05:06:07.456789Z'::timestamptz
      WHERE page_id=(SELECT id FROM pages WHERE slug='topics/format-page' AND source_id='default')`);
  });

  afterAll(async () => {
    await engine.executeRaw(`SELECT set_config('TimeZone',$1,false),set_config('DateStyle',$2,false)`, [timezone, dateStyle]);
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  test('UTC/ISO and Manila/SQL-DMY produce equal paged fingerprints', async () => {
    await engine.executeRaw(`SELECT set_config('TimeZone','UTC',false),set_config('DateStyle','ISO, MDY',false)`);
    const utc = await runPagedMeasure(engine, { sourceId: 'default', cursor: 0, limit: 1, checkpointPath: join(dir, 'utc.json') });
    await engine.executeRaw(`SELECT set_config('TimeZone','Asia/Manila',false),set_config('DateStyle','SQL, DMY',false)`);
    const manila = await runPagedMeasure(engine, { sourceId: 'default', cursor: 0, limit: 1, checkpointPath: join(dir, 'manila.json') });
    expect(manila.fingerprint.sha256).toBe(utc.fingerprint.sha256);

    await engine.executeRaw(`UPDATE content_chunks SET embedded_at=embedded_at+interval '1 microsecond'
      WHERE page_id=(SELECT id FROM pages WHERE slug='topics/format-page' AND source_id='default')`);
    expect((await runPagedMeasure(engine, { sourceId: 'default', cursor: 0, limit: 1, checkpointPath: join(dir, 'changed.json') })).fingerprint.sha256)
      .not.toBe(manila.fingerprint.sha256);
  });

  test('UTC/ISO and Manila/SQL-DMY produce equal graph and retrieval fingerprints', async () => {
    await engine.executeRaw(`SELECT set_config('TimeZone','UTC',false),set_config('DateStyle','ISO, MDY',false)`);
    const utcGraph = await computeGraphFingerprint(engine, { sourceId: 'default' });
    const utcProof = await computeGraphFingerprint(engine, { sourceId: 'default', searchConfig: '{"mode":"conservative"}' });
    await engine.executeRaw(`SELECT set_config('TimeZone','Asia/Manila',false),set_config('DateStyle','SQL, DMY',false)`);
    expect((await computeGraphFingerprint(engine, { sourceId: 'default' })).sha256).toBe(utcGraph.sha256);
    expect((await computeGraphFingerprint(engine, { sourceId: 'default', searchConfig: '{"mode":"conservative"}' })).sha256).toBe(utcProof.sha256);
    await engine.executeRaw(`UPDATE pages SET effective_date=effective_date+interval '1 microsecond'
      WHERE slug='topics/format-page' AND source_id='default'`);
    expect((await computeGraphFingerprint(engine, { sourceId: 'default' })).sha256).not.toBe(utcGraph.sha256);
  });

  for (const done of [false, true]) {
    for (const oldFormat of [undefined, 2, 3, 4, 5]) {
      test(`refuses ${done ? 'done' : 'partial'} checkpoint with ${oldFormat === undefined ? 'missing' : 'old'} fingerprint format`, async () => {
        const freshPath = join(dir, `fresh-${done}-${oldFormat}.json`);
        await runPagedMeasure(engine, { sourceId: 'default', cursor: 0, limit: 1, checkpointPath: freshPath });
        const checkpoint = JSON.parse(readFileSync(freshPath, 'utf8'));
        checkpoint.done = done;
        if (oldFormat === undefined) delete checkpoint.fingerprint_format;
        else checkpoint.fingerprint_format = oldFormat;
        writeFileSync(freshPath, JSON.stringify(checkpoint));
        await expect(runPagedMeasure(engine, { sourceId: 'default', cursor: checkpoint.cursor, limit: 1, checkpointPath: freshPath }))
          .rejects.toThrow(/unsupported fingerprint_format/);
      });
    }
  }

  test('source recreation changes nonpaged graph and retrieval fingerprints even with no pages', async () => {
    const sourceId = 'fingerprint-empty-recreation';
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    const beforeGraph = await computeGraphFingerprint(engine, { sourceId });
    const beforeProof = await computeGraphFingerprint(engine, { sourceId, searchConfig: '{}' });
    await engine.executeRaw('DELETE FROM sources WHERE id=$1', [sourceId]);
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    expect((await computeGraphFingerprint(engine, { sourceId })).sha256).not.toBe(beforeGraph.sha256);
    expect((await computeGraphFingerprint(engine, { sourceId, searchConfig: '{}' })).sha256).not.toBe(beforeProof.sha256);
  });

});
