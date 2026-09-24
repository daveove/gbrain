import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'path';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import {
  GRAPH_USEFULNESS_SUBCOMMANDS,
  argsBeforeOptionTerminator,
  graphPositionals,
  graphUsefulnessSubcommand,
  graphUsefulnessWantsHelp,
  isGraphUsefulnessSubcommand,
  MissingGraphLimitError,
  findGraphUsefulnessFlagProblem,
  readLimitFlag,
  rejectGraphUsefulnessFlagProblem,
  runGraphUsefulness,
} from '../src/commands/graph-usefulness.ts';
import { dispatchGraphUsefulness } from '../src/commands/graph-usefulness-dispatch.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import { parseOptionalPositiveLimit, InvalidGraphLimitError } from '../src/core/graph-usefulness/limit.ts';
import { hitsIncludeReadwiseLineage } from '../src/core/graph-usefulness/retrieval-proof.ts';
import { computeGraphFingerprint } from '../src/core/graph-usefulness/fingerprint.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { measureGraphUsefulness } from '../src/core/graph-usefulness/measure.ts';
import {
  applyRelationManifest,
  guardsAllLiteralTrue,
  loadRelationManifestFile,
  MutationReceiptExistsError,
  _setBeforeReceiptCommitForTests,
  parseRelationManifest,
} from '../src/core/graph-usefulness/relation-manifest.ts';
import { withEnv } from './helpers/with-env.ts';
import {
  runRetrievalProof,
  parseRetrievalProofManifest,
  retrievalProofMutationCount,
  retrievalProofPassed,
  scoreRetrievalQuestion,
  SlugOnlyProofNeedsSourceError,
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

  test('valued flags before relations and retrieval-proof are not positionals', () => {
    expect(graphPositionals(['--source', 'wiki', 'retrieval-proof', 'run', 'proof.json']))
      .toEqual(['retrieval-proof', 'run', 'proof.json']);
    expect(graphPositionals(['--source', 'wiki', 'relations', 'apply', 'm.json', '--limit', '2']))
      .toEqual(['relations', 'apply', 'm.json']);
    expect(graphPositionals(['retrieval-proof', 'run', '--out', 'out.json', 'proof.json']))
      .toEqual(['retrieval-proof', 'run', 'proof.json']);
    expect(graphUsefulnessSubcommand(['--source', 'wiki', 'retrieval-proof', 'run', 'proof.json']))
      .toBe('retrieval-proof');
    expect(graphUsefulnessSubcommand(['--source', 'wiki', 'relations', 'verify', 'm.json']))
      .toBe('relations');
    expect(graphPositionals(['--source=wiki', 'retrieval-proof', 'run', 'proof.json']))
      .toEqual(['retrieval-proof', 'run', 'proof.json']);
    expect(graphPositionals(['relations', 'apply', '--limit=1', 'm.json', '--receipt-out=r.json']))
      .toEqual(['relations', 'apply', 'm.json']);
    expect(argsBeforeOptionTerminator([
      'relations', 'apply', 'm.json', '--apply', '--', '--yes', '--dry-run',
    ])).toEqual(['relations', 'apply', 'm.json', '--apply']);
    expect(graphPositionals([
      'relations', 'apply', 'm.json', '--', '--apply', '--yes', '--dry-run',
    ])).toEqual(['relations', 'apply', 'm.json', '--apply', '--yes', '--dry-run']);
    expect(readLimitFlag(['relations', 'apply', 'm.json', '--', '--limit', '1'])).toBeUndefined();
    expect(readLimitFlag(['--limit', '2', '--', '--limit', '9'])).toBe('2');
    expect(graphUsefulnessWantsHelp(['measure', '--help'])).toBe(true);
    expect(graphUsefulnessWantsHelp(['help'])).toBe(true);
    expect(graphUsefulnessWantsHelp(['stats', '-h'])).toBe(true);
    expect(graphUsefulnessWantsHelp(['measure', '--', '--help'])).toBe(false);
    expect(findGraphUsefulnessFlagProblem([
      'relations', 'apply', 'm.json', '--', '--apply', '--yes', '--dry-run',
    ])).toBeNull();
    expect(findGraphUsefulnessFlagProblem([
      'relations', 'apply', 'm.json', '--dry-run', '--', '--help',
    ])).toEqual({ kind: 'unknown', flag: '--dry-run' });
  });

  test('bare graph stays on the operation path', () => {
    const cli = readFileSync(join(import.meta.dir, '../src/cli.ts'), 'utf8');
    const usefulness = readFileSync(join(import.meta.dir, '../src/commands/graph-usefulness.ts'), 'utf8');
    expect(cli).not.toContain("'graph', 'graph-query'");
    expect(cli).toContain('dispatchGraphUsefulness');
    expect(cli).toContain('rejectGraphUsefulnessFlagProblem');
    const rejectAt = cli.indexOf('rejectGraphUsefulnessFlagProblem');
    const dispatchAt = cli.indexOf('dispatchGraphUsefulness');
    expect(rejectAt).toBeGreaterThan(-1);
    expect(rejectAt).toBeLessThan(dispatchAt);
    expect(cli).not.toContain("case 'graph':");
    expect(usefulness).not.toContain('runGraphQuery');
  });

  test('unknown flags and option-valued flags are rejected before apply', async () => {
    expect(findGraphUsefulnessFlagProblem([
      'relations', 'apply', 'm.json', '--apply', '--yes', '--dry-run',
    ])).toEqual({ kind: 'unknown', flag: '--dry-run' });
    expect(findGraphUsefulnessFlagProblem([
      'relations', 'apply', 'm.json', '--receipt-out', '--apply', '--yes',
    ])).toEqual({ kind: 'missing_value', flag: '--receipt-out' });
    expect(findGraphUsefulnessFlagProblem([
      'relations', 'apply', 'm.json', '--apply', '--yes', '--limit=1', '--receipt-out=r.json',
    ])).toBeNull();
    expect(findGraphUsefulnessFlagProblem(['people/alice-example', '--depth', '2'])).toBeNull();

    const origExit = process.exit;
    const origErr = console.error;
    const exitError = new Error('__exit__');
    let code: number | undefined;
    const errors: string[] = [];
    process.exit = ((c?: number) => {
      code = c;
      throw exitError;
    }) as typeof process.exit;
    console.error = (...a: unknown[]) => { errors.push(a.map(String).join(' ')); };
    const original = engine.addLink.bind(engine);
    let calls = 0;
    engine.addLink = async (...args) => {
      calls += 1;
      return original(...args);
    };
    try {
      await expect(runGraphUsefulness(engine, [
        'relations', 'apply', 'manifest.json', '--apply', '--yes', '--dry-run',
      ])).rejects.toBe(exitError);
      expect(code).toBe(1);
      expect(errors.some(line => line.includes('unknown flag --dry-run'))).toBe(true);

      code = -1;
      errors.length = 0;
      expect(() => rejectGraphUsefulnessFlagProblem([
        'relations', 'apply', 'manifest.json', '--apply', '--yes', '--dry-run',
      ])).toThrow(exitError);
      expect(code).toBe(1);

      code = -1;
      await expect(runGraphUsefulness(engine, [
        'relations', 'apply', 'manifest.json', '--receipt-out', '--apply', '--yes',
      ])).rejects.toBe(exitError);
      expect(code).toBe(2);
      expect(calls).toBe(0);
    } finally {
      process.exit = origExit;
      console.error = origErr;
      engine.addLink = original;
      process.exitCode = undefined;
      _resetCliExitVerdictForTests();
    }
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

  test('rejects a valueless --limit before applying', async () => {
    expect(readLimitFlag(['relations', 'apply', 'm.json', '--apply', '--yes']))
      .toBeUndefined();
    expect(readLimitFlag(['--limit', '3'])).toBe('3');
    expect(readLimitFlag(['--limit=1'])).toBe('1');
    expect(readLimitFlag(['relations', 'apply', 'm.json', '--apply', '--yes', '--limit=2'])).toBe('2');
    expect(() => readLimitFlag(['--limit='])).toThrow(MissingGraphLimitError);
    expect(() => readLimitFlag(['--limit', '--apply'])).toThrow(MissingGraphLimitError);
    expect(() => readLimitFlag(['--limit=--1'])).toThrow(MissingGraphLimitError);
    expect(() => readLimitFlag(['relations', 'apply', 'm.json', '--apply', '--yes', '--limit']))
      .toThrow(MissingGraphLimitError);

    const origExit = process.exit;
    const exitError = new Error('__exit__');
    let code: number | undefined;
    process.exit = ((c?: number) => {
      code = c;
      throw exitError;
    }) as typeof process.exit;
    try {
      await expect(runGraphUsefulness(engine, [
        'relations', 'apply', 'manifest.json', '--apply', '--yes', '--limit',
      ])).rejects.toBe(exitError);
      expect(code).toBe(2);
    } finally {
      process.exit = origExit;
      process.exitCode = undefined;
      _resetCliExitVerdictForTests();
    }
  });

  test('inline --limit=1 applies one row before the rest of the manifest', async () => {
    await engine.putPage('topics/lim-a', { title: 'Lim A', compiled_truth: 'a', type: 'note' });
    await engine.putPage('topics/lim-b', { title: 'Lim B', compiled_truth: 'b', type: 'note' });
    await engine.putPage('topics/lim-c', { title: 'Lim C', compiled_truth: 'c', type: 'note' });
    const guards = {
      exact_endpoint_match: true,
      source_relation_current: true,
      no_incident_edge: true,
      readwise_clear: true,
    };
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-limit-'));
    const manifestPath = join(dir, 'manifest.json');
    const receiptPath = join(dir, 'receipt.json');
    writeFileSync(manifestPath, JSON.stringify({
      manifest_version: 1,
      rows: [
        {
          id: 'lim-1',
          from_slug: 'topics/lim-a',
          to_slug: 'topics/lim-b',
          link_type: 'related_to',
          link_source: 'tana-relation-r2',
          guards,
        },
        {
          id: 'lim-2',
          from_slug: 'topics/lim-a',
          to_slug: 'topics/lim-c',
          link_type: 'related_to',
          link_source: 'tana-relation-r2',
          guards,
        },
      ],
    }));
    const original = engine.addLink.bind(engine);
    const linked: string[] = [];
    engine.addLink = async (...args) => {
      linked.push(String(args[1]));
      return original(...args);
    };
    const origLog = console.log;
    console.log = () => {};
    try {
      await runGraphUsefulness(engine, [
        'relations', 'apply', '--limit=1', manifestPath, '--apply', '--yes', `--receipt-out=${receiptPath}`,
      ]);
      expect(linked).toEqual(['topics/lim-b']);
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
      expect(receipt.counts.planned).toBe(1);
      expect(receipt.counts.applied).toBe(1);
      expect(receipt.mode).toBe('apply');
    } finally {
      engine.addLink = original;
      console.log = origLog;
      process.exitCode = undefined;
      _resetCliExitVerdictForTests();
    }
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
          link_type: 'related_to',
          link_source: 'tana-relation-r2',
          guards: { exact_endpoint_match: true, source_relation_current: true, no_incident_edge: true, readwise_clear: true },
        },
        {
          id: 'b2',
          from_slug: 'topics/batch-a',
          to_slug: 'topics/batch-c',
          link_type: 'related_to',
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
      link_type: 'related_to',
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
        link_type: 'related_to',
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
        link_type: 'related_to',
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

  test('refuses to overwrite an existing mutation receipt', async () => {
    await engine.putPage('topics/rcpt-a', { title: 'Rcpt A', compiled_truth: 'a', type: 'note' });
    await engine.putPage('topics/rcpt-b', { title: 'Rcpt B', compiled_truth: 'b', type: 'note' });
    await engine.putPage('topics/rcpt-c', { title: 'Rcpt C', compiled_truth: 'c', type: 'note' });
    const guards = {
      exact_endpoint_match: true,
      source_relation_current: true,
      no_incident_edge: true,
      readwise_clear: true,
    };
    const first = parseRelationManifest(JSON.stringify({
      manifest_version: 1,
      rows: [{
        id: 'rcpt-1',
        from_slug: 'topics/rcpt-a',
        to_slug: 'topics/rcpt-b',
        link_type: 'related_to',
        link_source: 'tana-relation-r2',
        guards,
      }],
    }));
    const second = parseRelationManifest(JSON.stringify({
      manifest_version: 1,
      rows: [{
        id: 'rcpt-2',
        from_slug: 'topics/rcpt-a',
        to_slug: 'topics/rcpt-c',
        link_type: 'related_to',
        link_source: 'tana-relation-r2',
        guards,
      }],
    }));
    const receiptPath = join(mkdtempSync(join(tmpdir(), 'gbrain-rcpt-')), 'mutation.json');
    const applied = await applyRelationManifest(engine, first, JSON.stringify(first), {
      apply: true,
      receiptPath,
    });
    expect(applied.applied).toBe(1);
    const body = readFileSync(receiptPath, 'utf8');
    expect(JSON.parse(body).mode).toBe('apply');

    const original = engine.addLink.bind(engine);
    let calls = 0;
    engine.addLink = async (...args) => {
      calls += 1;
      return original(...args);
    };
    try {
      await expect(applyRelationManifest(engine, second, JSON.stringify(second), {
        apply: false,
        receiptPath,
      })).rejects.toThrow(MutationReceiptExistsError);
      await expect(applyRelationManifest(engine, second, JSON.stringify(second), {
        apply: true,
        receiptPath,
      })).rejects.toThrow(MutationReceiptExistsError);
      expect(calls).toBe(0);
      expect(readFileSync(receiptPath, 'utf8')).toBe(body);
    } finally {
      engine.addLink = original;
    }
  });

  test('rejects an undeclared link type before addLink when a pack resolves', async () => {
    await engine.putPage('topics/vocab-a', { title: 'Vocab A', compiled_truth: 'a', type: 'note' });
    await engine.putPage('topics/vocab-b', { title: 'Vocab B', compiled_truth: 'b', type: 'note' });
    const manifest = parseRelationManifest(JSON.stringify({
      manifest_version: 1,
      rows: [{
        id: 'vocab-1',
        from_slug: 'topics/vocab-a',
        to_slug: 'topics/vocab-b',
        link_type: 'definitely_not_a_link_verb',
        link_source: 'tana-relation-r2',
        guards: {
          exact_endpoint_match: true,
          source_relation_current: true,
          no_incident_edge: true,
          readwise_clear: true,
        },
      }],
    }));
    const origGet = engine.getConfig.bind(engine);
    const origAdd = engine.addLink.bind(engine);
    let calls = 0;
    engine.getConfig = async (key: string) => {
      if (key === 'schema_pack') return 'gbrain-base';
      return origGet(key);
    };
    engine.addLink = async (...args) => {
      calls += 1;
      return origAdd(...args);
    };
    try {
      await withEnv({ GBRAIN_SCHEMA_PACK: undefined }, async () => {
        await expect(applyRelationManifest(engine, manifest, JSON.stringify(manifest), { apply: true }))
          .rejects.toThrow(/not declared in active schema pack 'gbrain-base'/);
        await expect(applyRelationManifest(engine, manifest, JSON.stringify(manifest), { apply: false }))
          .rejects.toThrow(/definitely_not_a_link_verb/);
      });
      expect(calls).toBe(0);
    } finally {
      engine.getConfig = origGet;
      engine.addLink = origAdd;
    }
  });

  test('refuses to apply when the receipt parent cannot be created', async () => {
    await engine.putPage('topics/dur-a', { title: 'Dur A', compiled_truth: 'a', type: 'note' });
    await engine.putPage('topics/dur-b', { title: 'Dur B', compiled_truth: 'b', type: 'note' });
    const manifest = parseRelationManifest(JSON.stringify({
      manifest_version: 1,
      rows: [{
        id: 'dur-parent',
        from_slug: 'topics/dur-a',
        to_slug: 'topics/dur-b',
        link_type: 'related_to',
        link_source: 'tana-relation-r2',
        guards: {
          exact_endpoint_match: true,
          source_relation_current: true,
          no_incident_edge: true,
          readwise_clear: true,
        },
      }],
    }));
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-rcpt-parent-'));
    const blocker = join(dir, 'not-a-directory');
    writeFileSync(blocker, 'x');
    const receiptPath = join(blocker, 'receipt.json');
    const original = engine.addLink.bind(engine);
    let calls = 0;
    engine.addLink = async (...args) => {
      calls += 1;
      return original(...args);
    };
    try {
      await expect(applyRelationManifest(engine, manifest, JSON.stringify(manifest), {
        apply: true,
        receiptPath,
      })).rejects.toThrow();
      expect(calls).toBe(0);
    } finally {
      engine.addLink = original;
    }
  });

  test('rolls back applied links when the final receipt cannot be saved', async () => {
    await engine.putPage('topics/undo-a', { title: 'Undo A', compiled_truth: 'a', type: 'note' });
    await engine.putPage('topics/undo-b', { title: 'Undo B', compiled_truth: 'b', type: 'note' });
    const manifest = parseRelationManifest(JSON.stringify({
      manifest_version: 1,
      rows: [{
        id: 'undo-1',
        from_slug: 'topics/undo-a',
        to_slug: 'topics/undo-b',
        link_type: 'related_to',
        link_source: 'tana-relation-r2',
        guards: {
          exact_endpoint_match: true,
          source_relation_current: true,
          no_incident_edge: true,
          readwise_clear: true,
        },
      }],
    }));
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-rcpt-undo-'));
    const receiptPath = join(dir, 'receipt.json');
    _setBeforeReceiptCommitForTests(() => {
      unlinkSync(receiptPath);
      mkdirSync(receiptPath);
    });
    try {
      await expect(applyRelationManifest(engine, manifest, JSON.stringify(manifest), {
        apply: true,
        receiptPath,
      })).rejects.toThrow(/rolled back 1 applied link/);
      const rows = await engine.executeRaw<{ n: string }>(
        `SELECT count(*)::text AS n FROM links l
          JOIN pages fp ON fp.id = l.from_page_id
          JOIN pages tp ON tp.id = l.to_page_id
         WHERE fp.slug = $1 AND tp.slug = $2 AND fp.deleted_at IS NULL AND tp.deleted_at IS NULL`,
        ['topics/undo-a', 'topics/undo-b'],
      );
      expect(Number(rows[0]?.n ?? 0)).toBe(0);
    } finally {
      _setBeforeReceiptCommitForTests(null);
      rmSync(receiptPath, { recursive: true, force: true });
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

describe('graph fingerprint identities', () => {
  test('changes sha256 when an edge is swapped without count change', async () => {
    await engine.putPage('topics/fp-a', { title: 'A', compiled_truth: 'a', type: 'note' });
    await engine.putPage('topics/fp-b', { title: 'B', compiled_truth: 'b', type: 'note' });
    await engine.putPage('topics/fp-c', { title: 'C', compiled_truth: 'c', type: 'note' });
    await engine.addLink('topics/fp-a', 'topics/fp-b', 'ctx', 'related_to', 'manual');
    const before = await computeGraphFingerprint(engine);
    expect(await engine.removeLink('topics/fp-a', 'topics/fp-b', 'related_to', 'manual')).toBe(1);
    await engine.addLink('topics/fp-a', 'topics/fp-c', 'ctx', 'related_to', 'manual');
    const after = await computeGraphFingerprint(engine);
    expect(after.active_pages).toBe(before.active_pages);
    expect(after.link_rows).toBe(before.link_rows);
    expect(after.valid_links).toBe(before.valid_links);
    expect(after.zero_degree_pages).toBe(before.zero_degree_pages);
    expect(after.sha256).not.toBe(before.sha256);
    expect(retrievalProofMutationCount(before, after)).toBeGreaterThan(0);
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
    const result = await runRetrievalProof(engine, manifest, { sourceId: 'default' });
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
    expect(retrievalProofMutationCount(before, { ...before, sha256: 'ccc' })).toBe(1);
  });

  test('scores hits as (source_id, slug) and requires --source for bare slugs', async () => {
    const bare = {
      id: 'q',
      query: 'parent',
      relevant_slugs: ['topics/parent-note'],
      forbidden_slugs: ['topics/secret'],
    };
    expect(() => scoreRetrievalQuestion(bare, [
      { slug: 'topics/parent-note', source_id: 'wiki' },
    ])).toThrow(SlugOnlyProofNeedsSourceError);

    expect(scoreRetrievalQuestion(bare, [
      { slug: 'topics/parent-note', source_id: 'other' },
    ], 'wiki')).toBe('fail');
    expect(scoreRetrievalQuestion(bare, [
      { slug: 'topics/parent-note', source_id: 'wiki' },
    ], 'wiki')).toBe('pass');
    expect(scoreRetrievalQuestion(bare, [
      { slug: 'topics/parent-note', source_id: 'wiki' },
      { slug: 'topics/secret', source_id: 'other' },
    ], 'wiki')).toBe('pass');
    expect(scoreRetrievalQuestion(bare, [
      { slug: 'topics/secret', source_id: 'wiki' },
    ], 'wiki')).toBe('fail');

    const qualified = {
      id: 'q2',
      query: 'parent',
      relevant_pages: [{ source_id: 'wiki', slug: 'topics/parent-note' }],
      forbidden_pages: [{ source_id: 'wiki', slug: 'topics/secret' }],
    };
    expect(scoreRetrievalQuestion(qualified, [
      { slug: 'topics/parent-note', source_id: 'other' },
    ])).toBe('fail');
    expect(scoreRetrievalQuestion(qualified, [
      { slug: 'topics/parent-note', source_id: 'wiki' },
      { slug: 'topics/secret', source_id: 'other' },
    ])).toBe('pass');

    const raw = readFileSync(join(import.meta.dir, 'fixtures/graph-usefulness/sample-retrieval-proof.json'), 'utf8');
    const manifest = parseRetrievalProofManifest(raw);
    await expect(runRetrievalProof(engine, manifest)).rejects.toThrow(SlugOnlyProofNeedsSourceError);
  });

  test('--source before the subcommand still runs', async () => {
    const proof = join(import.meta.dir, 'fixtures/graph-usefulness/sample-retrieval-proof.json');
    const manifestPath = join(import.meta.dir, 'fixtures/graph-usefulness/sample-relation-manifest.json');
    const origLog = console.log;
    const origErr = console.error;
    let stderr = '';
    console.log = () => {};
    console.error = (...a: unknown[]) => { stderr += a.map(String).join(' ') + '\n'; };
    try {
      await runGraphUsefulness(engine, ['--source', 'default', 'retrieval-proof', 'run', proof, '--json']);
      expect(stderr).not.toContain('Usage:');
      stderr = '';
      await runGraphUsefulness(engine, ['--source', 'wiki', 'relations', 'verify', manifestPath, '--json']);
      expect(stderr).not.toContain('Usage:');
      expect(stderr).not.toContain('Unknown relations action');
    } finally {
      console.log = origLog;
      console.error = origErr;
      process.exitCode = undefined;
      _resetCliExitVerdictForTests();
    }
  });

  test('persists fingerprints in retrieval-proof --out JSON', async () => {
    const proof = join(import.meta.dir, 'fixtures/graph-usefulness/sample-retrieval-proof.json');
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-proof-'));
    const spaced = join(dir, 'independent-verification.json');
    const inline = join(dir, 'inline-verification.json');
    const origLog = console.log;
    const origErr = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
      await runGraphUsefulness(engine, [
        '--source', 'default', 'retrieval-proof', 'run', proof, '--out', spaced,
      ]);
      await runGraphUsefulness(engine, [
        '--source=default', 'retrieval-proof', 'run', proof, `--out=${inline}`,
      ]);
      for (const path of [spaced, inline]) {
        const saved = JSON.parse(readFileSync(path, 'utf8'));
        expect(saved.fingerprint_before.sha256).toHaveLength(64);
        expect(saved.fingerprint_after.sha256).toBe(saved.fingerprint_before.sha256);
        expect(saved.checks.production_mutations).toBe(0);
        expect(saved.questions.length).toBeGreaterThan(0);
      }

      const prior = readFileSync(spaced, 'utf8');
      await runGraphUsefulness(engine, [
        '--source', 'default', 'retrieval-proof', 'run', proof, '--out', spaced,
      ]);
      expect(currentExitCode()).toBe(2);
      expect(readFileSync(spaced, 'utf8')).toBe(prior);
    } finally {
      console.log = origLog;
      console.error = origErr;
      process.exitCode = undefined;
      _resetCliExitVerdictForTests();
    }
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
      const result = await runRetrievalProof(engine, manifest, { sourceId: 'default' });
      expect(result.fingerprint_before.sha256).not.toBe(result.fingerprint_after.sha256);
      expect(result.passed).toBe(false);
      expect(result.checks.production_mutations).toBeGreaterThan(0);
    } finally {
      engine.executeRaw = original;
    }
  });
});

const TRUE_GUARDS = {
  exact_endpoint_match: true,
  source_relation_current: true,
  no_incident_edge: true,
  readwise_clear: true,
};

function relationManifest(rows: Array<Record<string, unknown>>): string {
  return JSON.stringify({ manifest_version: 1, rows });
}

describe('relation source scope and option terminator', () => {
  test('--source fills omitted manifest endpoint sources', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('wiki', 'wiki') ON CONFLICT (id) DO NOTHING`,
    );
    const from = 'topics/src-scope-from';
    const to = 'topics/src-scope-to';
    for (const sourceId of ['default', 'wiki']) {
      await engine.putPage(from, { title: 'From', compiled_truth: 'scope from', type: 'note' }, { sourceId });
      await engine.putPage(to, { title: 'To', compiled_truth: 'scope to', type: 'note' }, { sourceId });
    }
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-rel-src-'));
    const manifestPath = join(dir, 'manifest.json');
    const receiptPath = join(dir, 'receipt.json');
    writeFileSync(manifestPath, relationManifest([{
      id: 'wiki-omit',
      from_slug: from,
      to_slug: to,
      link_type: 'related_to',
      link_source: 'tana-relation-r2',
      guards: TRUE_GUARDS,
    }]));
    const origLog = console.log;
    const origErr = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
      await runGraphUsefulness(engine, [
        'relations', 'apply', manifestPath, '--source', 'wiki', '--apply', '--yes',
        '--receipt-out', receiptPath, '--json',
      ]);
      const links = await engine.executeRaw<{ from_source: string; to_source: string }>(
        `SELECT fp.source_id AS from_source, tp.source_id AS to_source
           FROM links l
           JOIN pages fp ON fp.id = l.from_page_id
           JOIN pages tp ON tp.id = l.to_page_id
          WHERE fp.slug = $1 AND tp.slug = $2
            AND fp.deleted_at IS NULL AND tp.deleted_at IS NULL`,
        [from, to],
      );
      expect(links).toEqual([{ from_source: 'wiki', to_source: 'wiki' }]);
    } finally {
      console.log = origLog;
      console.error = origErr;
      process.exitCode = undefined;
      _resetCliExitVerdictForTests();
    }
  });

  test('explicit row source ids win over --source', async () => {
    const from = 'topics/src-explicit-from';
    const to = 'topics/src-explicit-to';
    for (const sourceId of ['default', 'wiki']) {
      await engine.putPage(from, { title: 'From', compiled_truth: 'explicit from', type: 'note' }, { sourceId });
      await engine.putPage(to, { title: 'To', compiled_truth: 'explicit to', type: 'note' }, { sourceId });
    }
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-rel-explicit-'));
    const manifestPath = join(dir, 'manifest.json');
    writeFileSync(manifestPath, relationManifest([{
      id: 'keep-default',
      from_slug: from,
      to_slug: to,
      from_source_id: 'default',
      to_source_id: 'default',
      link_type: 'related_to',
      link_source: 'tana-relation-r2',
      guards: TRUE_GUARDS,
    }]));
    const origLog = console.log;
    const origErr = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
      await runGraphUsefulness(engine, [
        'relations', 'apply', manifestPath, '--source', 'wiki', '--apply', '--yes',
        '--receipt-out', join(dir, 'receipt.json'), '--json',
      ]);
      const links = await engine.executeRaw<{ from_source: string; to_source: string }>(
        `SELECT fp.source_id AS from_source, tp.source_id AS to_source
           FROM links l
           JOIN pages fp ON fp.id = l.from_page_id
           JOIN pages tp ON tp.id = l.to_page_id
          WHERE fp.slug = $1 AND tp.slug = $2
            AND fp.deleted_at IS NULL AND tp.deleted_at IS NULL`,
        [from, to],
      );
      expect(links).toEqual([{ from_source: 'default', to_source: 'default' }]);

      const oneFrom = 'topics/src-one-from';
      const oneTo = 'topics/src-one-to';
      await engine.putPage(oneFrom, { title: 'From', compiled_truth: 'one from', type: 'note' }, { sourceId: 'default' });
      await engine.putPage(oneTo, { title: 'To', compiled_truth: 'one to', type: 'note' }, { sourceId: 'wiki' });
      const onePath = join(dir, 'one.json');
      writeFileSync(onePath, relationManifest([{
        id: 'one-side',
        from_slug: oneFrom,
        to_slug: oneTo,
        from_source_id: 'default',
        link_type: 'related_to',
        link_source: 'tana-relation-r2',
        guards: TRUE_GUARDS,
      }]));
      await runGraphUsefulness(engine, [
        'relations', 'apply', onePath, '--source', 'wiki', '--apply', '--yes',
        '--receipt-out', join(dir, 'one-receipt.json'), '--json',
      ]);
      const oneLinks = await engine.executeRaw<{ from_source: string; to_source: string }>(
        `SELECT fp.source_id AS from_source, tp.source_id AS to_source
           FROM links l
           JOIN pages fp ON fp.id = l.from_page_id
           JOIN pages tp ON tp.id = l.to_page_id
          WHERE fp.slug = $1 AND tp.slug = $2
            AND fp.deleted_at IS NULL AND tp.deleted_at IS NULL`,
        [oneFrom, oneTo],
      );
      expect(oneLinks).toEqual([{ from_source: 'default', to_source: 'wiki' }]);
    } finally {
      console.log = origLog;
      console.error = origErr;
      process.exitCode = undefined;
      _resetCliExitVerdictForTests();
    }
  });

  test('flags after -- do not apply a relation manifest', async () => {
    const from = 'topics/term-from';
    const to = 'topics/term-to';
    await engine.putPage(from, { title: 'From', compiled_truth: 'term from', type: 'note' });
    await engine.putPage(to, { title: 'To', compiled_truth: 'term to', type: 'note' });
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-rel-term-'));
    const manifestPath = join(dir, 'manifest.json');
    writeFileSync(manifestPath, relationManifest([{
      id: 'term-1',
      from_slug: from,
      to_slug: to,
      link_type: 'related_to',
      link_source: 'tana-relation-r2',
      guards: TRUE_GUARDS,
    }]));
    const origLog = console.log;
    const origErr = console.error;
    let stdout = '';
    console.log = (...a: unknown[]) => { stdout += a.map(String).join(' ') + '\n'; };
    console.error = () => {};
    const original = engine.addLink.bind(engine);
    let calls = 0;
    engine.addLink = async (...args) => {
      calls += 1;
      return original(...args);
    };
    try {
      await runGraphUsefulness(engine, [
        'relations', 'apply', manifestPath, '--receipt-out', join(dir, 'hidden.json'), '--json',
        '--', '--apply', '--yes', '--dry-run',
      ]);
      expect(calls).toBe(0);
      const hidden = JSON.parse(stdout);
      expect(hidden.mode).toBe('dry-run');
      expect(hidden.applied).toBe(0);

      stdout = '';
      await runGraphUsefulness(engine, [
        'relations', 'apply', manifestPath, '--apply', '--yes', '--json',
        '--receipt-out', join(dir, 'real.json'),
        '--', '--dry-run',
      ]);
      expect(calls).toBe(1);
      const applied = JSON.parse(stdout);
      expect(applied.mode).toBe('apply');
      expect(applied.applied).toBe(1);
    } finally {
      engine.addLink = original;
      console.log = origLog;
      console.error = origErr;
      process.exitCode = undefined;
      _resetCliExitVerdictForTests();
    }
  });
});

describe('usefulness help before connect', () => {
  test('prints help without loading a brain', async () => {
    const dispatchSrc = readFileSync(join(import.meta.dir, '../src/commands/graph-usefulness-dispatch.ts'), 'utf8');
    const body = dispatchSrc.slice(dispatchSrc.indexOf('export async function dispatchGraphUsefulness'));
    const helpAt = body.indexOf('graphUsefulnessWantsHelp');
    const loadAt = body.indexOf('loadConfig()');
    const connectAt = body.indexOf('connectEngine()');
    expect(helpAt).toBeGreaterThan(-1);
    expect(helpAt).toBeLessThan(loadAt);
    expect(loadAt).toBeLessThan(connectAt);

    const origLog = console.log;
    const origExit = process.exit;
    let out = '';
    let connects = 0;
    console.log = (...a: unknown[]) => { out += a.map(String).join(' ') + '\n'; };
    process.exit = (() => { throw new Error('process.exit'); }) as typeof process.exit;
    try {
      for (const args of [['measure', '--help'], ['help'], ['--source', 'wiki', 'stats', '-h']]) {
        out = '';
        const handled = await dispatchGraphUsefulness(args, async () => {
          connects += 1;
          throw new Error('connect');
        });
        expect(handled).toBe(true);
        expect(out).toContain('DAV-6220 usefulness');
      }
      expect(connects).toBe(0);
    } finally {
      console.log = origLog;
      process.exit = origExit;
    }
  });
});
