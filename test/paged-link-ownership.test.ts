import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { applyRelationManifest, parseRelationManifest } from '../src/core/graph-usefulness/relation-manifest.ts';
import { runPagedMeasure } from '../src/core/graph-usefulness/paged-runner.ts';

describe('paged deterministic link ownership', () => {
  let engine: PGLiteEngine;
  let dir: string;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    dir = mkdtempSync(join(tmpdir(), 'gbrain-link-owner-'));
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES('owner-a','A'),('owner-b','B'),('owner-c','C')");
    // Outside and cross-source neighbors deliberately have lower IDs than A.
    for (const [source, slug] of [['owner-c','notes/c'],['owner-b','notes/b'],['owner-a','notes/a1'],['owner-a','notes/a2']]) {
      await engine.putPage(slug!, { type: 'note', title: 'Synthetic page', compiled_truth: 'Synthetic content' }, { sourceId: source! });
    }
    const rows = await engine.executeRaw<{ id: number; slug: string }>('SELECT id,slug FROM pages');
    const ids = new Map(rows.map(row => [row.slug, Number(row.id)]));
    for (const [from, to, type] of [
      ['notes/a1','notes/a2','related_to'], ['notes/a1','notes/a2','mentions'],
      ['notes/a1','notes/a1','related_to'], ['notes/a2','notes/b','related_to'],
      ['notes/b','notes/a1','related_to'], ['notes/c','notes/a2','related_to'],
    ]) {
      await engine.executeRaw('INSERT INTO links(from_page_id,to_page_id,link_type,link_source) VALUES($1,$2,$3,\'manual\')', [ids.get(from!),ids.get(to!),type]);
    }
  });
  afterAll(async () => { await engine.disconnect(); rmSync(dir, { recursive: true, force: true }); });
  const scan = (sourceId: string, name: string, limit = 1, unionSourceIds?: string[], target: BrainEngine = engine) =>
    runPagedMeasure(target, { sourceId, cursor: 0, limit, checkpointPath: join(dir, name), unionSourceIds });

  test('split endpoint batches preserve self and parallel edge counts, degrees and fingerprint', async () => {
    const small = await scan('owner-a','small');
    const large = await scan('owner-a','large',20);
    expect(small).toEqual(large);
    expect(small.link_rows).toBe(6);
    expect(small.valid_links).toBe(6);
    expect(small.avg_degree).toBe(4);
    expect(small.median_degree).toBe(4);
    expect(small.zero_degree_pages).toBe(0);
    expect(small.owned_link_rows).toBe(6);
    const checkpoint = JSON.parse(readFileSync(join(dir,'small'),'utf8'));
    expect(checkpoint).not.toHaveProperty('seen_link_ids');
    expect(small).not.toHaveProperty('seen_link_ids');
    expect(checkpoint.owned_link_rows).toBe(6);
  });

  test('selected-source scalar union includes external edges and deduplicates both directions', async () => {
    const a = await scan('owner-a','union-ab-a',1,['owner-b','owner-a']);
    const b = await scan('owner-b','union-ab-b',1,['owner-a','owner-b']);
    expect(a.link_rows).toBe(6); expect(b.link_rows).toBe(2);
    expect(a.owned_link_rows).toBe(4); expect(b.owned_link_rows).toBe(2);
    const reports = await Promise.all(['owner-a','owner-b','owner-c'].map(source => scan(source,`union-abc-${source}`,1,['owner-c','owner-a','owner-b'])));
    expect(reports.map(report => report.owned_link_rows)).toEqual([3,2,1]);
    expect(reports.reduce((sum, report) => sum + report.owned_link_rows,0)).toBe(6);
  });

  test('interrupted ownership cursor resumes without link IDs and matches a fresh walk', async () => {
    let reads = 0;
    const hooked = new Proxy(engine, {
      get(target, prop) {
        if (prop === 'executeRaw') return async (sql: string, params?: unknown[]) => {
          if (sql.includes('FROM pages') && sql.includes('id > $2') && ++reads === 2) throw new Error('synthetic interruption');
          return target.executeRaw(sql, params);
        };
        const value = Reflect.get(target,prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(scan('owner-a','resume',1,['owner-a','owner-b'],hooked)).rejects.toThrow('synthetic interruption');
    const partial = JSON.parse(readFileSync(join(dir,'resume'),'utf8'));
    expect(partial.done).toBe(false); expect(partial.active_pages).toBe(1);
    expect(partial).not.toHaveProperty('seen_link_ids');
    await expect(scan('owner-a','resume',1,['owner-a'])).rejects.toThrow('union source scope');
    const resumed = await scan('owner-a','resume',1,['owner-b','owner-a','owner-a']);
    expect(resumed).toEqual(await scan('owner-a','resume-fresh',20,['owner-a','owner-b']));
    expect(await scan('owner-a','resume',1,['owner-a','owner-b'])).toEqual(resumed);
    await expect(scan('owner-a','resume',1,['owner-a','owner-b','owner-c'])).rejects.toThrow('union source scope');
  });

  for (const oldFormat of [4,5]) for (const done of [false,true]) {
    test(`format${oldFormat} ${done ? 'completed' : 'partial'} checkpoint is refused before reuse`, async () => {
      const name = `old-${oldFormat}-${done}`;
      await scan('owner-a',name);
      const checkpoint = JSON.parse(readFileSync(join(dir,name),'utf8'));
      checkpoint.fingerprint_format = oldFormat; checkpoint.done = done;
      writeFileSync(join(dir,name),JSON.stringify(checkpoint));
      await expect(scan('owner-a',name)).rejects.toThrow(`unsupported fingerprint_format ${oldFormat}`);
    });
  }
  test('actual multi-source relation apply combines cross and external incident edges once', async () => {
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES('apply-owner-a','Apply A'),('apply-owner-b','Apply B'),('apply-owner-x','Apply X')");
    for (const [source, slug] of [
      ['apply-owner-x','notes/x'], ['apply-owner-a','notes/a1'], ['apply-owner-b','notes/b1'],
      ['apply-owner-a','notes/a2'], ['apply-owner-a','notes/new-a'], ['apply-owner-b','notes/new-b'],
    ]) await engine.putPage(slug!, { type: 'note', title: 'Synthetic apply page', compiled_truth: 'Synthetic content' }, { sourceId: source! });
    for (const [from, to, fromSourceId, toSourceId] of [
      ['notes/a1','notes/b1','apply-owner-a','apply-owner-b'],
      ['notes/x','notes/a1','apply-owner-x','apply-owner-a'],
      ['notes/a1','notes/a2','apply-owner-a','apply-owner-a'],
    ]) await engine.addLink(from!,to!,'Synthetic context','related_to','manual',undefined,undefined,{ fromSourceId: fromSourceId!,toSourceId: toSourceId! });
    const raw = JSON.stringify({ manifest_version: 1, issue: 'DAV-6220', rows: [{
      id: 'new-owned-edge', from_slug: 'notes/new-a', to_slug: 'notes/new-b',
      from_source_id: 'apply-owner-a', to_source_id: 'apply-owner-b',
      link_type: 'related_to', link_source: 'tana-relation-r2',
      guards: { exact_endpoint_match: true, source_relation_current: true, no_incident_edge: true, readwise_clear: true },
    }] });
    const result = await applyRelationManifest(engine,parseRelationManifest(raw),raw,{
      apply: true, defaultSourceId: 'apply-owner-a', receiptPath: join(dir,'apply-receipt'),
      pageScan: { sourceId: 'apply-owner-a', cursor: 0, limit: 1, checkpointPath: join(dir,'apply-checkpoint') },
    });
    expect(result.applied).toBe(1);
    expect(result.before.link_rows).toBe(3);
    expect(result.before.valid_links).toBe(3);
    expect(result.after.link_rows).toBe(4);
    expect(result.after.valid_links).toBe(4);
    expect(result.after.sha256).not.toBe(result.before.sha256);
  });

});
