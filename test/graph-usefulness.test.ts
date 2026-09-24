import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'path';
import { readFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import {
  GRAPH_USEFULNESS_SUBCOMMANDS,
  isGraphUsefulnessSubcommand,
} from '../src/commands/graph-usefulness.ts';
import { parseOptionalPositiveLimit, InvalidGraphLimitError } from '../src/core/graph-usefulness/limit.ts';
import { hitsIncludeReadwiseLineage } from '../src/core/graph-usefulness/retrieval-proof.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { measureGraphUsefulness } from '../src/core/graph-usefulness/measure.ts';
import {
  applyRelationManifest,
  loadRelationManifestFile,
  parseRelationManifest,
} from '../src/core/graph-usefulness/relation-manifest.ts';
import { runRetrievalProof, parseRetrievalProofManifest } from '../src/core/graph-usefulness/retrieval-proof.ts';
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
    expect(GRAPH_USEFULNESS_SUBCOMMANDS.has('measure')).toBe(true);
    expect(isGraphUsefulnessSubcommand('measure')).toBe(true);
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
    expect(result.checks.questions).toBe(1);
  });
});
