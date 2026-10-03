import { createHash } from 'crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { measureGraphUsefulness } from '../src/core/graph-usefulness/measure.ts';
import {
  medianFromHistogram,
  PAGED_FINGERPRINT_FORMAT,
  PAGED_SOURCE_MUTATION_WATERMARK_SQL,
  readPagedSourceMutationWatermark,
  runPagedMeasure,
} from '../src/core/graph-usefulness/paged-runner.ts';
import {
  applyRelationManifest,
  parseRelationManifest,
} from '../src/core/graph-usefulness/relation-manifest.ts';
import type { RelationManifestRow } from '../src/core/graph-usefulness/types.ts';

const TRUE_GUARDS = {
  exact_endpoint_match: true,
  source_relation_current: true,
  no_incident_edge: true,
  readwise_clear: true,
} as const;

function relationManifest(rows: RelationManifestRow[]): string {
  return JSON.stringify({
    manifest_version: 1,
    issue: 'DAV-6220',
    rows,
  }, null, 2) + '\n';
}

describe('paged measure median', () => {
  test('matches percentile_cont(0.5) on a zero-heavy histogram', () => {
    expect(medianFromHistogram({ '0': 4, '2': 1 })).toBe(0);
    expect(medianFromHistogram({ '1': 1 })).toBe(1);
    expect(medianFromHistogram({})).toBe(0);
  });

  test('interpolates between the two middle degrees', () => {
    expect(medianFromHistogram({ '0': 1, '2': 1 })).toBe(1);
  });
});

