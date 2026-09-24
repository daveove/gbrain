import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'path';
import { readFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import {
  GRAPH_USEFULNESS_SUBCOMMANDS,
  graphUsefulnessSubcommand,
  isGraphUsefulnessSubcommand,
} from '../src/commands/graph-usefulness.ts';
import { parseOptionalPositiveLimit, InvalidGraphLimitError } from '../src/core/graph-usefulness/limit.ts';
import { hitsIncludeReadwiseLineage } from '../src/core/graph-usefulness/retrieval-proof.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { measureGraphUsefulness } from '../src/core/graph-usefulness/measure.ts';
import {
  applyRelationManifest,
  guardsAllLiteralTrue,
  loadRelationManifestFile,
  parseRelationManifest,
} from '../src/core/graph-usefulness/relation-manifest.ts';
import {
  runRetrievalProof,
  parseRetrievalProofManifest,
  retrievalProofMutationCount,
  retrievalProofPassed,
} from '../src/core/graph-usefulness/retrieval-proof.ts';
import type { RelationManifest } from '../src/core/graph-usefulness/types.ts';
import { classifyJunkSlugs, slugLooksReadwise } from '../src/core/graph-usefulness/junk-classify.ts';

let engine: BrainEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.putPage('topics/parent-note', {
    title: 'Parent Note',
    compiled_truth: 'Parent body about immigration policy.',
    type: 'note',
  });
  await engine.putPage('topics/child-note', {
    title: 'Child Note',
    compiled_truth: 'Child body linked from parent.',
    type: 'note',
  });
  await engine.upsertChunks('topics/parent-note', [
    { chunk_index: 0, chunk_text: 'Parent body about immigration policy.', chunk_source: 'compiled_truth' },
  ], { sourceId: 'default' });
});

afterAll(async () => {
  await engine.disconnect();
});

describe('graph-usefulness measure', () => {
  test('returns fingerprint and degree stats', async () => {
    const m = await measureGraphUsefulness(engine);
    expect(m.active_pages).toBeGreaterThanOrEqual(2);
    expect(m.fingerprint.sha256).toHaveLength(64);
  });
});

describe('graph CLI routing', () => {
  test('slug-first args are not usefulness subcommands', () => {
    expect(isGraphUsefulnessSubcommand('people/alice-example')).toBe(false);
    expect(isGraphUsefulnessSubcommand(undefined)).toBe(false);
    expect(GRAPH_USEFULNESS_SUBCOMMANDS.has('measure')).toBe(true);
    expect(isGraphUsefulnessSubcommand('measure')).toBe(true);
    expect(graphUsefulnessSubcommand(['people/alice-example'])).toBeUndefined();
    expect(graphUsefulnessSubcommand(['--source', 'wiki', 'people/alice-example'])).toBeUndefined();
    expect(graphUsefulnessSubcommand(['--source', 'wiki', 'measure'])).toBe('measure');
    expect(graphUsefulnessSubcommand(['--link-type', 'measure', 'people/alice-example'])).toBeUndefined();
    expect(graphUsefulnessSubcommand(['relations', 'verify', 'm.json'])).toBe('relations');
  });

  test('bare graph stays on the operation path', () => {
    const cli = readFileSync(join(import.meta.dir, '../src/cli.ts'), 'utf8');
    const usefulness = readFileSync(join(import.meta.dir, '../src/commands/graph-usefulness.ts'), 'utf8');
    expect(cli).not.toContain("'graph', 'graph-query'");
    expect(cli).toContain('dispatchGraphUsefulness');
    expect(cli).not.toContain("case 'graph':");
    expect(usefulness).not.toContain('runGraphQuery');
  });
});

describe('limit parsing', () => {
  test('rejects invalid --limit values', () => {
    expect(parseOptionalPositiveLimit(undefined)).toBeUndefined();
    expect(parseOptionalPositiveLimit('3')).toBe(3);
    expect(() => parseOptionalPositiveLimit('0')).toThrow(InvalidGraphLimitError);
    expect(() => parseOptionalPositiveLimit('-1')).toThrow(InvalidGraphLimitError);
    expect(() => parseOptionalPositiveLimit('abc')).toThrow(InvalidGraphLimitError);
    expect(() => parseOptionalPositiveLimit('1.5')).toThrow(InvalidGraphLimitError);
  });
});

