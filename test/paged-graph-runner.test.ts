import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { measureGraphUsefulness } from '../src/core/graph-usefulness/measure.ts';
import {
  medianFromHistogram,
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
      seen_link_ids: [],
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