describe('paged measure cursor and archived endpoints', () => {
  let engine: BrainEngine;
  let dir: string;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    dir = mkdtempSync(join(tmpdir(), 'gbrain-paged-'));
  });

  afterAll(async () => {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  test('rejects a nonzero initial cursor when the checkpoint is absent', async () => {
    const checkpointPath = join(dir, 'missing-checkpoint.json');
    await expect(runPagedMeasure(engine, {
      sourceId: 'default',
      cursor: 42,
      limit: 10,
      checkpointPath,
    })).rejects.toThrow(/requires an existing checkpoint with accumulated counts/);
  });

  test('resumes from a checkpoint that already holds accumulated counts', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, archived) VALUES ('paged-resume', 'paged-resume', false)
       ON CONFLICT (id) DO UPDATE SET archived = false, name = 'paged-resume'`,
    );
    await engine.putPage('topics/paged-early', {
      title: 'Early', compiled_truth: 'early page', type: 'note',
    }, { sourceId: 'paged-resume' });
    await engine.putPage('topics/paged-late', {
      title: 'Late', compiled_truth: 'late page', type: 'note',
    }, { sourceId: 'paged-resume' });
    const ids = await engine.executeRaw<{ id: number; slug: string }>(
      `SELECT id, slug FROM pages WHERE source_id = 'paged-resume' ORDER BY id`,
    );
    expect(ids.length).toBe(2);
    const earlyId = Number(ids[0]!.id);
    const lateId = Number(ids[1]!.id);
    const checkpointPath = join(dir, 'resume-checkpoint.json');
    const resumeWatermark = await readPagedSourceMutationWatermark(engine, 'paged-resume');
    writeFileSync(checkpointPath, JSON.stringify({
      source_id: 'paged-resume',
      cursor: earlyId,
      done: false,
      active_pages: 1,
      link_rows: 0,
      valid_links: 0,
      degree_sum: 0,
      zero_degree_pages: 1,
      degree_counts: { '0': 1 },
      junk: {},
      union_source_ids: ['paged-resume'],
      owned_link_rows: 0,
      identity_hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      fingerprint_format: PAGED_FINGERPRINT_FORMAT,
      mutation_watermark: resumeWatermark,
    }) + '\n');

    const report = await runPagedMeasure(engine, {
      sourceId: 'paged-resume',
      cursor: earlyId,
      limit: 50,
      checkpointPath,
    });
    expect(report.active_pages).toBe(2);
    expect(report.zero_degree_pages).toBe(2);
    const saved = JSON.parse(readFileSync(checkpointPath, 'utf8')) as { cursor: number; done: boolean };
    expect(saved.done).toBe(true);
    expect(saved.cursor).toBe(lateId);
  });

  test('same and cross-source links use ownership without retained checkpoint ids', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, archived) VALUES
         ('own-a', 'own-a', false),
         ('own-b', 'own-b', false)
       ON CONFLICT (id) DO UPDATE SET archived = false, name = EXCLUDED.name`,
    );
    await engine.putPage('topics/own-early', {
      title: 'Early', compiled_truth: 'early', type: 'note',
    }, { sourceId: 'own-a' });
    await engine.putPage('topics/own-late', {
      title: 'Late', compiled_truth: 'late', type: 'note',
    }, { sourceId: 'own-a' });
    await engine.putPage('topics/own-other', {
      title: 'Other', compiled_truth: 'other', type: 'note',
    }, { sourceId: 'own-b' });
    await engine.addLink(
      'topics/own-early', 'topics/own-late', 'same', 'related_to', 'manual',
      undefined, undefined,
      { fromSourceId: 'own-a', toSourceId: 'own-a' },
    );
    await engine.addLink(
      'topics/own-late', 'topics/own-other', 'cross', 'related_to', 'manual',
      undefined, undefined,
      { fromSourceId: 'own-a', toSourceId: 'own-b' },
    );
    const checkpointPath = join(dir, 'ownership-checkpoint.json');
    const report = await runPagedMeasure(engine, {
      sourceId: 'own-a',
      cursor: 0,
      limit: 1,
      checkpointPath,
    });
    expect(report.link_rows).toBe(2);
    expect(report.valid_links).toBe(2);
    expect(report.owned_link_rows).toBe(2);
    expect(report).not.toHaveProperty('seen_link_ids');
    const saved = JSON.parse(readFileSync(checkpointPath, 'utf8')) as {
      owned_link_rows: number;
      link_rows: number;
    };
    expect(saved).not.toHaveProperty('seen_link_ids');
    expect(saved.owned_link_rows).toBe(report.owned_link_rows);
    expect(saved.link_rows).toBe(2);
  });

  test('rejects a higher --cursor against a completed checkpoint', async () => {
    const checkpointPath = join(dir, 'done-gap-checkpoint.json');
    const gapWatermark = await readPagedSourceMutationWatermark(engine, 'paged-resume');
    writeFileSync(checkpointPath, JSON.stringify({
      source_id: 'paged-resume',
      cursor: 10,
      done: true,
      active_pages: 1,
      link_rows: 0,
      valid_links: 0,
      degree_sum: 0,
      zero_degree_pages: 1,
      degree_counts: { '0': 1 },
      junk: {},
      union_source_ids: ['paged-resume'],
      owned_link_rows: 0,
      identity_hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      fingerprint_format: PAGED_FINGERPRINT_FORMAT,
      mutation_watermark: gapWatermark,
    }) + '\n');
    await expect(runPagedMeasure(engine, {
      sourceId: 'paged-resume',
      cursor: 999,
      limit: 10,
      checkpointPath,
    })).rejects.toThrow(/behind --cursor 999/);
  });

  test('refuses a checkpoint after the source corpus mutates', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, archived) VALUES ('wm-src', 'wm-src', false)
       ON CONFLICT (id) DO UPDATE SET archived = false, name = 'wm-src'`,
    );
    await engine.putPage('topics/wm-early', {
      title: 'WM early', compiled_truth: 'early', type: 'note',
    }, { sourceId: 'wm-src' });
    await engine.putPage('topics/wm-late', {
      title: 'WM late', compiled_truth: 'late', type: 'note',
    }, { sourceId: 'wm-src' });
    const ids = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM pages WHERE source_id = 'wm-src' ORDER BY id`,
    );
    const earlyId = Number(ids[0]!.id);
    const checkpointPath = join(dir, 'wm-checkpoint.json');
    const watermark = await readPagedSourceMutationWatermark(engine, 'wm-src');
    writeFileSync(checkpointPath, JSON.stringify({
      source_id: 'wm-src',
      cursor: earlyId,
      done: false,
      active_pages: 1,
      link_rows: 0,
      valid_links: 0,
      degree_sum: 0,
      zero_degree_pages: 1,
      degree_counts: { '0': 1 },
      junk: {},
      union_source_ids: ['wm-src'],
      owned_link_rows: 0,
      identity_hash: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      fingerprint_format: PAGED_FINGERPRINT_FORMAT,
      mutation_watermark: watermark,
    }) + '\n');
    await engine.putPage('topics/wm-late', {
      title: 'WM late', compiled_truth: 'late mutated', type: 'note',
    }, { sourceId: 'wm-src' });
    await expect(runPagedMeasure(engine, {
      sourceId: 'wm-src',
      cursor: earlyId,
      limit: 50,
      checkpointPath,
    })).rejects.toThrow(/Corpus mutated during paged measure/);
  });

  test('excludes links whose endpoint source is archived from live_edge counts', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, archived) VALUES
         ('paged-live', 'paged-live', false),
         ('paged-arch', 'paged-arch', false)
       ON CONFLICT (id) DO UPDATE SET archived = false, name = EXCLUDED.name`,
    );
    await engine.putPage('topics/paged-live-a', {
      title: 'Live A', compiled_truth: 'live a', type: 'note',
    }, { sourceId: 'paged-live' });
    await engine.putPage('topics/paged-arch-b', {
      title: 'Arch B', compiled_truth: 'arch b', type: 'note',
    }, { sourceId: 'paged-arch' });
    await engine.addLink(
      'topics/paged-live-a', 'topics/paged-arch-b', 'ctx', 'related_to', 'manual',
      undefined, undefined,
      { fromSourceId: 'paged-live', toSourceId: 'paged-arch' },
    );

    const liveCheckpoint = join(dir, 'arch-live-checkpoint.json');
    const beforeArchive = await runPagedMeasure(engine, {
      sourceId: 'paged-live',
      cursor: 0,
      limit: 50,
      checkpointPath: liveCheckpoint,
    });
    expect(beforeArchive.link_rows).toBe(1);
    expect(beforeArchive.valid_links).toBe(1);
    expect(beforeArchive.avg_degree).toBeGreaterThan(0);

    await engine.executeRaw(`UPDATE sources SET archived = true WHERE id = 'paged-arch'`);
    const afterCheckpoint = join(dir, 'arch-after-checkpoint.json');
    const afterArchive = await runPagedMeasure(engine, {
      sourceId: 'paged-live',
      cursor: 0,
      limit: 50,
      checkpointPath: afterCheckpoint,
    });
    expect(afterArchive.active_pages).toBe(beforeArchive.active_pages);
    expect(afterArchive.link_rows).toBe(0);
    expect(afterArchive.valid_links).toBe(0);
    expect(afterArchive.avg_degree).toBe(0);
    expect(afterArchive.zero_degree_pages).toBe(afterArchive.active_pages);
    const old = await measureGraphUsefulness(engine, { sourceId: 'paged-live' });
    expect(afterArchive.link_rows).toBe(old.link_rows);
    expect(afterArchive.valid_links).toBe(old.valid_links);
    expect(afterArchive.zero_degree_pages).toBe(old.zero_degree_pages);
    expect(afterArchive.avg_degree).toBe(old.avg_degree);
    expect(afterArchive.active_pages).toBe(old.active_pages);
  });
});

describe('paged relation apply scan scope', () => {
  let engine: BrainEngine;
  let dir: string;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    dir = mkdtempSync(join(tmpdir(), 'gbrain-paged-rel-'));
    await engine.executeRaw(
      `INSERT INTO sources (id, name, archived) VALUES
         ('scan-a', 'scan-a', false),
         ('scan-b', 'scan-b', false)
       ON CONFLICT (id) DO UPDATE SET archived = false, name = EXCLUDED.name`,
    );
    await engine.putPage('topics/scan-a-from', {
      title: 'A from', compiled_truth: 'a from', type: 'note',
    }, { sourceId: 'scan-a' });
    await engine.putPage('topics/scan-a-to', {
      title: 'A to', compiled_truth: 'a to', type: 'note',
    }, { sourceId: 'scan-a' });
    await engine.putPage('topics/scan-b-from', {
      title: 'B from', compiled_truth: 'b from', type: 'note',
    }, { sourceId: 'scan-b' });
    await engine.putPage('topics/scan-b-to', {
      title: 'B to', compiled_truth: 'b to', type: 'note',
    }, { sourceId: 'scan-b' });
  });

  afterAll(async () => {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  test('paged fingerprints cover every resolved endpoint source, not only the CLI default', async () => {
    const raw = relationManifest([{
      id: 'b-to-b',
      from_slug: 'topics/scan-b-from',
      to_slug: 'topics/scan-b-to',
      from_source_id: 'scan-b',
      to_source_id: 'scan-b',
      link_type: 'related_to',
      link_source: 'tana-relation-r2',
      guards: TRUE_GUARDS,
    }]);
    const manifest = parseRelationManifest(raw);
    const receiptPath = join(dir, 'outside-receipt.json');
    // CLI default / pageScan.sourceId is scan-a, but the row lives on scan-b.
    // Fingerprints must walk scan-b so before/after hashes move with the apply.
    const result = await applyRelationManifest(engine, manifest, raw, {
      apply: true,
      receiptPath,
      defaultSourceId: 'scan-a',
      pageScan: {
        sourceId: 'scan-a',
        cursor: 0,
        limit: 50,
        checkpointPath: receiptPath,
      },
    });
    expect(result.applied).toBe(1);
    expect(result.before.sha256).not.toBe(result.after.sha256);
    expect(result.after.link_rows).toBe(result.before.link_rows + 1);
  });

  test('applies same-source rows under the paged fingerprint source', async () => {
    const raw = relationManifest([{
      id: 'a-to-a',
      from_slug: 'topics/scan-a-from',
      to_slug: 'topics/scan-a-to',
      from_source_id: 'scan-a',
      to_source_id: 'scan-a',
      link_type: 'related_to',
      link_source: 'tana-relation-r2',
      guards: TRUE_GUARDS,
    }]);
    const manifest = parseRelationManifest(raw);
    const receiptPath = join(dir, 'inside-receipt.json');
    const result = await applyRelationManifest(engine, manifest, raw, {
      apply: true,
      receiptPath,
      defaultSourceId: 'scan-a',
      pageScan: {
        sourceId: 'scan-a',
        cursor: 0,
        limit: 50,
        checkpointPath: receiptPath,
      },
    });
    expect(result.applied).toBe(1);
    expect(result.before.sha256).not.toBe(result.after.sha256);
    expect(result.after.link_rows).toBe(result.before.link_rows + 1);
  });
});


describe('paged fingerprint identities and degree', () => {
  let engine: BrainEngine;
  let dir: string;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    dir = mkdtempSync(join(tmpdir(), 'gbrain-paged-id-'));
    await engine.executeRaw(
      `INSERT INTO sources (id, name, archived) VALUES ('id-src', 'id-src', false)
       ON CONFLICT (id) DO UPDATE SET archived = false, name = 'id-src'`,
    );
  });

  afterAll(async () => {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  test('same-cardinality edge rewrite changes the paged fingerprint sha256', async () => {
    await engine.putPage('topics/id-a', { title: 'A', compiled_truth: 'a', type: 'note' }, { sourceId: 'id-src' });
    await engine.putPage('topics/id-b', { title: 'B', compiled_truth: 'b', type: 'note' }, { sourceId: 'id-src' });
    await engine.putPage('topics/id-c', { title: 'C', compiled_truth: 'c', type: 'note' }, { sourceId: 'id-src' });
    await engine.putPage('topics/id-d', { title: 'D', compiled_truth: 'd', type: 'note' }, { sourceId: 'id-src' });
    await engine.addLink(
      'topics/id-a', 'topics/id-b', 'ctx', 'related_to', 'manual',
      undefined, undefined, { fromSourceId: 'id-src', toSourceId: 'id-src' },
    );
    await engine.addLink(
      'topics/id-c', 'topics/id-d', 'ctx', 'related_to', 'manual',
      undefined, undefined, { fromSourceId: 'id-src', toSourceId: 'id-src' },
    );
    const beforePath = join(dir, 'id-before.json');
    const before = await runPagedMeasure(engine, {
      sourceId: 'id-src', cursor: 0, limit: 50, checkpointPath: beforePath,
    });
    expect(before.link_rows).toBe(2);

    // Swap to A-C and B-D: same counts, different identities.
    await engine.executeRaw(
      `DELETE FROM links WHERE from_page_id IN (
         SELECT id FROM pages WHERE source_id = 'id-src'
       ) OR to_page_id IN (
         SELECT id FROM pages WHERE source_id = 'id-src'
       )`,
    );
    await engine.addLink(
      'topics/id-a', 'topics/id-c', 'ctx', 'related_to', 'manual',
      undefined, undefined, { fromSourceId: 'id-src', toSourceId: 'id-src' },
    );
    await engine.addLink(
      'topics/id-b', 'topics/id-d', 'ctx', 'related_to', 'manual',
      undefined, undefined, { fromSourceId: 'id-src', toSourceId: 'id-src' },
    );
    const afterPath = join(dir, 'id-after.json');
    const after = await runPagedMeasure(engine, {
      sourceId: 'id-src', cursor: 0, limit: 50, checkpointPath: afterPath,
    });
    expect(after.link_rows).toBe(before.link_rows);
    expect(after.active_pages).toBe(before.active_pages);
    expect(after.fingerprint.sha256).not.toBe(before.fingerprint.sha256);
  });

  test('counts a self-link once in degree', async () => {
    await engine.putPage('topics/id-self', {
      title: 'Self', compiled_truth: 'self', type: 'note',
    }, { sourceId: 'id-src' });
    await engine.addLink(
      'topics/id-self', 'topics/id-self', 'ctx', 'related_to', 'manual',
      undefined, undefined, { fromSourceId: 'id-src', toSourceId: 'id-src' },
    );
    const checkpointPath = join(dir, 'self-degree.json');
    // Isolate: measure only after truncating other id-src pages would be heavy.
    // Instead assert the self page contributes degree 1 via a dedicated source.
    await engine.executeRaw(
      `INSERT INTO sources (id, name, archived) VALUES ('self-src', 'self-src', false)
       ON CONFLICT (id) DO UPDATE SET archived = false, name = 'self-src'`,
    );
    await engine.putPage('topics/only-self', {
      title: 'OnlySelf', compiled_truth: 'only self', type: 'note',
    }, { sourceId: 'self-src' });
    await engine.addLink(
      'topics/only-self', 'topics/only-self', 'ctx', 'related_to', 'manual',
      undefined, undefined, { fromSourceId: 'self-src', toSourceId: 'self-src' },
    );
    const report = await runPagedMeasure(engine, {
      sourceId: 'self-src', cursor: 0, limit: 50, checkpointPath: join(dir, 'only-self.json'),
    });
    expect(report.active_pages).toBe(1);
    expect(report.link_rows).toBe(1);
    expect(report.avg_degree).toBe(1);
    expect(report.median_degree).toBe(1);
    expect(report.zero_degree_pages).toBe(0);
  });
  test('chunk rewrite changes the paged fingerprint sha256', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, archived) VALUES ('chunk-src', 'chunk-src', false)
       ON CONFLICT (id) DO UPDATE SET archived = false, name = 'chunk-src'`,
    );
    await engine.putPage('topics/chunk-page', {
      title: 'Chunk', compiled_truth: 'chunk body', type: 'note',
    }, { sourceId: 'chunk-src' });
    await engine.upsertChunks('topics/chunk-page', [
      { chunk_index: 0, chunk_text: 'chunk body v1', chunk_source: 'compiled_truth' },
    ], { sourceId: 'chunk-src' });
    const before = await runPagedMeasure(engine, {
      sourceId: 'chunk-src', cursor: 0, limit: 50, checkpointPath: join(dir, 'chunk-before.json'),
    });
    await engine.upsertChunks('topics/chunk-page', [
      { chunk_index: 0, chunk_text: 'chunk body v2 rewritten', chunk_source: 'compiled_truth' },
    ], { sourceId: 'chunk-src' });
    const after = await runPagedMeasure(engine, {
      sourceId: 'chunk-src', cursor: 0, limit: 50, checkpointPath: join(dir, 'chunk-after.json'),
    });
    expect(after.active_pages).toBe(before.active_pages);
    expect(after.fingerprint.sha256).not.toBe(before.fingerprint.sha256);
  });

  test('multimodal embedding revision changes the paged fingerprint sha256', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, archived) VALUES ('mm-src', 'mm-src', false)
       ON CONFLICT (id) DO UPDATE SET archived = false, name = 'mm-src'`,
    );
    await engine.putPage('topics/mm-page', {
      title: 'MM', compiled_truth: 'mm body', type: 'note',
    }, { sourceId: 'mm-src' });
    await engine.upsertChunks('topics/mm-page', [
      { chunk_index: 0, chunk_text: 'mm body', chunk_source: 'compiled_truth' },
    ], { sourceId: 'mm-src' });
    const before = await runPagedMeasure(engine, {
      sourceId: 'mm-src', cursor: 0, limit: 50, checkpointPath: join(dir, 'mm-before.json'),
    });
    await engine.executeRaw(
      `UPDATE content_chunks
          SET embedding_image = array_fill(0.5, ARRAY[1024])::vector,
              modality = 'image',
              embedded_at = now()
        WHERE page_id = (
          SELECT id FROM pages WHERE slug = 'topics/mm-page' AND source_id = 'mm-src' AND deleted_at IS NULL
        )
          AND chunk_index = 0`,
    );
    const after = await runPagedMeasure(engine, {
      sourceId: 'mm-src', cursor: 0, limit: 50, checkpointPath: join(dir, 'mm-after.json'),
    });
    expect(after.active_pages).toBe(before.active_pages);
    expect(after.fingerprint.sha256).not.toBe(before.fingerprint.sha256);
  });

});

describe('paged multi-source fingerprint combine', () => {
  let engine: BrainEngine;
  let dir: string;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    dir = mkdtempSync(join(tmpdir(), 'gbrain-paged-xsrc-'));
    await engine.executeRaw(
      `INSERT INTO sources (id, name, archived) VALUES
         ('xa', 'xa', false),
         ('xb', 'xb', false)
       ON CONFLICT (id) DO UPDATE SET archived = false, name = EXCLUDED.name`,
    );
    await engine.putPage('topics/xa-page', {
      title: 'XA', compiled_truth: 'xa', type: 'note',
    }, { sourceId: 'xa' });
    await engine.putPage('topics/xb-page', {
      title: 'XB', compiled_truth: 'xb', type: 'note',
    }, { sourceId: 'xb' });
  });

  afterAll(async () => {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  test('cross-source apply bumps combined link_rows by one, not two', async () => {
    const raw = relationManifest([{
      id: 'xa-xb',
      from_slug: 'topics/xa-page',
      to_slug: 'topics/xb-page',
      from_source_id: 'xa',
      to_source_id: 'xb',
      link_type: 'related_to',
      link_source: 'tana-relation-r2',
      guards: TRUE_GUARDS,
    }]);
    const manifest = parseRelationManifest(raw);
    const receiptPath = join(dir, 'xsrc-receipt.json');
    const result = await applyRelationManifest(engine, manifest, raw, {
      apply: true,
      receiptPath,
      defaultSourceId: 'xa',
      pageScan: {
        sourceId: 'xa',
        cursor: 0,
        limit: 50,
        checkpointPath: receiptPath,
      },
    });
    expect(result.applied).toBe(1);
    expect(result.after.link_rows).toBe(result.before.link_rows + 1);
    expect(result.after.valid_links).toBe(result.before.valid_links + 1);
    expect(result.before.sha256).not.toBe(result.after.sha256);
  });

  test('reused --checkpoint with a new receipt does not return the prior run fingerprints', async () => {
    await engine.putPage('topics/bind-from', {
      title: 'Bind from', compiled_truth: 'bind from', type: 'note',
    }, { sourceId: 'xa' });
    await engine.putPage('topics/bind-to', {
      title: 'Bind to', compiled_truth: 'bind to', type: 'note',
    }, { sourceId: 'xa' });
    const raw = relationManifest([{
      id: 'bind-xa',
      from_slug: 'topics/bind-from',
      to_slug: 'topics/bind-to',
      from_source_id: 'xa',
      to_source_id: 'xa',
      link_type: 'related_to',
      link_source: 'tana-relation-r2',
      guards: TRUE_GUARDS,
    }]);
    const manifest = parseRelationManifest(raw);
    const sharedCheckpoint = join(dir, 'shared-apply-checkpoint.json');
    const first = await applyRelationManifest(engine, manifest, raw, {
      apply: true,
      receiptPath: join(dir, 'bind-receipt-1.json'),
      defaultSourceId: 'xa',
      pageScan: {
        sourceId: 'xa',
        cursor: 0,
        limit: 50,
        checkpointPath: sharedCheckpoint,
      },
    });
    expect(first.applied).toBe(1);
    expect(first.before.sha256).not.toBe(first.after.sha256);

    // Second run shares the checkpoint base but uses a different receipt.
    // Dry-run must fingerprint the live graph (link already present), not the
    // first run's completed before/after pair.
    const second = await applyRelationManifest(engine, manifest, raw, {
      apply: false,
      receiptPath: join(dir, 'bind-receipt-2.json'),
      defaultSourceId: 'xa',
      pageScan: {
        sourceId: 'xa',
        cursor: 0,
        limit: 50,
        checkpointPath: sharedCheckpoint,
      },
    });
    expect(second.applied).toBe(0);
    expect(second.before.sha256).toBe(second.after.sha256);
    expect(second.before.sha256).toBe(first.after.sha256);
  });

  test('resume with nonzero --cursor starts a fresh after-phase scan at cursor zero', async () => {
    await engine.putPage('topics/az-from', {
      title: 'AZ from', compiled_truth: 'az from', type: 'note',
    }, { sourceId: 'xa' });
    await engine.putPage('topics/az-to', {
      title: 'AZ to', compiled_truth: 'az to', type: 'note',
    }, { sourceId: 'xa' });
    const pages = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM pages WHERE source_id = 'xa' ORDER BY id LIMIT 1`,
    );
    const nonzero = Number(pages[0]!.id);
    expect(nonzero).toBeGreaterThan(0);

    const raw = relationManifest([{
      id: 'az-row',
      from_slug: 'topics/az-from',
      to_slug: 'topics/az-to',
      from_source_id: 'xa',
      to_source_id: 'xa',
      link_type: 'related_to',
      link_source: 'tana-relation-r2',
      guards: TRUE_GUARDS,
    }]);
    const manifest = parseRelationManifest(raw);
    const receiptPath = join(dir, 'az-receipt.json');
    const checkpointBase = join(dir, 'az-checkpoint.json');
    const manifestSha = createHash('sha256').update(raw).digest('hex');
    const runId = createHash('sha256')
      .update(receiptPath)
      .update('\n')
      .update(manifestSha)
      .digest('hex')
      .slice(0, 16);
    const beforePath = `${checkpointBase}.before.xa.${runId}`;

    // Complete a before-phase checkpoint under this receipt so nonzero --cursor
    // can resume before, then hit a fresh after-phase path.
    const beforeMeasure = await runPagedMeasure(engine, {
      sourceId: 'xa',
      cursor: 0,
      limit: 50,
      checkpointPath: beforePath,
      unionSourceIds: ['xa'],
    });
    expect(beforeMeasure.active_pages).toBeGreaterThan(0);
    expect(existsSync(beforePath)).toBe(true);

    const afterPath = `${checkpointBase}.after.xa.${runId}`;
    expect(existsSync(afterPath)).toBe(false);

    // Nonzero CLI cursor + missing after checkpoint previously rejected apply.
    const result = await applyRelationManifest(engine, manifest, raw, {
      apply: true,
      receiptPath,
      defaultSourceId: 'xa',
      pageScan: {
        sourceId: 'xa',
        cursor: nonzero,
        limit: 50,
        checkpointPath: checkpointBase,
      },
    });
    expect(result.applied).toBe(1);
    expect(result.before.sha256).not.toBe(result.after.sha256);
    expect(existsSync(afterPath)).toBe(true);
  });

  test('same receipt path with a different manifest does not reuse phase checkpoints', async () => {
    await engine.putPage('topics/mani-from', {
      title: 'Mani from', compiled_truth: 'mani from', type: 'note',
    }, { sourceId: 'xa' });
    await engine.putPage('topics/mani-to', {
      title: 'Mani to', compiled_truth: 'mani to', type: 'note',
    }, { sourceId: 'xa' });
    await engine.putPage('topics/mani-to-b', {
      title: 'Mani to B', compiled_truth: 'mani to b', type: 'note',
    }, { sourceId: 'xa' });
    const rawA = relationManifest([{
      id: 'mani-a',
      from_slug: 'topics/mani-from',
      to_slug: 'topics/mani-to',
      from_source_id: 'xa',
      to_source_id: 'xa',
      link_type: 'related_to',
      link_source: 'tana-relation-r2',
      guards: TRUE_GUARDS,
    }]);
    const rawB = relationManifest([{
      id: 'mani-b',
      from_slug: 'topics/mani-from',
      to_slug: 'topics/mani-to-b',
      from_source_id: 'xa',
      to_source_id: 'xa',
      link_type: 'related_to',
      link_source: 'tana-relation-r2',
      guards: TRUE_GUARDS,
    }]);
    const sharedCheckpoint = join(dir, 'shared-mani-checkpoint.json');
    const receiptPath = join(dir, 'mani-receipt.json');
    const first = await applyRelationManifest(engine, parseRelationManifest(rawA), rawA, {
      apply: true,
      receiptPath,
      defaultSourceId: 'xa',
      pageScan: {
        sourceId: 'xa',
        cursor: 0,
        limit: 50,
        checkpointPath: sharedCheckpoint,
      },
    });
    expect(first.applied).toBe(1);
    // Second apply uses a different manifest under the same receipt/checkpoint bases
    // after removing the first receipt file so refuseExistingReceipt does not trip.
    unlinkSync(receiptPath);
    const second = await applyRelationManifest(engine, parseRelationManifest(rawB), rawB, {
      apply: false,
      receiptPath,
      defaultSourceId: 'xa',
      pageScan: {
        sourceId: 'xa',
        cursor: 0,
        limit: 50,
        checkpointPath: sharedCheckpoint,
      },
    });
    // Dry-run of B must see current graph (with A applied), not A's before/after pair.
    expect(second.applied).toBe(0);
    expect(second.before.sha256).toBe(second.after.sha256);
    expect(second.before.sha256).toBe(first.after.sha256);
  });
});