describe('junk classify', () => {
  test('flags pnpm and uuid patterns', () => {
    const samples = classifyJunkSlugs([
      'imports/.pnpm-store/foo',
      'entities/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      'topics/normal',
    ]);
    expect(samples.some(s => s.pattern === 'pnpm_store')).toBe(true);
    expect(samples.some(s => s.pattern === 'uuid_blob')).toBe(true);
    expect(slugLooksReadwise('readwise/highlight', 'default')).toBe(true);
  });
});

describe('relation manifest', () => {
  test('dry-run then apply writes one link with receipt fingerprints', async () => {
    const fixture = join(import.meta.dir, 'fixtures/graph-usefulness/sample-relation-manifest.json');
    const { manifest, raw } = loadRelationManifestFile(fixture);
    const dry = await applyRelationManifest(engine, manifest, raw, { apply: false });
    expect(dry.mode).toBe('dry-run');
    expect(dry.outcomes[0]?.status).toBe('dry_run');

    const applied = await applyRelationManifest(engine, manifest, raw, { apply: true });
    expect(applied.applied).toBe(1);
    expect(applied.before.sha256).not.toBe(applied.after.sha256);

    const again = await applyRelationManifest(engine, manifest, raw, { apply: true });
    expect(again.outcomes[0]?.status).toBe('skipped_already_linked');
  });

  test('writes partial failure receipt when addLink throws mid-batch', async () => {
    await engine.putPage('topics/batch-a', { title: 'A', compiled_truth: 'a', type: 'note' });
    await engine.putPage('topics/batch-b', { title: 'B', compiled_truth: 'b', type: 'note' });
    await engine.putPage('topics/batch-c', { title: 'C', compiled_truth: 'c', type: 'note' });
    const manifest = parseRelationManifest(JSON.stringify({
      manifest_version: 1,
      rows: [
        {
          id: 'b1',
          from_slug: 'topics/batch-a',
          to_slug: 'topics/batch-b',
          link_type: 'child_of',
          link_source: 'tana-relation-r2',
          guards: { exact_endpoint_match: true, source_relation_current: true, no_incident_edge: true, readwise_clear: true },
        },
        {
          id: 'b2',
          from_slug: 'topics/batch-a',
          to_slug: 'topics/batch-c',
          link_type: 'child_of',
          link_source: 'tana-relation-r2',
          guards: { exact_endpoint_match: true, source_relation_current: true, no_incident_edge: true, readwise_clear: true },
        },
      ],
    }));
    const raw = JSON.stringify(manifest);
    const receiptDir = mkdtempSync(join(tmpdir(), 'gbrain-receipt-'));
    const receiptPath = join(receiptDir, 'partial.json');
    const original = engine.addLink.bind(engine);
    let calls = 0;
    engine.addLink = async (...args) => {
      calls += 1;
      if (calls === 2) throw new Error('simulated batch failure');
      return original(...args);
    };
    try {
      await expect(applyRelationManifest(engine, manifest, raw, {
        apply: true,
        receiptPath,
      })).rejects.toThrow('simulated batch failure');
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
      expect(receipt.partial_failure).toBe(true);
      expect(receipt.outcomes.filter((o: { status: string }) => o.status === 'applied').length).toBe(1);
      expect(receipt.after.sha256).toBeTruthy();
    } finally {
      engine.addLink = original;
    }
  });

  test('rejects stringly guard values at parse time', () => {
    const row = {
      id: 's',
      from_slug: 'topics/parent-note',
      to_slug: 'topics/child-note',
      link_type: 'child_of',
      link_source: 'tana-relation-r2',
      guards: {
        exact_endpoint_match: 'true',
        source_relation_current: 'false',
        no_incident_edge: true,
        readwise_clear: true,
      },
    };
    expect(() => parseRelationManifest(JSON.stringify({ manifest_version: 1, rows: [row] })))
      .toThrow(/literal boolean/);
  });

  test('stringly true does not authorize addLink', async () => {
    const manifest = {
      manifest_version: 1,
      rows: [{
        id: 's',
        from_slug: 'topics/parent-note',
        to_slug: 'topics/child-note',
        link_type: 'child_of',
        link_source: 'tana-relation-r2',
        guards: {
          exact_endpoint_match: 'true',
          source_relation_current: 'false',
          no_incident_edge: true,
          readwise_clear: true,
        },
      }],
    } as unknown as RelationManifest;
    expect(guardsAllLiteralTrue(manifest.rows[0].guards)).toBe(false);
    const result = await applyRelationManifest(engine, manifest, JSON.stringify(manifest), { apply: true });
    expect(result.applied).toBe(0);
    expect(result.outcomes[0]?.status).toBe('skipped_guard');
  });

  test('literal false guard skips the row', async () => {
    const manifest = parseRelationManifest(JSON.stringify({
      manifest_version: 1,
      rows: [{
        id: 'g-false',
        from_slug: 'topics/parent-note',
        to_slug: 'topics/child-note',
        link_type: 'child_of',
        link_source: 'tana-relation-r2',
        guards: {
          exact_endpoint_match: false,
          source_relation_current: true,
          no_incident_edge: true,
          readwise_clear: true,
        },
      }],
    }));
    const result = await applyRelationManifest(engine, manifest, JSON.stringify(manifest), { apply: true });
    expect(result.applied).toBe(0);
    expect(result.outcomes[0]?.status).toBe('skipped_guard');
  });

  test('rejects managed link_source in manifest', () => {
    const row = {
      id: 'x', from_slug: 'a', to_slug: 'b', link_type: 't', link_source: 'markdown',
      guards: { exact_endpoint_match: true, source_relation_current: true, no_incident_edge: true, readwise_clear: true },
    };
    expect(() => parseRelationManifest(JSON.stringify({ manifest_version: 1, rows: [row] })))
      .toThrow(/reconciliation-managed/);
  });
});

