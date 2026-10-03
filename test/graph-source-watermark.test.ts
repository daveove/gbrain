import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRetrievalProof, _setRetrievalProofSearchForTests } from '../src/core/graph-usefulness/retrieval-proof.ts';
import { GRAPH_RETRIEVAL_CONFIG_KEYS } from '../src/core/graph-usefulness/schema.ts';
import { SEARCH_MODE_KEY, SEARCH_MODE_CONFIG_KEYS } from '../src/core/search/mode.ts';
import { PROOF_SEARCH_RAW_KEYS } from '../src/core/graph-usefulness/search-pin.ts';
import { computeGraphFingerprint } from '../src/core/graph-usefulness/fingerprint.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { sealPageTextProjection } from '../src/core/page-state/projections.ts';
import { readPagedSourceMutationWatermark, runPagedMeasure } from '../src/core/graph-usefulness/paged-runner.ts';

function generation(watermark: string): bigint { return BigInt(watermark.split(':')[1]!); }

describe('incident-source graph watermarks', () => {
  let engine: PGLiteEngine;
  let dir: string;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    dir = mkdtempSync(join(tmpdir(), 'graph-incident-'));
  });
  afterAll(async () => {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  async function pair(prefix: string) {
    const a = `${prefix}-a`, b = `${prefix}-b`, c = `${prefix}-c`;
    for (const source of [a, b, c]) {
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [source]);
      await engine.putPage('notes/endpoint', {
        type: 'note', title: 'Synthetic endpoint', compiled_truth: 'Synthetic graph fixture',
      }, { sourceId: source });
    }
    const rows = await engine.executeRaw<{ id: number; source_id: string }>(
      'SELECT id,source_id FROM pages WHERE source_id=ANY($1::text[])', [[a, b, c]]);
    const id = (source: string) => rows.find(row => row.source_id === source)!.id;
    await engine.executeRaw("INSERT INTO links(from_page_id,to_page_id,link_type,link_source) VALUES($1,$2,'related_to','manual')", [id(a), id(b)]);
    const checkpointPath = join(dir, `${prefix}.json`);
    await runPagedMeasure(engine, { sourceId: a, cursor: 0, limit: 1, checkpointPath });
    return { a, b, c, checkpointPath };
  }

  for (const mutation of ['delete', 'rename', 'move', 'archive', 'restore'] as const) {
    test(`foreign endpoint ${mutation} invalidates a completed neighboring checkpoint`, async () => {
      const p = await pair(`foreign-${mutation}`);
      if (mutation === 'restore') {
        await engine.executeRaw('UPDATE sources SET archived=true WHERE id=$1', [p.b]);
        rmSync(p.checkpointPath);
        await runPagedMeasure(engine, { sourceId: p.a, cursor: 0, limit: 1, checkpointPath: p.checkpointPath });
      }
      const before = await readPagedSourceMutationWatermark(engine, p.a);
      if (mutation === 'delete') await engine.executeRaw('UPDATE pages SET deleted_at=now() WHERE source_id=$1', [p.b]);
      if (mutation === 'rename') await engine.executeRaw("UPDATE pages SET slug='notes/renamed' WHERE source_id=$1", [p.b]);
      if (mutation === 'move') await engine.executeRaw("UPDATE pages SET source_id=$2,slug='notes/moved' WHERE source_id=$1", [p.b, p.c]);
      if (mutation === 'archive') await engine.executeRaw('UPDATE sources SET archived=true WHERE id=$1', [p.b]);
      if (mutation === 'restore') await engine.executeRaw('UPDATE sources SET archived=false WHERE id=$1', [p.b]);
      expect(generation(await readPagedSourceMutationWatermark(engine, p.a))).toBeGreaterThan(generation(before));
      await expect(runPagedMeasure(engine, { sourceId: p.a, cursor: 0, limit: 1, checkpointPath: p.checkpointPath })).rejects.toThrow(/Corpus mutated/);
    });
  }

  test('foreign content and unrelated endpoints leave the neighboring checkpoint valid', async () => {
    const p = await pair('irrelevant');
    const before = await readPagedSourceMutationWatermark(engine, p.a);
    await engine.executeRaw("UPDATE pages SET compiled_truth='Synthetic revised content' WHERE source_id=$1", [p.b]);
    await engine.executeRaw('UPDATE pages SET deleted_at=now() WHERE source_id=$1', [p.c]);
    await engine.executeRaw('UPDATE sources SET archived=true WHERE id=$1', [p.c]);
    expect(await readPagedSourceMutationWatermark(engine, p.a)).toBe(before);
    await runPagedMeasure(engine, { sourceId: p.a, cursor: 0, limit: 1, checkpointPath: p.checkpointPath });
  });

  test('a transaction coalesces all pending changes before advancing each source once', async () => {
    const p = await pair('coalesced');
    const beforeA = generation(await readPagedSourceMutationWatermark(engine, p.a));
    const beforeB = generation(await readPagedSourceMutationWatermark(engine, p.b));
    await engine.transaction(async tx => {
      for (const source of [p.b, p.a, p.b]) {
        await tx.executeRaw("UPDATE pages SET compiled_truth=compiled_truth || ' change' WHERE source_id=$1", [source]);
      }
    });
    expect(generation(await readPagedSourceMutationWatermark(engine, p.a))).toBe(beforeA + 1n);
    expect(generation(await readPagedSourceMutationWatermark(engine, p.b))).toBe(beforeB + 1n);
    expect(await engine.executeRaw('SELECT id FROM source_mutation_pending')).toHaveLength(0);
  });

  test('type-only page updates advance the source mutation watermark', async () => {
    const p = await pair('type-only');
    const before = await readPagedSourceMutationWatermark(engine, p.a);
    await engine.executeRaw("UPDATE pages SET type='concept' WHERE source_id=$1", [p.a]);
    expect(generation(await readPagedSourceMutationWatermark(engine, p.a))).toBeGreaterThan(generation(before));
    await expect(runPagedMeasure(engine, { sourceId: p.a, cursor: 0, limit: 1, checkpointPath: p.checkpointPath })).rejects.toThrow(/Corpus mutated/);
  });

  test('semantic revision changes invalidate a completed checkpoint without changing page cardinality', async () => {
    const p = await pair('semantic-revision');
    const [before] = await engine.executeRaw<{ knowledge_revision: string }>('SELECT knowledge_revision FROM pages WHERE source_id=$1', [p.a]);
    await engine.executeRaw("UPDATE pages SET title='Synthetic semantic revision' WHERE source_id=$1", [p.a]);
    const [after] = await engine.executeRaw<{ knowledge_revision: string }>('SELECT knowledge_revision FROM pages WHERE source_id=$1', [p.a]);
    expect(after!.knowledge_revision).not.toBe(before!.knowledge_revision);
    await expect(runPagedMeasure(engine, { sourceId: p.a, cursor: 0, limit: 1, checkpointPath: p.checkpointPath })).rejects.toThrow(/Corpus mutated/);
  });

  test('type-only ABA advances committed epochs and refuses a proof after the type is restored', async () => {
    const p = await pair('type-only-aba');
    const snapshot = async () => (await engine.executeRaw<{ type: string; title: string; knowledge_revision: string }>(
      'SELECT type,title,knowledge_revision FROM pages WHERE source_id=$1', [p.a]))[0]!;
    const before = await snapshot();
    const epoch = generation(await readPagedSourceMutationWatermark(engine, p.a));
    const typeABA = async () => {
      await engine.executeRaw("UPDATE pages SET type='event' WHERE source_id=$1", [p.a]);
      await engine.executeRaw("UPDATE pages SET type='note' WHERE source_id=$1", [p.a]);
    };
    await typeABA();
    const after = await snapshot();
    expect(after.type).toBe(before.type);
    expect(after.title).toBe(before.title);
    expect(after.knowledge_revision).not.toBe(before.knowledge_revision);
    expect(generation(await readPagedSourceMutationWatermark(engine, p.a))).toBe(epoch + 2n);
    await expect(runPagedMeasure(engine, { sourceId: p.a, cursor: 0, limit: 1, checkpointPath: p.checkpointPath })).rejects.toThrow(/Corpus mutated/);
    await sealPageTextProjection(engine, 'notes/endpoint', p.a);
    _setRetrievalProofSearchForTests(async () => {
      await typeABA();
      return [{ source_id: p.a, slug: 'notes/endpoint' }];
    });
    try {
      const result = await runRetrievalProof(engine, { proof_version: 2, questions: [{
        id: 'type-only-aba', query: 'Synthetic endpoint', relevant_pages: [{ source_id: p.a, slug: 'notes/endpoint' }],
      }] }, { sourceId: p.a });
      expect(result.checks.production_mutations).toBeGreaterThan(0);
      expect(result.passed).toBe(false);
    } finally { _setRetrievalProofSearchForTests(null); }
  });

  test('materialization preserves semantic revision while changed projected content invalidates graph receipt', async () => {
    const p = await pair('projection-revision');
    const [before] = await engine.executeRaw<{ knowledge_revision: string }>('SELECT knowledge_revision FROM pages WHERE source_id=$1', [p.a]);
    await engine.transaction(async tx => {
      await tx.executeRaw("SELECT set_config('gbrain.materializing_revision',$1,true)", [before!.knowledge_revision]);
      await tx.executeRaw("UPDATE pages SET compiled_truth='Synthetic materialized projection' WHERE source_id=$1", [p.a]);
    });
    const [after] = await engine.executeRaw<{ knowledge_revision: string }>('SELECT knowledge_revision FROM pages WHERE source_id=$1', [p.a]);
    expect(after!.knowledge_revision).toBe(before!.knowledge_revision);
    await expect(runPagedMeasure(engine, { sourceId: p.a, cursor: 0, limit: 1, checkpointPath: p.checkpointPath })).rejects.toThrow(/Corpus mutated/);
  });

  test('deleted or recreated empty source cannot reuse completed generation-zero receipt', async () => {
    const sourceId = 'recreated-empty';
    const checkpointPath = join(dir, 'recreated-empty.json');
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    const before = await readPagedSourceMutationWatermark(engine, sourceId);
    await runPagedMeasure(engine, { sourceId, cursor: 0, limit: 1, checkpointPath });
    await engine.executeRaw('DELETE FROM sources WHERE id=$1', [sourceId]);
    await expect(readPagedSourceMutationWatermark(engine, sourceId)).rejects.toThrow(/no row/);
    await engine.executeRaw('DELETE FROM source_mutation_generation WHERE source_id=$1', [sourceId]);
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    const after = await readPagedSourceMutationWatermark(engine, sourceId);
    expect(generation(after)).toBe(generation(before));
    expect(after).not.toBe(before);
    await expect(runPagedMeasure(engine, { sourceId, cursor: 0, limit: 1, checkpointPath })).rejects.toThrow(/Corpus mutated/);
  });


  test('in-place foreign source incarnation change invalidates own and neighboring completed checkpoints', async () => {
    const a = 'incarnation-neighbor', b = 'incarnation-endpoint';
    for (const source of [a, b]) {
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [source]);
      // Seal the raw fixture so pending projection jobs release the old incarnation.
      await engine.executeRaw("INSERT INTO pages(source_id,slug,type,title,compiled_truth) VALUES($1,'notes/endpoint','note','Synthetic endpoint','Synthetic graph content')", [source]);
      await sealPageTextProjection(engine, 'notes/endpoint', source);
    }
    await engine.executeRaw(`INSERT INTO links(from_page_id,to_page_id,link_type,link_source)
      SELECT a.id,b.id,'related_to','manual' FROM pages a,pages b WHERE a.source_id=$1 AND b.source_id=$2`, [a, b]);
    const paths = [join(dir, 'incarnation-neighbor.json'), join(dir, 'incarnation-endpoint.json')];
    for (const [i, sourceId] of [a, b].entries()) {
      await runPagedMeasure(engine, { sourceId, cursor: 0, limit: 1, checkpointPath: paths[i]! });
    }
    const beforeFederated = await computeGraphFingerprint(engine, { sourceIds: [a, b] });
    const beforeOwn = await computeGraphFingerprint(engine, { sourceId: b });
    await engine.executeRaw('UPDATE sources SET incarnation=gen_random_uuid() WHERE id=$1', [b]);
    expect((await computeGraphFingerprint(engine, { sourceIds: [a, b] })).sha256).not.toBe(beforeFederated.sha256);
    expect((await computeGraphFingerprint(engine, { sourceId: b })).sha256).not.toBe(beforeOwn.sha256);
    for (const [i, sourceId] of [a, b].entries()) {
      await expect(runPagedMeasure(engine, { sourceId, cursor: 0, limit: 1, checkpointPath: paths[i]! })).rejects.toThrow(/Corpus mutated/);
    }
  });


  test('origin-only rename and incarnation ABA invalidate both endpoint generations', async () => {
    const sources = ['origin-from', 'origin-to', 'origin-owner'];
    for (const source of sources) {
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [source]);
      await engine.executeRaw("INSERT INTO pages(source_id,slug,type,title,compiled_truth) VALUES($1,'notes/endpoint','note','Synthetic endpoint','Synthetic content')", [source]);
      await sealPageTextProjection(engine, 'notes/endpoint', source);
    }
    await engine.executeRaw(`INSERT INTO links(from_page_id,to_page_id,origin_page_id,link_type,link_source)
      SELECT a.id,b.id,o.id,'related_to','manual' FROM pages a,pages b,pages o
      WHERE a.source_id=$1 AND b.source_id=$2 AND o.source_id=$3`, sources);
    const paths = sources.slice(0,2).map(source => join(dir, source+'.json'));
    for (const [i, sourceId] of sources.slice(0,2).entries()) await runPagedMeasure(engine, { sourceId, cursor: 0, limit: 1, checkpointPath: paths[i]! });
    const originId = (await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [sources[2]]))[0]!.incarnation;
    const before = await computeGraphFingerprint(engine, { sourceId: sources[1] });
    await engine.executeRaw("UPDATE pages SET slug='notes/origin-renamed' WHERE source_id=$1", [sources[2]]);
    expect((await computeGraphFingerprint(engine, { sourceId: sources[1] })).sha256).not.toBe(before.sha256);
    await engine.executeRaw("UPDATE pages SET slug='notes/endpoint' WHERE source_id=$1", [sources[2]]);
    for (const [i, sourceId] of sources.slice(0,2).entries()) await expect(runPagedMeasure(engine, { sourceId, cursor: 0, limit: 1, checkpointPath: paths[i]! })).rejects.toThrow(/Corpus mutated/);
    await sealPageTextProjection(engine, 'notes/endpoint', sources[2]!);
    _setRetrievalProofSearchForTests(async () => {
      await engine.executeRaw('UPDATE sources SET incarnation=gen_random_uuid() WHERE id=$1', [sources[2]]);
      await engine.executeRaw('UPDATE sources SET incarnation=$1 WHERE id=$2', [originId, sources[2]]);
      return [{ source_id: sources[0], slug: 'notes/endpoint' }];
    });
    try {
      const result = await runRetrievalProof(engine, { proof_version: 2, questions: [{ id: 'origin-aba', query: 'Synthetic endpoint', relevant_pages: [{ source_id: sources[0]!, slug: 'notes/endpoint' }] }] }, { sourceId: sources[0] });
      expect(result.fingerprint_before.sha256).toBe(result.fingerprint_after.sha256);
      expect(result.checks.production_mutations).toBeGreaterThan(0);
      expect(result.passed).toBe(false);
    } finally { _setRetrievalProofSearchForTests(null); }
  });

  test('search-config mutation allowlist matches the public mode and proof snapshot APIs', () => {
    expect([...GRAPH_RETRIEVAL_CONFIG_KEYS] as string[]).toEqual([...new Set([
      SEARCH_MODE_KEY, ...SEARCH_MODE_CONFIG_KEYS, ...PROOF_SEARCH_RAW_KEYS,
      'embedding_columns', 'search_embedding_column',
    ])].sort());
  });

  test('global config coalesces separately from a real source named config and rolls back atomically', async () => {
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES('config','Synthetic config source')");
    const sourceBefore = await readPagedSourceMutationWatermark(engine, 'config');
    const global = async () => BigInt((await engine.executeRaw<{ generation: string }>('SELECT generation::text FROM graph_search_mutation_generation WHERE singleton=1'))[0]!.generation);
    const before = await global();
    await engine.transaction(async tx => {
      await tx.executeRaw("INSERT INTO config(key,value) VALUES('search.mode','balanced') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
      await tx.executeRaw("UPDATE config SET value='conservative' WHERE key='search.mode'");
    });
    expect(await global()).toBe(before+1n);
    expect(await readPagedSourceMutationWatermark(engine, 'config')).toBe(sourceBefore);
    const committed = await global();
    await expect(engine.transaction(async tx => {
      await tx.executeRaw("UPDATE config SET value='tokenmax' WHERE key='search.mode'");
      await tx.executeRaw("INSERT INTO page_aliases(source_id,alias_norm,slug) VALUES('config','Synthetic alias','notes/target')");
      throw new Error('synthetic rollback');
    })).rejects.toThrow('synthetic rollback');
    expect(await global()).toBe(committed);
    expect(await readPagedSourceMutationWatermark(engine, 'config')).toBe(sourceBefore);
    expect(await engine.executeRaw('SELECT id FROM source_mutation_pending')).toHaveLength(0);
  });

});