function writeStalePrefixCheckpoint(
  checkpointPath: string,
  sourceId: string,
  cursor: number,
  watermark: string,
): void {
  writeFileSync(checkpointPath, JSON.stringify({
    source_id: sourceId,
    cursor,
    done: false,
    active_pages: 1,
    link_rows: 1,
    valid_links: 1,
    degree_sum: 1,
    zero_degree_pages: 0,
    degree_counts: { '1': 1 },
    junk: {},
    union_source_ids: [sourceId],
    owned_link_rows: 0,
    identity_hash: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    fingerprint_format: PAGED_FINGERPRINT_FORMAT,
    mutation_watermark: watermark,
  }) + '\n');
}

function mutationGeneration(watermark: string): bigint { return BigInt(watermark.split(':')[1]!); }

describe('paged source watermark deletions', () => {
  let engine: BrainEngine;
  let dir: string;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    dir = mkdtempSync(join(tmpdir(), 'gbrain-paged-del-'));
  });

  afterAll(async () => {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  async function scopedMax(sql: string, sourceId: string): Promise<number> {
    const rows = await engine.executeRaw<{ mx: number | string | null }>(sql, [sourceId]);
    return Number(rows[0]?.mx ?? 0);
  }

  test('the watermark read is the source generation primary key', async () => {
    expect(PAGED_SOURCE_MUTATION_WATERMARK_SQL).not.toMatch(/xmin|links_id_seq|count\s*\(|pg_sequences/i);
    const plan = await engine.executeRaw<Record<string, string>>(
      `EXPLAIN ${PAGED_SOURCE_MUTATION_WATERMARK_SQL}`,
      ['default'],
    );
    const text = plan.map(row => Object.values(row).join(' ')).join('\n');
    expect(text).toMatch(/Index Scan using source_mutation_generation_pkey/);
    expect(text).not.toMatch(/Seq Scan on (pages|links|content_chunks)/);
  });

  test('an in-place rewrite of an older page moves the watermark and refuses resume', async () => {
    const sourceId = 'upd-page';
    await engine.executeRaw(
      `INSERT INTO sources (id, name, archived) VALUES ('upd-page', 'upd-page', false)
       ON CONFLICT (id) DO UPDATE SET archived = false, name = 'upd-page'`,
    );
    await engine.putPage('topics/upd-old', {
      title: 'Old', compiled_truth: 'old body', type: 'note',
    }, { sourceId });
    await engine.putPage('topics/upd-new', {
      title: 'New', compiled_truth: 'new body', type: 'note',
    }, { sourceId });
    const pages = await engine.executeRaw<{ id: number | string }>(
      `SELECT id FROM pages WHERE source_id = $1 ORDER BY id ASC`,
      [sourceId],
    );
    expect(pages.length).toBe(2);
    const olderId = Number(pages[0]!.id);
    const before = await readPagedSourceMutationWatermark(engine, sourceId);
    const countBefore = await engine.executeRaw<{ n: number | string }>(
      `SELECT count(*)::int AS n FROM pages WHERE source_id = $1`,
      [sourceId],
    );
    writeStalePrefixCheckpoint(join(dir, 'upd-page.json'), sourceId, olderId, before);

    await engine.executeRaw(
      `UPDATE pages SET compiled_truth = 'rewritten body' WHERE id = $1`,
      [olderId],
    );
    const countAfter = await engine.executeRaw<{ n: number | string }>(
      `SELECT count(*)::int AS n FROM pages WHERE source_id = $1`,
      [sourceId],
    );
    expect(Number(countAfter[0]?.n)).toBe(Number(countBefore[0]?.n));
    const after = await readPagedSourceMutationWatermark(engine, sourceId);
    expect(mutationGeneration(after)).toBeGreaterThan(mutationGeneration(before));

    await expect(runPagedMeasure(engine, {
      sourceId,
      cursor: olderId,
      limit: 10,
      checkpointPath: join(dir, 'upd-page.json'),
    })).rejects.toThrow(/Corpus mutated during paged measure for source upd-page/);
  });

  test('a last_retrieved_at write does not move the watermark and resume completes', async () => {
    const sourceId = 'ret-page';
    await engine.executeRaw(
      `INSERT INTO sources (id, name, archived) VALUES ('ret-page', 'ret-page', false)
       ON CONFLICT (id) DO UPDATE SET archived = false, name = 'ret-page'`,
    );
    await engine.putPage('topics/ret-old', {
      title: 'Old', compiled_truth: 'old retrieval', type: 'note',
    }, { sourceId });
    await engine.putPage('topics/ret-new', {
      title: 'New', compiled_truth: 'new retrieval', type: 'note',
    }, { sourceId });
    const checkpointPath = join(dir, 'ret-page.json');
    let pageReads = 0;
    const executeRaw: BrainEngine['executeRaw'] = async (sql, params, opts) => {
      if (typeof sql === 'string' && sql.includes('id > $2') && sql.includes('FROM pages')) {
        pageReads += 1;
        if (pageReads === 2) throw new Error('killed between page batches');
      }
      return engine.executeRaw(sql, params, opts);
    };
    const hooked = new Proxy(engine, {
      get(target, prop, receiver) {
        if (prop === 'executeRaw') return executeRaw;
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(runPagedMeasure(hooked, {
      sourceId,
      cursor: 0,
      limit: 1,
      checkpointPath,
    })).rejects.toThrow(/killed between page batches/);
    const partial = JSON.parse(readFileSync(checkpointPath, 'utf8')) as {
      done: boolean;
      active_pages: number;
      mutation_watermark: string;
    };
    expect(partial.done).toBe(false);
    expect(partial.active_pages).toBe(1);
    const before = partial.mutation_watermark;

    await engine.executeRaw(
      `UPDATE pages SET last_retrieved_at = now() WHERE source_id = $1`,
      [sourceId],
    );
    expect(await readPagedSourceMutationWatermark(engine, sourceId)).toBe(before);

    const resumed = await runPagedMeasure(engine, {
      sourceId,
      cursor: 0,
      limit: 1,
      checkpointPath,
    });
    expect(resumed.active_pages).toBe(2);
    const saved = JSON.parse(readFileSync(checkpointPath, 'utf8')) as {
      done: boolean;
      mutation_watermark: string;
    };
    expect(saved.done).toBe(true);
    expect(saved.mutation_watermark).toBe(before);

    const fresh = await runPagedMeasure(engine, {
      sourceId,
      cursor: 0,
      limit: 10,
      checkpointPath: join(dir, 'ret-page-fresh.json'),
    });
    expect(fresh.active_pages).toBe(2);
    expect(fresh.fingerprint.sha256).toBe(resumed.fingerprint.sha256);
  });

  test('moving a page records the old source and the new source', async () => {
    const fromId = 'move-from';
    const toId = 'move-to';
    await engine.executeRaw(
      `INSERT INTO sources (id, name, archived) VALUES
         ('move-from', 'move-from', false),
         ('move-to', 'move-to', false)
       ON CONFLICT (id) DO UPDATE SET archived = false, name = EXCLUDED.name`,
    );
    await engine.putPage('topics/move-me', {
      title: 'Move', compiled_truth: 'move body', type: 'note',
    }, { sourceId: fromId });
    const beforeFrom = await readPagedSourceMutationWatermark(engine, fromId);
    const beforeTo = await readPagedSourceMutationWatermark(engine, toId);
    await engine.executeRaw(
      `UPDATE pages SET source_id = $2 WHERE source_id = $1 AND slug = 'topics/move-me'`,
      [fromId, toId],
    );
    expect(mutationGeneration(await readPagedSourceMutationWatermark(engine, fromId))).toBeGreaterThan(mutationGeneration(beforeFrom));
    expect(mutationGeneration(await readPagedSourceMutationWatermark(engine, toId))).toBeGreaterThan(mutationGeneration(beforeTo));
  });

  test('a rolled-back page rewrite leaves the watermark unchanged', async () => {
    const sourceId = 'upd-page';
    const before = await readPagedSourceMutationWatermark(engine, sourceId);
    await expect(engine.transaction(async (tx) => {
      await tx.executeRaw(
        `UPDATE pages SET compiled_truth = 'should roll back' WHERE source_id = $1`,
        [sourceId],
      );
      throw new Error('rollback watermark write');
    })).rejects.toThrow(/rollback watermark write/);
    const after = await readPagedSourceMutationWatermark(engine, sourceId);
    expect(after).toBe(before);
  });

  test('deleting a non-maximal in-scope link moves the watermark and refuses resume', async () => {
    const sourceId = 'del-link';
    await engine.executeRaw(
      `INSERT INTO sources (id, name, archived) VALUES ('del-link', 'del-link', false)
       ON CONFLICT (id) DO UPDATE SET archived = false, name = 'del-link'`,
    );
    await engine.putPage('topics/del-a', { title: 'A', compiled_truth: 'a', type: 'note' }, { sourceId });
    await engine.putPage('topics/del-b', { title: 'B', compiled_truth: 'b', type: 'note' }, { sourceId });
    await engine.putPage('topics/del-c', { title: 'C', compiled_truth: 'c', type: 'note' }, { sourceId });
    await engine.putPage('topics/del-d', { title: 'D', compiled_truth: 'd', type: 'note' }, { sourceId });
    await engine.addLink(
      'topics/del-a', 'topics/del-b', 'older', 'related_to', 'manual',
      undefined, undefined, { fromSourceId: sourceId, toSourceId: sourceId },
    );
    await engine.addLink(
      'topics/del-c', 'topics/del-d', 'newer', 'related_to', 'manual',
      undefined, undefined, { fromSourceId: sourceId, toSourceId: sourceId },
    );
    const pages = await engine.executeRaw<{ id: number | string }>(
      `SELECT id FROM pages WHERE source_id = $1 ORDER BY id`,
      [sourceId],
    );
    const cursor = Number(pages[0]!.id);
    const links = await engine.executeRaw<{
      xmin: number | string;
      from_slug: string;
      to_slug: string;
    }>(
      `SELECT l.xmin::text::bigint AS xmin, fp.slug AS from_slug, tp.slug AS to_slug
         FROM links l
         JOIN pages fp ON fp.id = l.from_page_id
         JOIN pages tp ON tp.id = l.to_page_id
        WHERE fp.source_id = $1
        ORDER BY l.xmin::text::bigint ASC, l.id ASC`,
      [sourceId],
    );
    expect(links.length).toBe(2);
    const before = await readPagedSourceMutationWatermark(engine, sourceId);
    const linkMaxSql = `SELECT COALESCE(max(l.xmin::text::bigint), 0) AS mx
      FROM links l
      WHERE EXISTS (SELECT 1 FROM pages fp WHERE fp.id = l.from_page_id AND fp.source_id = $1)
         OR EXISTS (SELECT 1 FROM pages tp WHERE tp.id = l.to_page_id AND tp.source_id = $1)`;
    const maxBefore = await scopedMax(linkMaxSql, sourceId);
    writeStalePrefixCheckpoint(join(dir, 'del-link.json'), sourceId, cursor, before);

    const victim = links[0]!;
    const removed = await engine.removeLink(
      victim.from_slug, victim.to_slug, 'related_to', 'manual',
      { fromSourceId: sourceId, toSourceId: sourceId },
    );
    expect(removed).toBe(1);
    const maxAfter = await scopedMax(linkMaxSql, sourceId);
    expect(maxAfter).toBe(maxBefore);
    const after = await readPagedSourceMutationWatermark(engine, sourceId);
    expect(mutationGeneration(after)).toBeGreaterThan(mutationGeneration(before));

    await expect(runPagedMeasure(engine, {
      sourceId,
      cursor,
      limit: 10,
      checkpointPath: join(dir, 'del-link.json'),
    })).rejects.toThrow(/Corpus mutated during paged measure for source del-link/);
  });

  test('deleting a non-maximal page moves the watermark and refuses resume', async () => {
    const sourceId = 'del-page';
    await engine.executeRaw(
      `INSERT INTO sources (id, name, archived) VALUES ('del-page', 'del-page', false)
       ON CONFLICT (id) DO UPDATE SET archived = false, name = 'del-page'`,
    );
    await engine.putPage('topics/del-page-old', {
      title: 'Old', compiled_truth: 'old page', type: 'note',
    }, { sourceId });
    await engine.putPage('topics/del-page-new', {
      title: 'New', compiled_truth: 'new page', type: 'note',
    }, { sourceId });
    const pages = await engine.executeRaw<{ id: number | string; xmin: number | string }>(
      `SELECT id, xmin::text::bigint AS xmin FROM pages WHERE source_id = $1 ORDER BY xmin::text::bigint ASC, id ASC`,
      [sourceId],
    );
    expect(pages.length).toBe(2);
    const older = pages[0]!;
    const before = await readPagedSourceMutationWatermark(engine, sourceId);
    const pageMaxSql = `SELECT COALESCE(max(p.xmin::text::bigint), 0) AS mx FROM pages p WHERE p.source_id = $1`;
    const maxBefore = await scopedMax(pageMaxSql, sourceId);
    const survivor = pages[1]!;
    writeStalePrefixCheckpoint(join(dir, 'del-page.json'), sourceId, Number(survivor.id), before);

    await engine.executeRaw(`DELETE FROM pages WHERE id = $1`, [Number(older.id)]);
    const maxAfter = await scopedMax(pageMaxSql, sourceId);
    expect(maxAfter).toBe(maxBefore);
    const after = await readPagedSourceMutationWatermark(engine, sourceId);
    expect(mutationGeneration(after)).toBeGreaterThan(mutationGeneration(before));

    await expect(runPagedMeasure(engine, {
      sourceId,
      cursor: Number(survivor.id),
      limit: 10,
      checkpointPath: join(dir, 'del-page.json'),
    })).rejects.toThrow(/Corpus mutated during paged measure for source del-page/);
  });

  test('deleting a non-maximal chunk moves the watermark and refuses resume', async () => {
    const sourceId = 'del-chunk';
    await engine.executeRaw(
      `INSERT INTO sources (id, name, archived) VALUES ('del-chunk', 'del-chunk', false)
       ON CONFLICT (id) DO UPDATE SET archived = false, name = 'del-chunk'`,
    );
    await engine.putPage('topics/del-chunk-page', {
      title: 'Chunked', compiled_truth: 'chunked', type: 'note',
    }, { sourceId });
    await engine.upsertChunks('topics/del-chunk-page', [
      { chunk_index: 0, chunk_text: 'older chunk', chunk_source: 'compiled_truth' },
      { chunk_index: 1, chunk_text: 'newer chunk', chunk_source: 'compiled_truth' },
    ], { sourceId });
    const chunks = await engine.executeRaw<{ id: number | string }>(
      `SELECT c.id
         FROM content_chunks c
         JOIN pages p ON p.id = c.page_id
        WHERE p.source_id = $1
        ORDER BY c.xmin::text::bigint ASC, c.id ASC`,
      [sourceId],
    );
    expect(chunks.length).toBe(2);
    const pages = await engine.executeRaw<{ id: number | string }>(
      `SELECT id FROM pages WHERE source_id = $1`,
      [sourceId],
    );
    const cursor = Number(pages[0]!.id);
    const before = await readPagedSourceMutationWatermark(engine, sourceId);
    const chunkMaxSql = `SELECT COALESCE(max(c.xmin::text::bigint), 0) AS mx
      FROM content_chunks c
      JOIN pages p ON p.id = c.page_id
      WHERE p.source_id = $1`;
    const maxBefore = await scopedMax(chunkMaxSql, sourceId);
    writeStalePrefixCheckpoint(join(dir, 'del-chunk.json'), sourceId, cursor, before);

    await engine.executeRaw(`DELETE FROM content_chunks WHERE id = $1`, [Number(chunks[0]!.id)]);
    const maxAfter = await scopedMax(chunkMaxSql, sourceId);
    expect(maxAfter).toBe(maxBefore);
    const after = await readPagedSourceMutationWatermark(engine, sourceId);
    expect(mutationGeneration(after)).toBeGreaterThan(mutationGeneration(before));

    await expect(runPagedMeasure(engine, {
      sourceId,
      cursor,
      limit: 10,
      checkpointPath: join(dir, 'del-chunk.json'),
    })).rejects.toThrow(/Corpus mutated during paged measure for source del-chunk/);
  });

  test('link churn outside the source leaves the watermark unchanged', async () => {
    const sourceId = 'scoped-quiet';
    await engine.executeRaw(
      `INSERT INTO sources (id, name, archived) VALUES
         ('scoped-quiet', 'scoped-quiet', false),
         ('scoped-other', 'scoped-other', false)
       ON CONFLICT (id) DO UPDATE SET archived = false, name = EXCLUDED.name`,
    );
    await engine.putPage('topics/quiet-a', {
      title: 'Quiet A', compiled_truth: 'quiet a', type: 'note',
    }, { sourceId });
    await engine.putPage('topics/quiet-b', {
      title: 'Quiet B', compiled_truth: 'quiet b', type: 'note',
    }, { sourceId });
    await engine.putPage('topics/other-a', {
      title: 'Other A', compiled_truth: 'other a', type: 'note',
    }, { sourceId: 'scoped-other' });
    await engine.putPage('topics/other-b', {
      title: 'Other B', compiled_truth: 'other b', type: 'note',
    }, { sourceId: 'scoped-other' });
    const before = await readPagedSourceMutationWatermark(engine, sourceId);
    await engine.addLink(
      'topics/other-a', 'topics/other-b', 'outside', 'related_to', 'manual',
      undefined, undefined,
      { fromSourceId: 'scoped-other', toSourceId: 'scoped-other' },
    );
    expect(await readPagedSourceMutationWatermark(engine, sourceId)).toBe(before);
    const removed = await engine.removeLink(
      'topics/other-a', 'topics/other-b', 'related_to', 'manual',
      { fromSourceId: 'scoped-other', toSourceId: 'scoped-other' },
    );
    expect(removed).toBe(1);
    expect(await readPagedSourceMutationWatermark(engine, sourceId)).toBe(before);
    const otherAfter = await readPagedSourceMutationWatermark(engine, 'scoped-other');
    expect(mutationGeneration(otherAfter)).toBeGreaterThan(0n);

    const ids = await engine.executeRaw<{ id: number | string }>(
      `SELECT id FROM pages WHERE source_id = $1 ORDER BY id`,
      [sourceId],
    );
    const report = await runPagedMeasure(engine, {
      sourceId,
      cursor: 0,
      limit: 1,
      checkpointPath: join(dir, 'scoped-quiet.json'),
    });
    expect(report.active_pages).toBe(2);
    expect(report.owned_link_rows).toBe(0);
    const saved = JSON.parse(readFileSync(join(dir, 'scoped-quiet.json'), 'utf8')) as {
      mutation_watermark: string;
      cursor: number;
    };
    expect(saved.mutation_watermark).toBe(before);
    expect(saved.cursor).toBe(Number(ids[1]!.id));
  });

  test('per-batch watermark checks do not aggregate the corpus', async () => {
    const sourceId = 'batch-cost';
    await engine.executeRaw(
      `INSERT INTO sources (id, name, archived) VALUES ('batch-cost', 'batch-cost', false)
       ON CONFLICT (id) DO UPDATE SET archived = false, name = 'batch-cost'`,
    );
    await engine.putPage('topics/batch-a', {
      title: 'Batch A', compiled_truth: 'batch a', type: 'note',
    }, { sourceId });
    await engine.putPage('topics/batch-b', {
      title: 'Batch B', compiled_truth: 'batch b', type: 'note',
    }, { sourceId });
    await engine.putPage('topics/batch-c', {
      title: 'Batch C', compiled_truth: 'batch c', type: 'note',
    }, { sourceId });
    let corpusScans = 0;
    const executeRaw: BrainEngine['executeRaw'] = async (sql, params, opts) => {
      if (typeof sql === 'string' && /xmin|links_id_seq|count\s*\(|pg_sequences/i.test(sql)) {
        corpusScans += 1;
      }
      return engine.executeRaw(sql, params, opts);
    };
    const hooked = new Proxy(engine, {
      get(target, prop, receiver) {
        if (prop === 'executeRaw') return executeRaw;
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const report = await runPagedMeasure(hooked, {
      sourceId,
      cursor: 0,
      limit: 1,
      checkpointPath: join(dir, 'batch-cost.json'),
    });
    expect(report.active_pages).toBe(3);
    expect(corpusScans).toBe(0);
  });

  test('archiving the source moves the watermark and a name change does not', async () => {
    const sourceId = 'arch-wm';
    await engine.executeRaw(
      `INSERT INTO sources (id, name, archived) VALUES ('arch-wm', 'arch-wm', false)
       ON CONFLICT (id) DO UPDATE SET archived = false, name = 'arch-wm'`,
    );
    await engine.putPage('topics/arch-wm', {
      title: 'Arch', compiled_truth: 'arch body', type: 'note',
    }, { sourceId });
    const before = await readPagedSourceMutationWatermark(engine, sourceId);
    await engine.executeRaw(`UPDATE sources SET name = 'arch-wm-renamed' WHERE id = $1`, [sourceId]);
    expect(await readPagedSourceMutationWatermark(engine, sourceId)).toBe(before);
    await engine.executeRaw(`UPDATE sources SET archived = true WHERE id = $1`, [sourceId]);
    const after = await readPagedSourceMutationWatermark(engine, sourceId);
    expect(mutationGeneration(after)).toBeGreaterThan(mutationGeneration(before));
  });
});

describe('paged multi-source revalidation', () => {
  let engine: BrainEngine;
  let dir: string;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    dir = mkdtempSync(join(tmpdir(), 'gbrain-paged-reval-'));
    await engine.executeRaw(
      `INSERT INTO sources (id, name, archived) VALUES
         ('reval-a', 'reval-a', false),
         ('reval-b', 'reval-b', false)
       ON CONFLICT (id) DO UPDATE SET archived = false, name = EXCLUDED.name`,
    );
    await engine.putPage('topics/reval-a-page', {
      title: 'A', compiled_truth: 'a before', type: 'note',
    }, { sourceId: 'reval-a' });
    await engine.putPage('topics/reval-b-page', {
      title: 'B', compiled_truth: 'b before', type: 'note',
    }, { sourceId: 'reval-b' });
  });

  afterAll(async () => {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  test('refuses the combined fingerprint when an earlier source changes during a later walk', async () => {
    const raw = relationManifest([{
      id: 'reval-a-b',
      from_slug: 'topics/reval-a-page',
      to_slug: 'topics/reval-b-page',
      from_source_id: 'reval-a',
      to_source_id: 'reval-b',
      link_type: 'related_to',
      link_source: 'tana-relation-r2',
      guards: TRUE_GUARDS,
    }]);
    const manifest = parseRelationManifest(raw);
    let mutated = false;
    const executeRaw: BrainEngine['executeRaw'] = async (sql, params, opts) => {
      // Source ids are sorted, so reval-b's page scan starts only after
      // reval-a has finished and stored its watermark.
      if (
        !mutated
        && typeof sql === 'string'
        && sql.includes('id > $2')
        && params?.[0] === 'reval-b'
      ) {
        mutated = true;
        await engine.putPage('topics/reval-a-page', {
          title: 'A', compiled_truth: 'changed while b scans', type: 'note',
        }, { sourceId: 'reval-a' });
      }
      return engine.executeRaw(sql, params, opts);
    };
    const hooked = new Proxy(engine, {
      get(target, prop, receiver) {
        if (prop === 'executeRaw') return executeRaw;
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    await expect(applyRelationManifest(hooked, manifest, raw, {
      apply: false,
      defaultSourceId: 'reval-a',
      pageScan: {
        sourceId: 'reval-a',
        cursor: 0,
        limit: 10,
        checkpointPath: join(dir, 'reval-checkpoint.json'),
      },
    })).rejects.toThrow(/Corpus mutated during paged measure for source reval-a/);
    expect(mutated).toBe(true);
  });
});