describe('retrieval proof', () => {
  test('detects readwise via result source_id even when slug is neutral', () => {
    expect(hitsIncludeReadwiseLineage([
      { slug: 'topics/neutral-title', source_id: 'readwise' },
    ])).toBe(true);
    expect(hitsIncludeReadwiseLineage([
      { slug: 'topics/neutral-title', source_id: 'default' },
    ])).toBe(false);
  });

  test('scores fixture question without mutating fingerprint', async () => {
    const raw = readFileSync(join(import.meta.dir, 'fixtures/graph-usefulness/sample-retrieval-proof.json'), 'utf8');
    const manifest = parseRetrievalProofManifest(raw);
    const result = await runRetrievalProof(engine, manifest);
    expect(result.checks.production_mutations).toBe(0);
    expect(result.fingerprint_before.sha256).toBe(result.fingerprint_after.sha256);
    expect(result.passed).toBe(retrievalProofPassed(0, 0, 0));
    expect(result.checks.questions).toBe(1);
  });

  test('fingerprint inequality fails the proof and counts as a mutation', () => {
    const before = {
      active_pages: 2, link_rows: 0, valid_links: 0, zero_degree_pages: 2, sha256: 'aaa',
    };
    const after = {
      active_pages: 3, link_rows: 0, valid_links: 0, zero_degree_pages: 3, sha256: 'bbb',
    };
    const mutations = retrievalProofMutationCount(before, after);
    expect(mutations).toBeGreaterThan(0);
    expect(retrievalProofPassed(0, 0, mutations)).toBe(false);
    expect(retrievalProofMutationCount(before, { ...before })).toBe(0);
  });

  test('fails the live proof when the graph changes mid-run', async () => {
    const raw = readFileSync(join(import.meta.dir, 'fixtures/graph-usefulness/sample-retrieval-proof.json'), 'utf8');
    const manifest = parseRetrievalProofManifest(raw);
    const original = engine.executeRaw.bind(engine);
    let fpCalls = 0;
    let busy = false;
    engine.executeRaw = async (sql, params, opts) => {
      if (!busy && typeof sql === 'string' && sql.includes('zero_degree_pages')) {
        fpCalls += 1;
        if (fpCalls === 2) {
          busy = true;
          try {
            await engine.putPage('topics/mid-proof-page', {
              title: 'Mid proof',
              compiled_truth: 'inserted while a retrieval proof was running',
              type: 'note',
            });
          } finally {
            busy = false;
          }
        }
      }
      return original(sql, params, opts);
    };
    try {
      const result = await runRetrievalProof(engine, manifest);
      expect(result.fingerprint_before.sha256).not.toBe(result.fingerprint_after.sha256);
      expect(result.passed).toBe(false);
      expect(result.checks.production_mutations).toBeGreaterThan(0);
    } finally {
      engine.executeRaw = original;
    }
  });
});
