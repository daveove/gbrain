import { describe, expect, test } from 'bun:test';
import {
  buildDuplicateEvidenceManifest,
  buildDuplicateEvidenceManifestAsync,
  candidateHash,
  normalizeDuplicateTitle,
  snapshotHash,
  validateDuplicateAuditHandoff,
  type DuplicateEvidencePage,
} from '../src/core/duplicate-evidence.ts';
import { loadLivePages, runDuplicates } from '../src/commands/duplicates.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const service2025: DuplicateEvidencePage = {
  id: 1,
  source_id: 'source-b',
  slug: 'notes/example-revision-b',
  title: 'Synthetic service design note',
  content_hash: 'new-service',
  compiled_truth: 'Synthetic customer research. Collect sample observations. Review example service options.',
  effective_date: '2025-01-01T00:00:00.000Z',
};

const service2024: DuplicateEvidencePage = {
  ...service2025,
  id: 2,
  source_id: 'source-a',
  slug: 'notes/example-revision-a',
  content_hash: 'old-service',
};

describe('duplicate evidence', () => {
  test('counts inherited object property names as ordinary source identities', () => {
    const sources = ['constructor','__proto__','toString'];
    const result = buildDuplicateEvidenceManifest(sources.map((source_id,id) => ({ ...service2025,id:id+1,source_id })));
    const roundTrip = JSON.parse(JSON.stringify(result));
    for (const source of sources) expect(roundTrip.source_counts[source]).toBe(1);
    expect(Object.values(roundTrip.source_counts).reduce((a,b) => Number(a)+Number(b),0)).toBe(3);
  });

  test('ordering and normalization do not depend on locale-sensitive string methods', () => {
    const compare = String.prototype.localeCompare;
    const lower = String.prototype.toLocaleLowerCase;
    String.prototype.localeCompare = () => { throw new Error('locale-dependent ordering'); };
    String.prototype.toLocaleLowerCase = () => { throw new Error('locale-dependent casing'); };
    try {
      const pages = [{ ...service2025,source_id:'z',title:'İstanbul Éxample' },{ ...service2024,source_id:'ä',title:'istanbul example' }];
      expect(buildDuplicateEvidenceManifest(pages)).toEqual(buildDuplicateEvidenceManifest([...pages].reverse()));
      expect(normalizeDuplicateTitle(pages[0].title)).toBe('istanbul example');
    } finally { String.prototype.localeCompare=compare; String.prototype.toLocaleLowerCase=lower; }
  });

  test('preprocessing yields to cancellation before reading every body', async () => {
    let reads = 0;
    const pages = Array.from({length:10000},(_,id) => ({ ...service2025,id,slug:`page-${id}`,get compiled_truth(){ reads++; return 'synthetic'; } }));
    const controller = new AbortController();
    setImmediate(() => controller.abort());
    await expect(buildDuplicateEvidenceManifestAsync(pages,controller.signal)).rejects.toThrow();
    expect(reads).toBeLessThan(10000);
  });

  test('identity substitutions fail with an otherwise valid recomputed candidate hash', () => {
    const pages=[service2025,service2024]; const manifest=buildDuplicateEvidenceManifest(pages); const cluster=manifest.clusters[0];
    const row=cluster.pages.find((page)=>page.page_id!==cluster.canonical_display.page_id)!;
    const candidate={ ...row,cluster_id:cluster.cluster_id,approved:true };
    const handoff={ schema_version:2,input_snapshot_hash:manifest.input_snapshot_hash,evidence_manifest_hash:manifest.manifest_hash,approved_by:'reviewer-example',candidates:[candidate],candidate_hash:candidateHash([candidate]) };
    expect(validateDuplicateAuditHandoff(handoff,pages).ok).toBe(true);
    for (const patch of [{source_id:'another-source'},{page_id:999},{slug:'another-slug'},{content_digest:'0'.repeat(64)},{content_hash:'substituted'}]) {
      const candidates=[{...candidate,...patch}]; const result=validateDuplicateAuditHandoff({...handoff,candidates,candidate_hash:candidateHash(candidates)},pages);
      expect(result.ok).toBe(false);
      expect(result.errors.some((error)=>error.includes('candidate_hash does not match'))).toBe(false);
    }
  });

  test('per-source reconciliation rejects swapped counts even when totals agree',async () => {
    const engine={transaction:async(fn:(tx:unknown)=>unknown)=>fn({executeRaw:async(query:string)=>{
      if(query.startsWith('SELECT id,'))return [service2025,service2024];
      if(query.startsWith('SELECT source_id, count'))return [{source_id:service2025.source_id,count:2}];
      return [];
    }})} as unknown as BrainEngine;
    await expect(loadLivePages(engine)).rejects.toThrow('per-source count reconciliation');
  });
  test('normalizes encoded and punctuated titles without treating their slug as evidence', () => {
    expect(normalizeDuplicateTitle('Example Updates - 01/01/2025')).toBe('example updates 01 01 2025');
    expect(normalizeDuplicateTitle('https%3A%2F%2Fexample.com%2F2025%2F01')).toBe('https example com 2025 01');
  });

  test('forms a cross-source duplicate cluster for meaningful same-title notes', () => {
    const manifest = buildDuplicateEvidenceManifest([service2025, service2024]);
    expect(manifest.pages_scanned).toBe(2);
    expect(manifest.clusters).toHaveLength(1);
    expect(manifest.clusters[0].confidence).toBe('high');
    expect(manifest.clusters[0].canonical_display.page_id).toBe(2);
    expect(manifest.clusters[0].pages.map((page) => page.source_id)).toEqual([
      'source-a',
      'source-b',
    ]);
  });

  test('uses computed body digests as high-confidence equality evidence', () => {
    const manifest = buildDuplicateEvidenceManifest([
      { ...service2025, content_hash: 'same-content', compiled_truth: 'same' },
      { ...service2024, content_hash: 'same-content', compiled_truth: 'same' },
    ]);
    expect(manifest.clusters[0].confidence).toBe('high');
    expect(manifest.clusters[0].evidence[0]).toMatchObject({ kind: 'exact_content_digest' });
  });

  test('does not cluster a malformed slug with a meaningful but unrelated note', () => {
    const manifest = buildDuplicateEvidenceManifest([
      { ...service2025, id: 3, source_id: 'notion', title: 'Synthetic service design note', compiled_truth: 'A wholly unrelated shopping list for tomatoes and basil.', content_hash: 'other' },
      service2025,
    ]);
    expect(manifest.clusters).toHaveLength(0);
  });

  test('is deterministic and audit handoffs fail closed on stale or unapproved candidates', () => {
    const pages = [service2025, service2024];
    const first = buildDuplicateEvidenceManifest(pages);
    const second = buildDuplicateEvidenceManifest([...pages].reverse());
    expect(first).toEqual(second);

    const candidates = [{
      cluster_id: first.clusters[0].cluster_id,
      page_id: 1,
      source_id: service2025.source_id,
      slug: service2025.slug,
      content_hash: service2025.content_hash!,
      content_digest: first.clusters[0].pages.find((row) => row.page_id === 1)!.content_digest,
      approved: true,
    }];
    const handoff = {
      schema_version: 2,
      input_snapshot_hash: snapshotHash(pages),
      evidence_manifest_hash: buildDuplicateEvidenceManifest(pages).manifest_hash,
      candidate_hash: candidateHash(candidates),
      approved_by: 'reviewer-example',
      candidates,
    };
    expect(validateDuplicateAuditHandoff(handoff, pages)).toEqual({ ok: true, errors: [], authorized_for_mutation: false, approval_provenance: 'self_asserted_unverified' });
    expect(validateDuplicateAuditHandoff({ ...handoff, input_snapshot_hash: 'stale' }, pages).ok).toBe(false);
    expect(validateDuplicateAuditHandoff({ ...handoff, evidence_manifest_hash: 'stale' }, pages).ok).toBe(false);
    expect(validateDuplicateAuditHandoff({ ...handoff, candidates: [{ ...candidates[0], approved: false }] }, pages).ok).toBe(false);
    expect(validateDuplicateAuditHandoff({ ...handoff, candidates: [{ ...candidates[0], cluster_id: 'unknown' }] }, pages).ok).toBe(false);
    expect(validateDuplicateAuditHandoff(handoff, [{ ...pages[0], compiled_truth: 'changed content' }, pages[1]]).ok).toBe(false);
    expect(validateDuplicateAuditHandoff({ ...handoff, candidates: [null] } as never, pages).ok).toBe(false);
  });

  test('rejects stored hash collisions and finds missing-hash short-title copies', () => {
    expect(buildDuplicateEvidenceManifest([{ ...service2025, compiled_truth: 'cats', content_hash: 'same' }, { ...service2024, compiled_truth: 'dogs', content_hash: 'same' }]).clusters).toHaveLength(0);
    const result = buildDuplicateEvidenceManifest([{ ...service2025, title: 'A', content_hash: null }, { ...service2024, title: 'B', content_hash: null }]);
    expect(result.clusters[0].confidence).toBe('high');
    expect(result.clusters[0].canonical_display.safe_to_discard_others).toBe(false);
  });

  test('mixed exact and similar relationships do not promote a whole cluster', () => {
    const body = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda';
    const result = buildDuplicateEvidenceManifest([{ ...service2025, compiled_truth: body }, { ...service2024, compiled_truth: body }, { ...service2025, id: 3, slug: 'revision', compiled_truth: body + ' mu' }]);
    expect(result.clusters[0].confidence).toBe('medium');
    expect(new Set(result.clusters[0].relationships.map((edge) => edge.confidence))).toEqual(new Set(['high', 'medium']));
    expect(result.clusters[0].canonical_display.safe_to_discard_others).toBe(false);
  });

  test('large groups, within-source duplicates, empty and image-only bodies remain explicit', () => {
    const pages = Array.from({ length: 1100 }, (_, id) => ({ ...service2025, id: id + 1, slug: `copy-${id}` }));
    expect(buildDuplicateEvidenceManifest(pages).clusters[0].pages).toHaveLength(1100);
    const diverse = pages.slice(0, 251).map((page, id) => ({ ...page, compiled_truth: `revision ${id}` }));
    expect(buildDuplicateEvidenceManifest(diverse).skipped_similarity_groups).toHaveLength(0);
    expect(buildDuplicateEvidenceManifest(diverse).pages_scanned).toBe(251);
    expect(buildDuplicateEvidenceManifest([{ ...service2025, compiled_truth: '' }, { ...service2024, compiled_truth: '' }]).clusters).toHaveLength(0);
    for (const body of ['# Template\n## Tasks', '![](https://example.com/image.png)']) {
      const result = buildDuplicateEvidenceManifest([{ ...service2025, compiled_truth: body }, { ...service2024, compiled_truth: body }]);
      expect(result.clusters[0].canonical_display.safe_to_discard_others).toBe(false);
    }
  });

  test('survivor targeting fails even with recomputed candidate hash', () => {
    const pages = [service2025, service2024];
    const manifest = buildDuplicateEvidenceManifest(pages);
    for (const rows of [manifest.clusters[0].pages, [manifest.clusters[0].pages[0]]]) {
      const candidates = rows.map((row) => ({ ...row, cluster_id: manifest.clusters[0].cluster_id, approved: true }));
      expect(validateDuplicateAuditHandoff({ schema_version: 2, input_snapshot_hash: manifest.input_snapshot_hash, evidence_manifest_hash: manifest.manifest_hash, candidate_hash: candidateHash(candidates), approved_by: 'reviewer-example', candidates }, pages).ok).toBe(false);
    }
    expect(() => buildDuplicateEvidenceManifest([service2025, service2025])).toThrow('Duplicate page identity');
  });

  test('reads pages only when producing evidence', async () => {
    const listPagesCalls: unknown[] = [];
    const engine = {
      transaction: async (fn: (tx: unknown) => unknown) => fn({ executeRaw: async (query: string) => {
        listPagesCalls.push(query);
        if (query.startsWith('SELECT id FROM sources')) return [{ id: service2025.source_id }];
        if (query.startsWith('SELECT source_id, count')) return [{ source_id:service2025.source_id,count:1 },{ source_id:service2024.source_id,count:1 }];
        if (query.startsWith('SELECT id,')) return [service2025, service2024];
        return [];
      } }),
    } as unknown as BrainEngine;
    const originalLog = console.log;
    const output: string[] = [];
    console.log = (value: string) => output.push(value);
    try {
      await runDuplicates(engine, ['evidence', '--json', '--source', service2025.source_id]);
    } finally {
      console.log = originalLog;
    }
    expect(listPagesCalls[0]).toBe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    expect(JSON.parse(output[0]).pages_scanned).toBe(2);
  });
});
