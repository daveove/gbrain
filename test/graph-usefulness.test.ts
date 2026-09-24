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
import { canonicalSearchConfig, PROOF_EXPANSION_EXPANDER_ID, readProofSearchPin } from '../src/core/graph-usefulness/search-pin.ts';
import { __setEmbedTransportForTests, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { expandQuery } from '../src/core/search/expansion.ts';
import { awaitPendingSearchCacheWrites, hybridSearch, hybridSearchCached } from '../src/core/search/hybrid.ts';
import {
  clearIntentPatternConfigForTests,
  loadEngineIntentPatterns,
} from '../src/core/search/query-intent.ts';
import { resolveSearchMode } from '../src/core/search/mode.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { measureGraphUsefulness } from '../src/core/graph-usefulness/measure.ts';
import {
  applyRelationManifest,
  guardsAllLiteralTrue,
  loadRelationManifestFile,
  manifestSha256,
  MutationReceiptExistsError,
  _setBeforeGuardedLinkInsertForTests,
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
  citedReadwisePageCount,
  _setRetrievalProofSearchForTests,
  SlugOnlyProofNeedsSourceError,
} from '../src/core/graph-usefulness/retrieval-proof.ts';
import type { RelationManifest } from '../src/core/graph-usefulness/types.ts';
import { classifyJunkSlugs, slugLooksReadwise } from '../src/core/graph-usefulness/junk-classify.ts';

let engine: BrainEngine;

function failFingerprintOnCall(target: BrainEngine, which: number): () => void {
  const original = target.executeRaw;
  let fpCalls = 0;
  // Keep the receiver. A bound wrapper would run the guarded insert's
  // transaction statements on the outer connection and stall PGLite.
  target.executeRaw = async function(this: BrainEngine, sql, params, opts) {
    if (typeof sql === 'string' && sql.includes('zero_degree_pages')) {
      fpCalls += 1;
      if (fpCalls === which) throw new Error('simulated fingerprint failure');
    }
    return original.call(this, sql, params, opts);
  } as BrainEngine['executeRaw'];
  return () => { target.executeRaw = original; };
}

async function linkCount(target: BrainEngine, from: string, to: string): Promise<number> {
  const rows = await target.executeRaw<{ n: string }>(
    `SELECT count(*)::text AS n FROM links l
      JOIN pages fp ON fp.id = l.from_page_id
      JOIN pages tp ON tp.id = l.to_page_id
     WHERE fp.slug = $1 AND tp.slug = $2 AND fp.deleted_at IS NULL AND tp.deleted_at IS NULL`,
    [from, to],
  );
  return Number(rows[0]?.n ?? 0);
}

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

  test('unscoped degree and junk exclude archived sources', async () => {
    const baseline = await measureGraphUsefulness(engine);
    await engine.executeRaw(
      `INSERT INTO sources (id, name, archived) VALUES ('archmeas', 'archmeas', false)
       ON CONFLICT (id) DO UPDATE SET archived = false, name = 'archmeas'`,
    );
    const junk = 'topics/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    await engine.putPage(junk, {
      title: 'Junk', compiled_truth: 'archived junk slug', type: 'note',
    }, { sourceId: 'archmeas' });
    await engine.putPage('topics/archmeas-a', {
      title: 'Arch A', compiled_truth: 'archived degree a', type: 'note',
    }, { sourceId: 'archmeas' });
    await engine.putPage('topics/archmeas-b', {
      title: 'Arch B', compiled_truth: 'archived degree b', type: 'note',
    }, { sourceId: 'archmeas' });
    await engine.addLink(
      'topics/archmeas-a', 'topics/archmeas-b', 'ctx', 'related_to', 'manual',
      undefined, undefined,
      { fromSourceId: 'archmeas', toSourceId: 'archmeas' },
    );

    const live = await measureGraphUsefulness(engine);
    const uuidCount = (samples: { pattern: string; count: number; examples: string[] }[]) =>
      samples.find(s => s.pattern === 'uuid_blob');
    expect(live.active_pages).toBe(baseline.active_pages + 3);
    expect(live.avg_degree).not.toBe(baseline.avg_degree);
    expect(uuidCount(live.junk_slug_samples)?.examples).toContain(junk);
    expect(uuidCount(live.junk_slug_samples)?.count)
      .toBe((uuidCount(baseline.junk_slug_samples)?.count ?? 0) + 1);

    await engine.executeRaw(`UPDATE sources SET archived = true WHERE id = 'archmeas'`);
    const after = await measureGraphUsefulness(engine);
    expect(after.active_pages).toBe(baseline.active_pages);
    expect(after.avg_degree).toBe(baseline.avg_degree);
    expect(after.median_degree).toBe(baseline.median_degree);
    expect(after.zero_degree_pages).toBe(baseline.zero_degree_pages);
    expect(after.link_rows).toBe(baseline.link_rows);
    expect(uuidCount(after.junk_slug_samples)?.examples ?? []).not.toContain(junk);
    expect(uuidCount(after.junk_slug_samples)?.count ?? 0)
      .toBe(uuidCount(baseline.junk_slug_samples)?.count ?? 0);
    expect(after.fingerprint.active_pages).toBe(after.active_pages);
  });

  test('reads degree, junk, and fingerprint from one statement', async () => {
    const original = engine.executeRaw;
    const sqls: string[] = [];
    engine.executeRaw = async function(this: BrainEngine, sql, params, opts) {
      if (typeof sql === 'string') sqls.push(sql);
      return original.call(this, sql, params, opts);
    } as BrainEngine['executeRaw'];
    try {
      const m = await measureGraphUsefulness(engine);
      expect(sqls).toHaveLength(1);
      const sql = sqls[0]!;
      expect(sql).toContain('avg_degree');
      expect(sql).toContain('median_degree');
      expect(sql).toContain('zero_degree_pages');
      expect(sql).toContain('page_identities');
      expect(sql).toContain('source_archive');
      expect(sql).not.toContain('LIMIT 50000');
      const uuidCountSql = sql.match(
        /\(SELECT count\(\*\)::text FROM scoped_pages sp WHERE sp\.slug ~\* '[^']+'\) AS junk_uuid_blob_n/,
      )?.[0];
      expect(uuidCountSql).toBeTruthy();
      expect(uuidCountSql).not.toContain('LIMIT');
      expect(sql).toContain('LIMIT 3');
      expect(m.fingerprint.sha256).toHaveLength(64);
      expect(Number.isFinite(m.avg_degree)).toBe(true);
      expect(Number.isFinite(m.median_degree)).toBe(true);
    } finally {
      engine.executeRaw = original;
    }
  });

  test('counts junk patterns over the whole scoped corpus and caps only examples', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, archived) VALUES ('junkpar', 'junkpar', false)
       ON CONFLICT (id) DO UPDATE SET archived = false, name = 'junkpar'`,
    );
    const slugs = [
      'vendor/pnpm-store/pkg',
      'cache/.pnpm-store/a',
      'import/<span data-type=x>',
      'a/b/c/d/e/f/g/h',
      'a/b/c/d/e/f/g',
      'repo/.git/config',
      'repo/./keep',
      'repo/keep.',
      'plain/note',
      'u/00000000-0000-4000-8000-000000000001',
      'u/00000000-0000-4000-8000-000000000002',
      'u/00000000-0000-4000-8000-000000000003',
      'u/00000000-0000-4000-8000-000000000004',
      'zzz/00000000-0000-4000-8000-000000000099',
    ];
    try {
      for (const slug of slugs) {
        await engine.putPage(slug, {
          title: 'Junk parity', compiled_truth: 'junk parity body', type: 'note',
        }, { sourceId: 'junkpar' });
      }
      await engine.executeRaw(
        `INSERT INTO pages (source_id, slug, type, title)
         VALUES ('junkpar', 'Case/AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE', 'note', 'Upper UUID')`,
      );
      const measured = await measureGraphUsefulness(engine, { sourceId: 'junkpar' });
      const stored = await engine.executeRaw<{ slug: string }>(
        `SELECT p.slug FROM pages p
           JOIN sources s ON s.id = p.source_id AND NOT s.archived
          WHERE p.deleted_at IS NULL AND p.source_id = $1
          ORDER BY p.slug, p.source_id`,
        ['junkpar'],
      );
      const expected = classifyJunkSlugs(stored.map(r => r.slug));
      expect(measured.junk_slug_samples).toEqual(expected);
      const uuid = measured.junk_slug_samples.find(s => s.pattern === 'uuid_blob');
      expect(uuid?.count).toBeGreaterThan(uuid?.examples.length ?? 0);
      expect(uuid?.examples).toHaveLength(3);
      expect(uuid?.examples).not.toContain('zzz/00000000-0000-4000-8000-000000000099');
      expect(uuid?.count).toBe(6);
      expect(measured.junk_slug_samples.find(s => s.pattern === 'deep_path_noise')?.count).toBe(1);
      expect(measured.junk_slug_samples.find(s => s.pattern === 'dotfile_segment')?.examples)
        .not.toContain('repo/./keep');
    } finally {
      await engine.executeRaw(`DELETE FROM pages WHERE source_id = 'junkpar'`);
      await engine.executeRaw(`DELETE FROM sources WHERE id = 'junkpar'`);
    }
  });

  test('scoped degree counts cross-source edges in both directions', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, archived) VALUES
         ('degout', 'degout', false),
         ('degin', 'degin', false)
       ON CONFLICT (id) DO UPDATE SET archived = false, name = EXCLUDED.name`,
    );
    await engine.putPage('topics/deg-a', {
      title: 'Deg A', compiled_truth: 'degree page a', type: 'note',
    }, { sourceId: 'degout' });
    await engine.putPage('topics/deg-b', {
      title: 'Deg B', compiled_truth: 'degree page b', type: 'note',
    }, { sourceId: 'degin' });
    try {
      const before = await measureGraphUsefulness(engine, { sourceId: 'degout' });
      const fpBefore = await computeGraphFingerprint(engine, { sourceId: 'degout' });
      expect(before.zero_degree_pages).toBe(1);
      expect(before.fingerprint.zero_degree_pages).toBe(1);

      await engine.addLink(
        'topics/deg-a', 'topics/deg-b', 'out', 'related_to', 'manual',
        undefined, undefined,
        { fromSourceId: 'degout', toSourceId: 'degin' },
      );
      const outgoing = await measureGraphUsefulness(engine, { sourceId: 'degout' });
      const fpOutgoing = await computeGraphFingerprint(engine, { sourceId: 'degout' });
      expect(outgoing.zero_degree_pages).toBe(0);
      expect(outgoing.avg_degree).toBe(1);
      expect(outgoing.link_rows).toBe(before.link_rows + 1);
      expect(outgoing.valid_links).toBe(before.valid_links + 1);
      expect(outgoing.fingerprint.link_rows).toBe(fpBefore.link_rows);
      expect(outgoing.fingerprint.valid_links).toBe(fpBefore.valid_links);
      expect(outgoing.fingerprint.zero_degree_pages).toBe(fpBefore.zero_degree_pages);
      expect(fpOutgoing.sha256).toBe(fpBefore.sha256);
      expect(fpOutgoing.link_rows).toBe(fpBefore.link_rows);
      const incomingSide = await measureGraphUsefulness(engine, { sourceId: 'degin' });
      expect(incomingSide.zero_degree_pages).toBe(0);
      expect(incomingSide.avg_degree).toBe(1);
      expect(incomingSide.link_rows).toBe(1);
      expect(incomingSide.valid_links).toBe(1);

      await engine.executeRaw(
        `DELETE FROM links WHERE from_page_id IN (
           SELECT id FROM pages WHERE slug = 'topics/deg-a' AND source_id = 'degout'
         )`,
      );
      await engine.addLink(
        'topics/deg-b', 'topics/deg-a', 'mention', 'related_to', 'mentions',
        undefined, undefined,
        { fromSourceId: 'degin', toSourceId: 'degout' },
      );
      const mention = await measureGraphUsefulness(engine, { sourceId: 'degout' });
      const fpMention = await computeGraphFingerprint(engine, { sourceId: 'degout' });
      expect(mention.zero_degree_pages).toBe(0);
      expect(mention.avg_degree).toBe(1);
      expect(mention.link_rows).toBe(before.link_rows + 1);
      expect(mention.valid_links).toBe(before.valid_links + 1);
      expect(mention.fingerprint.link_rows).toBe(fpBefore.link_rows);
      expect(mention.fingerprint.valid_links).toBe(fpBefore.valid_links);
      expect(fpMention.sha256).toBe(fpBefore.sha256);
      expect(fpMention.link_rows).toBe(fpBefore.link_rows);
    } finally {
      await engine.executeRaw(`DELETE FROM pages WHERE source_id IN ('degout', 'degin')`);
      await engine.executeRaw(`DELETE FROM sources WHERE id IN ('degout', 'degin')`);
    }
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
    expect(findGraphUsefulnessFlagProblem([
      'relations', 'apply', 'm.json', '--apply', '--yes', '-x',
    ])).toEqual({ kind: 'unknown', flag: '-x' });
    expect(findGraphUsefulnessFlagProblem([
      'relations', 'apply', 'm.json', '--', '-x',
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
    const original = engine.addLink;
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

      code = -1;
      errors.length = 0;
      await expect(runGraphUsefulness(engine, [
        'relations', 'apply', 'manifest.json', '--apply', '--yes', '-x',
      ])).rejects.toBe(exitError);
      expect(code).toBe(1);
      expect(errors.some(line => line.includes('unknown flag -x'))).toBe(true);
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
    const origLog = console.log;
    console.log = () => {};
    try {
      await runGraphUsefulness(engine, [
        'relations', 'apply', '--limit=1', manifestPath, '--apply', '--yes', `--receipt-out=${receiptPath}`,
      ]);
      expect(await linkCount(engine, 'topics/lim-a', 'topics/lim-b')).toBe(1);
      expect(await linkCount(engine, 'topics/lim-a', 'topics/lim-c')).toBe(0);
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
      expect(receipt.counts.planned).toBe(1);
      expect(receipt.counts.applied).toBe(1);
      expect(receipt.mode).toBe('apply');
    } finally {
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
    await engine.putPage('topics/batch-d', { title: 'D', compiled_truth: 'd', type: 'note' });
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
          from_slug: 'topics/batch-d',
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
    let calls = 0;
    _setBeforeGuardedLinkInsertForTests(async () => {
      calls += 1;
      if (calls === 2) throw new Error('simulated batch failure');
    });
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
      _setBeforeGuardedLinkInsertForTests(null);
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

    const original = engine.addLink;
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
    const origAdd = engine.addLink;
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
    const original = engine.addLink;
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

  test('receipt rollback deletes only the inserted link id', async () => {
    await engine.putPage('topics/rb-id-a', { title: 'Rb A', compiled_truth: 'a', type: 'note' });
    await engine.putPage('topics/rb-id-b', { title: 'Rb B', compiled_truth: 'b', type: 'note' });
    const manifest = parseRelationManifest(JSON.stringify({
      manifest_version: 1,
      rows: [{
        id: 'rb-id-1',
        from_slug: 'topics/rb-id-a',
        to_slug: 'topics/rb-id-b',
        link_type: 'related_to',
        link_source: 'tana-relation-r2',
        context: 'manifest-row',
        guards: {
          exact_endpoint_match: true,
          source_relation_current: true,
          no_incident_edge: true,
          readwise_clear: true,
        },
      }],
    }));
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-rcpt-id-'));
    const receiptPath = join(dir, 'receipt.json');
    _setBeforeReceiptCommitForTests(async () => {
      await engine.addLink(
        'topics/rb-id-a',
        'topics/rb-id-b',
        'other-writer',
        'related_to',
        'tana-relation-r2',
      );
      unlinkSync(receiptPath);
      mkdirSync(receiptPath);
    });
    try {
      await expect(applyRelationManifest(engine, manifest, JSON.stringify(manifest), {
        apply: true,
        receiptPath,
      })).rejects.toThrow(/rolled back 1 applied link/);
      const rows = await engine.executeRaw<{ origin_null: boolean; context: string }>(
        `SELECT (l.origin_page_id IS NULL) AS origin_null, l.context
           FROM links l
           JOIN pages fp ON fp.id = l.from_page_id
           JOIN pages tp ON tp.id = l.to_page_id
          WHERE fp.slug = $1 AND tp.slug = $2
            AND fp.deleted_at IS NULL AND tp.deleted_at IS NULL
          ORDER BY l.context`,
        ['topics/rb-id-a', 'topics/rb-id-b'],
      );
      expect(rows).toEqual([{ origin_null: true, context: 'other-writer' }]);
    } finally {
      _setBeforeReceiptCommitForTests(null);
      rmSync(receiptPath, { recursive: true, force: true });
    }
  });

  test('receipt rollback leaves a concurrent update of the inserted link', async () => {
    await engine.putPage('topics/own-a', { title: 'Own A', compiled_truth: 'a', type: 'note' });
    await engine.putPage('topics/own-b', { title: 'Own B', compiled_truth: 'b', type: 'note' });
    const manifest = parseRelationManifest(JSON.stringify({
      manifest_version: 1,
      rows: [{
        id: 'own-1',
        from_slug: 'topics/own-a',
        to_slug: 'topics/own-b',
        link_type: 'related_to',
        link_source: 'tana-relation-r2',
        context: 'manifest-owned',
        guards: {
          exact_endpoint_match: true,
          source_relation_current: true,
          no_incident_edge: true,
          readwise_clear: true,
        },
      }],
    }));
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-rcpt-own-'));
    const receiptPath = join(dir, 'receipt.json');
    _setBeforeReceiptCommitForTests(async () => {
      await engine.addLink(
        'topics/own-a',
        'topics/own-b',
        'other-writer',
        'related_to',
        'tana-relation-r2',
        'topics/own-a',
        'notes',
        { fromSourceId: 'default', toSourceId: 'default', originSourceId: 'default' },
      );
      unlinkSync(receiptPath);
      mkdirSync(receiptPath);
    });
    try {
      await expect(applyRelationManifest(engine, manifest, JSON.stringify(manifest), {
        apply: true,
        receiptPath,
      })).rejects.toThrow(/left 1 concurrently updated link/);
      const rows = await engine.executeRaw<{ context: string; origin_field: string | null; n: string }>(
        `SELECT l.context, l.origin_field, count(*)::text AS n
           FROM links l
           JOIN pages fp ON fp.id = l.from_page_id
           JOIN pages tp ON tp.id = l.to_page_id
          WHERE fp.slug = $1 AND tp.slug = $2
            AND fp.deleted_at IS NULL AND tp.deleted_at IS NULL
          GROUP BY l.context, l.origin_field`,
        ['topics/own-a', 'topics/own-b'],
      );
      expect(rows).toEqual([{ context: 'other-writer', origin_field: 'notes', n: '1' }]);
    } finally {
      _setBeforeReceiptCommitForTests(null);
      rmSync(receiptPath, { recursive: true, force: true });
    }
  });

  test('rolls back applied links when the post-apply fingerprint fails', async () => {
    await engine.putPage('topics/fp-fail-a', { title: 'Fp A', compiled_truth: 'a', type: 'note' });
    await engine.putPage('topics/fp-fail-b', { title: 'Fp B', compiled_truth: 'b', type: 'note' });
    const manifest = parseRelationManifest(JSON.stringify({
      manifest_version: 1,
      rows: [{
        id: 'fp-fail-1',
        from_slug: 'topics/fp-fail-a',
        to_slug: 'topics/fp-fail-b',
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
    const receiptPath = join(mkdtempSync(join(tmpdir(), 'gbrain-fp-fail-')), 'receipt.json');
    const restore = failFingerprintOnCall(engine, 2);
    try {
      await expect(applyRelationManifest(engine, manifest, JSON.stringify(manifest), {
        apply: true,
        receiptPath,
      })).rejects.toThrow(/Graph fingerprint failed; rolled back 1 applied link/);
      expect(await linkCount(engine, 'topics/fp-fail-a', 'topics/fp-fail-b')).toBe(0);
      expect(existsSync(receiptPath)).toBe(false);
    } finally {
      restore();
    }
  });

  test('rolls back when the in-loop fingerprint fails after addLink throws', async () => {
    await engine.putPage('topics/fp-loop-a', { title: 'Loop A', compiled_truth: 'a', type: 'note' });
    await engine.putPage('topics/fp-loop-b', { title: 'Loop B', compiled_truth: 'b', type: 'note' });
    await engine.putPage('topics/fp-loop-c', { title: 'Loop C', compiled_truth: 'c', type: 'note' });
    await engine.putPage('topics/fp-loop-d', { title: 'Loop D', compiled_truth: 'd', type: 'note' });
    const manifest = parseRelationManifest(JSON.stringify({
      manifest_version: 1,
      rows: [
        {
          id: 'fp-loop-1',
          from_slug: 'topics/fp-loop-a',
          to_slug: 'topics/fp-loop-b',
          link_type: 'related_to',
          link_source: 'tana-relation-r2',
          guards: {
            exact_endpoint_match: true,
            source_relation_current: true,
            no_incident_edge: true,
            readwise_clear: true,
          },
        },
        {
          id: 'fp-loop-2',
          from_slug: 'topics/fp-loop-d',
          to_slug: 'topics/fp-loop-c',
          link_type: 'related_to',
          link_source: 'tana-relation-r2',
          guards: {
            exact_endpoint_match: true,
            source_relation_current: true,
            no_incident_edge: true,
            readwise_clear: true,
          },
        },
      ],
    }));
    const receiptPath = join(mkdtempSync(join(tmpdir(), 'gbrain-fp-loop-')), 'receipt.json');
    let calls = 0;
    _setBeforeGuardedLinkInsertForTests(async () => {
      calls += 1;
      if (calls === 2) throw new Error('simulated batch failure');
    });
    const restore = failFingerprintOnCall(engine, 2);
    try {
      await expect(applyRelationManifest(engine, manifest, JSON.stringify(manifest), {
        apply: true,
        receiptPath,
      })).rejects.toThrow(/simulated batch failure \(Graph fingerprint failed; rolled back 1 applied link/);
      expect(await linkCount(engine, 'topics/fp-loop-a', 'topics/fp-loop-b')).toBe(0);
      expect(existsSync(receiptPath)).toBe(false);
    } finally {
      _setBeforeGuardedLinkInsertForTests(null);
      restore();
    }
  });

  test('a concurrent edge under the no-edge lock is not overwritten or applied', async () => {
    await engine.putPage('topics/race-same-a', { title: 'Race A', compiled_truth: 'a', type: 'note' });
    await engine.putPage('topics/race-same-b', { title: 'Race B', compiled_truth: 'b', type: 'note' });
    await engine.putPage('topics/race-diff-a', { title: 'Race C', compiled_truth: 'c', type: 'note' });
    await engine.putPage('topics/race-diff-b', { title: 'Race D', compiled_truth: 'd', type: 'note' });

    const same = parseRelationManifest(JSON.stringify({
      manifest_version: 1,
      rows: [{
        id: 'race-same',
        from_slug: 'topics/race-same-a',
        to_slug: 'topics/race-same-b',
        link_type: 'related_to',
        link_source: 'tana-relation-r2',
        context: 'manifest-context',
        guards: TRUE_GUARDS,
      }],
    }));
    _setBeforeGuardedLinkInsertForTests(async (tx, row) => {
      await tx.addLink(
        row.from_slug,
        row.to_slug,
        'concurrent-context',
        row.link_type,
        row.link_source,
        row.from_slug,
        undefined,
        {
          fromSourceId: row.from_source_id ?? 'default',
          toSourceId: row.to_source_id ?? 'default',
          originSourceId: row.from_source_id ?? 'default',
        },
      );
    });
    try {
      const sameResult = await applyRelationManifest(engine, same, JSON.stringify(same), { apply: true });
      expect(sameResult.applied).toBe(0);
      expect(sameResult.outcomes[0]?.status).toBe('skipped_already_linked');
      expect(sameResult.outcomes[0]?.reason).toBe('incident edge already exists');
      const sameRows = await engine.executeRaw<{ link_type: string; context: string; n: string }>(
        `SELECT l.link_type, l.context, count(*)::text AS n
           FROM links l
           JOIN pages fp ON fp.id = l.from_page_id
           JOIN pages tp ON tp.id = l.to_page_id
          WHERE fp.slug = $1 AND tp.slug = $2
            AND fp.deleted_at IS NULL AND tp.deleted_at IS NULL
          GROUP BY l.link_type, l.context`,
        ['topics/race-same-a', 'topics/race-same-b'],
      );
      expect(sameRows).toEqual([{ link_type: 'related_to', context: 'concurrent-context', n: '1' }]);
    } finally {
      _setBeforeGuardedLinkInsertForTests(null);
    }

    const different = parseRelationManifest(JSON.stringify({
      manifest_version: 1,
      rows: [{
        id: 'race-diff',
        from_slug: 'topics/race-diff-a',
        to_slug: 'topics/race-diff-b',
        link_type: 'related_to',
        link_source: 'tana-relation-r2',
        context: 'manifest-context',
        guards: TRUE_GUARDS,
      }],
    }));
    _setBeforeGuardedLinkInsertForTests(async (tx, row) => {
      await tx.addLink(
        row.from_slug,
        row.to_slug,
        'other-edge',
        'mentions',
        'manual',
        row.from_slug,
        undefined,
        {
          fromSourceId: row.from_source_id ?? 'default',
          toSourceId: row.to_source_id ?? 'default',
          originSourceId: row.from_source_id ?? 'default',
        },
      );
    });
    try {
      const diffResult = await applyRelationManifest(engine, different, JSON.stringify(different), { apply: true });
      expect(diffResult.applied).toBe(0);
      expect(diffResult.outcomes[0]?.status).toBe('skipped_already_linked');
      const diffRows = await engine.executeRaw<{ link_type: string; link_source: string }>(
        `SELECT l.link_type, l.link_source
           FROM links l
           JOIN pages fp ON fp.id = l.from_page_id
           JOIN pages tp ON tp.id = l.to_page_id
          WHERE fp.slug = $1 AND tp.slug = $2
            AND fp.deleted_at IS NULL AND tp.deleted_at IS NULL
          ORDER BY l.link_type`,
        ['topics/race-diff-a', 'topics/race-diff-b'],
      );
      expect(diffRows).toEqual([{ link_type: 'mentions', link_source: 'manual' }]);
    } finally {
      _setBeforeGuardedLinkInsertForTests(null);
    }
  });

  test('no_incident_edge rejects when either endpoint has any incident edge', async () => {
    const row = (id: string, from: string, to: string) => parseRelationManifest(JSON.stringify({
      manifest_version: 1,
      rows: [{
        id,
        from_slug: from,
        to_slug: to,
        link_type: 'related_to',
        link_source: 'tana-relation-r2',
        guards: TRUE_GUARDS,
      }],
    }));
    const note = (slug: string, title: string) =>
      engine.putPage(slug, { title, compiled_truth: title, type: 'note' });

    await note('topics/inc-free-a', 'Free A');
    await note('topics/inc-free-b', 'Free B');
    const free = row('inc-free', 'topics/inc-free-a', 'topics/inc-free-b');
    const freeResult = await applyRelationManifest(engine, free, JSON.stringify(free), { apply: true });
    expect(freeResult.applied).toBe(1);

    await note('topics/inc-rev-a', 'Rev A');
    await note('topics/inc-rev-b', 'Rev B');
    await engine.addLink('topics/inc-rev-b', 'topics/inc-rev-a', 'ctx', 'related_to', 'manual');
    const rev = row('inc-rev', 'topics/inc-rev-a', 'topics/inc-rev-b');
    const revDry = await applyRelationManifest(engine, rev, JSON.stringify(rev), { apply: false });
    expect(revDry.outcomes[0]?.status).toBe('skipped_already_linked');
    expect(revDry.outcomes[0]?.reason).toBe('incident edge already exists');
    const revApply = await applyRelationManifest(engine, rev, JSON.stringify(rev), { apply: true });
    expect(revApply.applied).toBe(0);
    expect(await linkCount(engine, 'topics/inc-rev-a', 'topics/inc-rev-b')).toBe(0);

    await note('topics/inc-out-a', 'Out A');
    await note('topics/inc-out-b', 'Out B');
    await note('topics/inc-out-c', 'Out C');
    await engine.addLink('topics/inc-out-a', 'topics/inc-out-c', 'ctx', 'mentions', 'manual');
    const outgoing = row('inc-out', 'topics/inc-out-a', 'topics/inc-out-b');
    const outApply = await applyRelationManifest(engine, outgoing, JSON.stringify(outgoing), { apply: true });
    expect(outApply.applied).toBe(0);
    expect(outApply.outcomes[0]?.status).toBe('skipped_already_linked');
    expect(await linkCount(engine, 'topics/inc-out-a', 'topics/inc-out-b')).toBe(0);

    await note('topics/inc-in-a', 'In A');
    await note('topics/inc-in-b', 'In B');
    await note('topics/inc-in-c', 'In C');
    await engine.addLink('topics/inc-in-c', 'topics/inc-in-b', 'ctx', 'mentions', 'manual');
    const incoming = row('inc-in', 'topics/inc-in-a', 'topics/inc-in-b');
    const inApply = await applyRelationManifest(engine, incoming, JSON.stringify(incoming), { apply: true });
    expect(inApply.applied).toBe(0);
    expect(inApply.outcomes[0]?.status).toBe('skipped_already_linked');
    expect(await linkCount(engine, 'topics/inc-in-a', 'topics/inc-in-b')).toBe(0);

    await note('topics/inc-hook-rev-a', 'Hook Rev A');
    await note('topics/inc-hook-rev-b', 'Hook Rev B');
    const hookRev = row('inc-hook-rev', 'topics/inc-hook-rev-a', 'topics/inc-hook-rev-b');
    _setBeforeGuardedLinkInsertForTests(async (tx, manifestRow) => {
      await tx.addLink(
        manifestRow.to_slug,
        manifestRow.from_slug,
        'reverse-under-lock',
        'mentions',
        'manual',
        manifestRow.to_slug,
        undefined,
        {
          fromSourceId: manifestRow.to_source_id ?? 'default',
          toSourceId: manifestRow.from_source_id ?? 'default',
          originSourceId: manifestRow.to_source_id ?? 'default',
        },
      );
    });
    try {
      const hooked = await applyRelationManifest(engine, hookRev, JSON.stringify(hookRev), { apply: true });
      expect(hooked.applied).toBe(0);
      expect(hooked.outcomes[0]?.status).toBe('skipped_already_linked');
      expect(hooked.outcomes[0]?.reason).toBe('incident edge already exists');
      expect(await linkCount(engine, 'topics/inc-hook-rev-a', 'topics/inc-hook-rev-b')).toBe(0);
    } finally {
      _setBeforeGuardedLinkInsertForTests(null);
    }

    await note('topics/inc-hook-third-a', 'Hook Third A');
    await note('topics/inc-hook-third-b', 'Hook Third B');
    await note('topics/inc-hook-third-c', 'Hook Third C');
    const hookThird = row('inc-hook-third', 'topics/inc-hook-third-a', 'topics/inc-hook-third-b');
    _setBeforeGuardedLinkInsertForTests(async (tx, manifestRow) => {
      await tx.addLink(
        manifestRow.from_slug,
        'topics/inc-hook-third-c',
        'third-under-lock',
        'mentions',
        'manual',
        manifestRow.from_slug,
        undefined,
        {
          fromSourceId: manifestRow.from_source_id ?? 'default',
          toSourceId: 'default',
          originSourceId: manifestRow.from_source_id ?? 'default',
        },
      );
    });
    try {
      const hooked = await applyRelationManifest(engine, hookThird, JSON.stringify(hookThird), { apply: true });
      expect(hooked.applied).toBe(0);
      expect(hooked.outcomes[0]?.status).toBe('skipped_already_linked');
      expect(await linkCount(engine, 'topics/inc-hook-third-a', 'topics/inc-hook-third-b')).toBe(0);
    } finally {
      _setBeforeGuardedLinkInsertForTests(null);
    }
  });

  test('a source archived inside the insert transaction does not receive a link', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, archived) VALUES ('livesrc', 'livesrc', false)
       ON CONFLICT (id) DO UPDATE SET archived = false`,
    );
    const from = 'topics/live-from';
    const to = 'topics/live-to';
    await engine.putPage(from, { title: 'From', compiled_truth: 'live from', type: 'note' }, { sourceId: 'livesrc' });
    await engine.putPage(to, { title: 'To', compiled_truth: 'live to', type: 'note' }, { sourceId: 'livesrc' });
    const manifest = parseRelationManifest(JSON.stringify({
      manifest_version: 1,
      rows: [{
        id: 'live-row',
        from_slug: from,
        to_slug: to,
        from_source_id: 'livesrc',
        to_source_id: 'livesrc',
        link_type: 'related_to',
        link_source: 'tana-relation-r2',
        guards: TRUE_GUARDS,
      }],
    }));
    _setBeforeGuardedLinkInsertForTests(async (tx) => {
      await tx.executeRaw(`UPDATE sources SET archived = true WHERE id = 'livesrc'`);
    });
    try {
      await expect(applyRelationManifest(engine, manifest, JSON.stringify(manifest), {
        apply: true,
      })).rejects.toThrow(/Source "livesrc" not found or is archived/);
      expect(await linkCount(engine, from, to)).toBe(0);
      const still = await engine.executeRaw<{ archived: boolean | null }>(
        `SELECT archived FROM sources WHERE id = 'livesrc'`,
      );
      expect(still[0]?.archived).not.toBe(true);
    } finally {
      _setBeforeGuardedLinkInsertForTests(null);
    }
  });

  test('the receipt names a row before its link transaction commits', async () => {
    await engine.putPage('topics/dur-a', { title: 'Dur A', compiled_truth: 'a', type: 'note' });
    await engine.putPage('topics/dur-b', { title: 'Dur B', compiled_truth: 'b', type: 'note' });
    await engine.putPage('topics/dur-c', { title: 'Dur C', compiled_truth: 'c', type: 'note' });
    await engine.putPage('topics/dur-d', { title: 'Dur D', compiled_truth: 'd', type: 'note' });
    const manifest = parseRelationManifest(JSON.stringify({
      manifest_version: 1,
      rows: [
        {
          id: 'dur-1',
          from_slug: 'topics/dur-a',
          to_slug: 'topics/dur-b',
          link_type: 'related_to',
          link_source: 'tana-relation-r2',
          guards: TRUE_GUARDS,
        },
        {
          id: 'dur-2',
          from_slug: 'topics/dur-d',
          to_slug: 'topics/dur-c',
          link_type: 'related_to',
          link_source: 'tana-relation-r2',
          guards: TRUE_GUARDS,
        },
      ],
    }));
    const receiptPath = join(mkdtempSync(join(tmpdir(), 'gbrain-dur-')), 'receipt.json');
    const seen: string[] = [];
    _setBeforeGuardedLinkInsertForTests(async (_tx, row) => {
      const body = readFileSync(receiptPath, 'utf8');
      expect(body.trim().length).toBeGreaterThan(0);
      const receipt = JSON.parse(body) as {
        phase?: string;
        outcomes: Array<{ id: string; status: string }>;
      };
      expect(receipt.phase).toBe('in_progress');
      expect(receipt.outcomes.some(o => o.id === row.id && o.status === 'pending_commit')).toBe(true);
      seen.push(row.id);
      if (row.id === 'dur-2') throw new Error('simulated crash before second commit');
    });
    try {
      await expect(applyRelationManifest(engine, manifest, JSON.stringify(manifest), {
        apply: true,
        receiptPath,
      })).rejects.toThrow(/simulated crash before second commit/);
      expect(seen).toEqual(['dur-1', 'dur-2']);
      expect(await linkCount(engine, 'topics/dur-a', 'topics/dur-b')).toBe(1);
      expect(await linkCount(engine, 'topics/dur-d', 'topics/dur-c')).toBe(0);
      const saved = readFileSync(receiptPath, 'utf8');
      expect(saved.trim().length).toBeGreaterThan(0);
      const receipt = JSON.parse(saved) as { partial_failure?: boolean; outcomes: Array<{ id: string; status: string }> };
      expect(receipt.partial_failure).toBe(true);
      expect(receipt.outcomes.filter(o => o.status === 'applied').map(o => o.id)).toEqual(['dur-1']);
      expect(receipt.outcomes.some(o => o.status === 'pending_commit')).toBe(false);
    } finally {
      _setBeforeGuardedLinkInsertForTests(null);
    }
  });

  test('rejects non-string relation fields before any write', async () => {
    const guards = {
      exact_endpoint_match: true,
      source_relation_current: true,
      no_incident_edge: true,
      readwise_clear: true,
    };
    const base = {
      id: 'typed-1',
      from_slug: 'topics/typed-a',
      to_slug: 'topics/typed-b',
      link_type: 'related_to',
      link_source: 'manual',
      guards,
    };
    expect(() => parseRelationManifest(JSON.stringify({
      manifest_version: 1,
      rows: [{ ...base, link_type: 123 }],
    }))).toThrow(/link_type must be a non-empty string/);
    expect(() => parseRelationManifest(JSON.stringify({
      manifest_version: 1,
      rows: [{ ...base, from_slug: 1 }],
    }))).toThrow(/from_slug must be a non-empty string/);
    expect(() => parseRelationManifest(JSON.stringify({
      manifest_version: 1,
      rows: [base, { ...base, id: 'typed-2', from_source_id: 7 }],
    }))).toThrow(/from_source_id must be a string/);
    expect(() => parseRelationManifest(JSON.stringify({
      manifest_version: 1,
      rows: [{ ...base, context: true }],
    }))).toThrow(/context must be a string/);

    await engine.putPage('topics/typed-a', {
      title: 'Typed A', compiled_truth: 'typed a', type: 'note',
    });
    await engine.putPage('topics/typed-b', {
      title: 'Typed B', compiled_truth: 'typed b', type: 'note',
    });
    const bad = {
      manifest_version: 1,
      rows: [
        base,
        { ...base, id: 'typed-2', to_slug: 'topics/typed-c', link_type: 123 },
      ],
    };
    const receiptPath = join(mkdtempSync(join(tmpdir(), 'gbrain-typed-')), 'receipt.json');
    await expect(applyRelationManifest(
      engine,
      bad as unknown as RelationManifest,
      JSON.stringify(bad),
      { apply: true, receiptPath },
    )).rejects.toThrow(/link_type must be a non-empty string/);
    expect(await linkCount(engine, 'topics/typed-a', 'topics/typed-b')).toBe(0);
    expect(existsSync(receiptPath)).toBe(false);
  });

  test('rejects a manifest object that differs from the hashed bytes', async () => {
    await engine.putPage('topics/bind-a', {
      title: 'Bind A', compiled_truth: 'bind a', type: 'note',
    });
    await engine.putPage('topics/bind-b', {
      title: 'Bind B', compiled_truth: 'bind b', type: 'note',
    });
    await engine.putPage('topics/bind-c', {
      title: 'Bind C', compiled_truth: 'bind c', type: 'note',
    });
    const guards = {
      exact_endpoint_match: true,
      source_relation_current: true,
      no_incident_edge: true,
      readwise_clear: true,
    };
    const sealed = {
      manifest_version: 1,
      rows: [{
        id: 'bind-1',
        from_slug: 'topics/bind-a',
        to_slug: 'topics/bind-b',
        link_type: 'related_to',
        link_source: 'manual',
        guards,
      }],
    };
    const swapped = {
      ...sealed,
      rows: [{ ...sealed.rows[0], to_slug: 'topics/bind-c' }],
    };
    const receiptPath = join(mkdtempSync(join(tmpdir(), 'gbrain-bind-')), 'receipt.json');
    await expect(applyRelationManifest(
      engine,
      swapped as RelationManifest,
      JSON.stringify(sealed),
      { apply: true, receiptPath },
    )).rejects.toThrow(/does not match manifestRaw/);
    expect(await linkCount(engine, 'topics/bind-a', 'topics/bind-b')).toBe(0);
    expect(await linkCount(engine, 'topics/bind-a', 'topics/bind-c')).toBe(0);
    expect(existsSync(receiptPath)).toBe(false);
  });

  test('applies rows parsed from manifestRaw when the object matches', async () => {
    await engine.putPage('topics/bind-raw-a', {
      title: 'Bind Raw A', compiled_truth: 'bind raw a', type: 'note',
    });
    await engine.putPage('topics/bind-raw-b', {
      title: 'Bind Raw B', compiled_truth: 'bind raw b', type: 'note',
    });
    const raw = `${JSON.stringify({
      manifest_version: 1,
      rows: [{
        id: 'bind-raw-1',
        from_slug: 'topics/bind-raw-a',
        to_slug: 'topics/bind-raw-b',
        link_type: 'related_to',
        link_source: 'manual',
        guards: {
          exact_endpoint_match: true,
          source_relation_current: true,
          no_incident_edge: true,
          readwise_clear: true,
        },
      }],
    }, null, 2)}\n`;
    const manifest = parseRelationManifest(raw);
    expect(JSON.stringify(manifest)).not.toBe(raw);
    const receiptPath = join(mkdtempSync(join(tmpdir(), 'gbrain-bind-raw-')), 'receipt.json');
    const result = await applyRelationManifest(engine, manifest, raw, {
      apply: true,
      receiptPath,
    });
    expect(result.applied).toBe(1);
    expect(result.manifest_sha256).toBe(manifestSha256(raw));
    expect(await linkCount(engine, 'topics/bind-raw-a', 'topics/bind-raw-b')).toBe(1);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    expect(receipt.manifest_sha256).toBe(manifestSha256(raw));
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
  test('reads counts and identities in one statement', async () => {
    const original = engine.executeRaw;
    const fpSql: string[] = [];
    engine.executeRaw = async function(this: BrainEngine, sql, params, opts) {
      if (typeof sql === 'string' && sql.includes('zero_degree_pages')) fpSql.push(sql);
      return original.call(this, sql, params, opts);
    } as BrainEngine['executeRaw'];
    try {
      const fp = await computeGraphFingerprint(engine);
      expect(fpSql).toHaveLength(1);
      expect(fpSql[0]).toContain('page_identities');
      expect(fpSql[0]).toContain('link_identities');
      expect(fpSql[0]).toContain('corpus_revision');
      expect(fpSql[0]).toContain('content_chunks');
      expect(fpSql[0]).toContain('chunk_source');
      expect(fpSql[0]).toContain('emotional_weight');
      expect(fpSql[0]).toContain('effective_date');
      expect(fpSql[0]).toContain('FROM takes t');
      expect(fpSql[0]).toContain('page_aliases');
      expect(fpSql[0]).toContain('slug_aliases');
      expect(fpSql[0]).toContain('JOIN sources s ON s.id = p.source_id AND NOT s.archived');
      expect(fpSql[0]).toContain('source_archive');
      expect(fp.active_pages).toBeGreaterThan(0);
      expect(fp.sha256).toHaveLength(64);
    } finally {
      engine.executeRaw = original;
    }
  });

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

  test('changes sha256 when content, chunks, or embeddings change without graph identity changes', async () => {
    const slug = 'topics/corpus-rev';
    await engine.putPage(slug, { title: 'Rev', compiled_truth: 'body-v1', type: 'note' });
    await engine.upsertChunks(slug, [
      { chunk_index: 0, chunk_text: 'body-v1', chunk_source: 'compiled_truth' },
    ], { sourceId: 'default' });
    const before = await computeGraphFingerprint(engine);

    await engine.putPage(slug, { title: 'Rev', compiled_truth: 'body-v2', type: 'note' });
    const afterContent = await computeGraphFingerprint(engine);
    expect(afterContent.sha256).not.toBe(before.sha256);
    expect(afterContent.active_pages).toBe(before.active_pages);
    expect(afterContent.link_rows).toBe(before.link_rows);
    expect(afterContent.valid_links).toBe(before.valid_links);
    expect(afterContent.zero_degree_pages).toBe(before.zero_degree_pages);

    await engine.executeRaw(
      `UPDATE content_chunks SET chunk_text = 'chunk-rewritten'
        WHERE page_id = (SELECT id FROM pages WHERE slug = $1 AND source_id = 'default' AND deleted_at IS NULL)
          AND chunk_index = 0`,
      [slug],
    );
    const afterChunk = await computeGraphFingerprint(engine);
    expect(afterChunk.sha256).not.toBe(afterContent.sha256);
    expect(afterChunk.active_pages).toBe(before.active_pages);
    expect(afterChunk.link_rows).toBe(before.link_rows);

    await engine.executeRaw(
      `UPDATE content_chunks
          SET embedding = array_fill(0.25, ARRAY[1536])::vector,
              embedded_at = now()
        WHERE page_id = (SELECT id FROM pages WHERE slug = $1 AND source_id = 'default' AND deleted_at IS NULL)
          AND chunk_index = 0`,
      [slug],
    );
    const afterEmbed = await computeGraphFingerprint(engine);
    expect(afterEmbed.sha256).not.toBe(afterChunk.sha256);
    expect(afterEmbed.active_pages).toBe(before.active_pages);
    expect(afterEmbed.link_rows).toBe(before.link_rows);
    expect(retrievalProofMutationCount(afterChunk, afterEmbed)).toBeGreaterThan(0);

    await engine.executeRaw(
      `UPDATE content_chunks SET chunk_source = 'timeline'
        WHERE page_id = (SELECT id FROM pages WHERE slug = $1 AND source_id = 'default' AND deleted_at IS NULL)
          AND chunk_index = 0`,
      [slug],
    );
    const afterSource = await computeGraphFingerprint(engine);
    expect(afterSource.sha256).not.toBe(afterEmbed.sha256);
    expect(afterSource.active_pages).toBe(before.active_pages);
    expect(afterSource.link_rows).toBe(before.link_rows);
    expect(afterSource.valid_links).toBe(before.valid_links);
    expect(afterSource.zero_degree_pages).toBe(before.zero_degree_pages);
    expect(retrievalProofMutationCount(afterEmbed, afterSource)).toBeGreaterThan(0);
  });

  test('changes sha256 when ranking inputs change without content or graph identity changes', async () => {
    const slug = 'topics/rank-rev';
    await engine.putPage(slug, { title: 'Rank', compiled_truth: 'rank body', type: 'note' });
    const before = await computeGraphFingerprint(engine);
    const pageId = `(SELECT id FROM pages WHERE slug = '${slug}' AND source_id = 'default' AND deleted_at IS NULL)`;

    await engine.executeRaw(
      `UPDATE pages SET emotional_weight = 0.8 WHERE slug = $1 AND source_id = 'default' AND deleted_at IS NULL`,
      [slug],
    );
    const afterWeight = await computeGraphFingerprint(engine);
    expect(afterWeight.sha256).not.toBe(before.sha256);
    expect(afterWeight.active_pages).toBe(before.active_pages);
    expect(afterWeight.link_rows).toBe(before.link_rows);
    expect(afterWeight.valid_links).toBe(before.valid_links);
    expect(afterWeight.zero_degree_pages).toBe(before.zero_degree_pages);

    await engine.executeRaw(
      `UPDATE pages SET effective_date = '2020-01-15T00:00:00Z' WHERE slug = $1 AND source_id = 'default' AND deleted_at IS NULL`,
      [slug],
    );
    const afterDate = await computeGraphFingerprint(engine);
    expect(afterDate.sha256).not.toBe(afterWeight.sha256);
    expect(afterDate.active_pages).toBe(before.active_pages);
    expect(afterDate.link_rows).toBe(before.link_rows);

    await engine.executeRaw(
      `INSERT INTO takes (page_id, row_num, claim, kind, holder, weight, active)
       SELECT id, 1, 'a standing claim', 'fact', 'self', 0.5, true
       FROM pages WHERE slug = $1 AND source_id = 'default' AND deleted_at IS NULL`,
      [slug],
    );
    const afterTake = await computeGraphFingerprint(engine);
    expect(afterTake.sha256).not.toBe(afterDate.sha256);
    expect(afterTake.active_pages).toBe(before.active_pages);
    expect(afterTake.link_rows).toBe(before.link_rows);

    await engine.executeRaw(
      `UPDATE takes SET active = false WHERE page_id = ${pageId} AND row_num = 1`,
    );
    const afterInactive = await computeGraphFingerprint(engine);
    expect(afterInactive.sha256).not.toBe(afterTake.sha256);
    expect(afterInactive.link_rows).toBe(before.link_rows);

    await engine.executeRaw(
      `INSERT INTO page_aliases (source_id, alias_norm, slug) VALUES ('default', 'rank rev alias', $1)`,
      [slug],
    );
    const afterPageAlias = await computeGraphFingerprint(engine);
    expect(afterPageAlias.sha256).not.toBe(afterInactive.sha256);
    expect(afterPageAlias.active_pages).toBe(before.active_pages);

    await engine.executeRaw(
      `INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug) VALUES ('default', 'topics/rank-old', $1)`,
      [slug],
    );
    const afterSlugAlias = await computeGraphFingerprint(engine);
    expect(afterSlugAlias.sha256).not.toBe(afterPageAlias.sha256);
    expect(afterSlugAlias.active_pages).toBe(before.active_pages);
    expect(afterSlugAlias.link_rows).toBe(before.link_rows);
    expect(retrievalProofMutationCount(before, afterSlugAlias)).toBeGreaterThan(0);
  });

  test('excludes archived-source pages and changes when a source is archived', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, archived) VALUES ('archfp', 'archfp', false)
       ON CONFLICT (id) DO UPDATE SET archived = false, name = 'archfp'`,
    );
    await engine.putPage('topics/arch-fp-a', {
      title: 'Arch A', compiled_truth: 'archived corpus a', type: 'note',
    }, { sourceId: 'archfp' });
    await engine.putPage('topics/arch-fp-b', {
      title: 'Arch B', compiled_truth: 'archived corpus b', type: 'note',
    }, { sourceId: 'archfp' });
    await engine.addLink(
      'topics/arch-fp-a', 'topics/arch-fp-b', 'ctx', 'related_to', 'manual',
      undefined, undefined,
      { fromSourceId: 'archfp', toSourceId: 'archfp' },
    );
    const before = await computeGraphFingerprint(engine);
    const scopedBefore = await computeGraphFingerprint(engine, { sourceId: 'archfp' });
    const defaultBefore = await computeGraphFingerprint(engine, { sourceId: 'default' });
    expect(scopedBefore.active_pages).toBe(2);
    expect(scopedBefore.valid_links).toBeGreaterThan(0);
    expect(scopedBefore.link_rows).toBe(scopedBefore.valid_links);

    await engine.executeRaw(`UPDATE sources SET archived = true WHERE id = 'archfp'`);
    const after = await computeGraphFingerprint(engine);
    const scopedAfter = await computeGraphFingerprint(engine, { sourceId: 'archfp' });
    const defaultAfter = await computeGraphFingerprint(engine, { sourceId: 'default' });

    expect(scopedAfter.active_pages).toBe(0);
    expect(scopedAfter.link_rows).toBe(0);
    expect(scopedAfter.valid_links).toBe(0);
    expect(after.active_pages).toBe(before.active_pages - scopedBefore.active_pages);
    expect(after.link_rows).toBe(before.link_rows - scopedBefore.link_rows);
    expect(after.valid_links).toBe(before.valid_links - scopedBefore.valid_links);
    expect(after.sha256).not.toBe(before.sha256);
    expect(scopedAfter.sha256).not.toBe(scopedBefore.sha256);
    expect(defaultAfter.sha256).toBe(defaultBefore.sha256);
    expect(retrievalProofMutationCount(before, after)).toBeGreaterThan(0);
  });

  test('scoped fingerprint includes cross-source inbound ranking edges', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, archived) VALUES
         ('fp-wiki', 'fp-wiki', false),
         ('fp-notes', 'fp-notes', false)
       ON CONFLICT (id) DO UPDATE SET archived = false, name = EXCLUDED.name`,
    );
    await engine.putPage('topics/fp-wiki-target', {
      title: 'Wiki target', compiled_truth: 'scoped target', type: 'note',
    }, { sourceId: 'fp-wiki' });
    await engine.putPage('topics/fp-wiki-other', {
      title: 'Wiki other', compiled_truth: 'scoped other', type: 'note',
    }, { sourceId: 'fp-wiki' });
    await engine.putPage('topics/fp-notes-origin', {
      title: 'Notes origin', compiled_truth: 'foreign origin', type: 'note',
    }, { sourceId: 'fp-notes' });

    const wikiBefore = await computeGraphFingerprint(engine, { sourceId: 'fp-wiki' });
    const notesBefore = await computeGraphFingerprint(engine, { sourceId: 'fp-notes' });
    try {
      await engine.addLink(
        'topics/fp-notes-origin', 'topics/fp-wiki-target', 'cross', 'related_to', 'manual',
        undefined, undefined,
        { fromSourceId: 'fp-notes', toSourceId: 'fp-wiki' },
      );
      const wikiAfter = await computeGraphFingerprint(engine, { sourceId: 'fp-wiki' });
      const notesAfter = await computeGraphFingerprint(engine, { sourceId: 'fp-notes' });
      expect(wikiAfter.sha256).not.toBe(wikiBefore.sha256);
      expect(wikiAfter.active_pages).toBe(wikiBefore.active_pages);
      expect(wikiAfter.link_rows).toBe(wikiBefore.link_rows + 1);
      expect(wikiAfter.valid_links).toBe(wikiBefore.valid_links + 1);
      expect(wikiAfter.zero_degree_pages).toBe(wikiBefore.zero_degree_pages - 1);
      expect(retrievalProofMutationCount(wikiBefore, wikiAfter)).toBeGreaterThan(0);
      // The origin source's backlink ranking does not see its own outgoing edge.
      expect(notesAfter.sha256).toBe(notesBefore.sha256);
      expect(notesAfter.link_rows).toBe(notesBefore.link_rows);
      expect(notesAfter.valid_links).toBe(notesBefore.valid_links);

      await engine.addLink(
        'topics/fp-notes-origin', 'topics/fp-wiki-other', 'mention', 'related_to', 'mentions',
        undefined, undefined,
        { fromSourceId: 'fp-notes', toSourceId: 'fp-wiki' },
      );
      const wikiAfterMention = await computeGraphFingerprint(engine, { sourceId: 'fp-wiki' });
      expect(wikiAfterMention.sha256).toBe(wikiAfter.sha256);
      expect(wikiAfterMention.link_rows).toBe(wikiAfter.link_rows);
      expect(wikiAfterMention.valid_links).toBe(wikiAfter.valid_links);

      await engine.executeRaw(`UPDATE sources SET archived = true WHERE id = 'fp-notes'`);
      const wikiAfterArchive = await computeGraphFingerprint(engine, { sourceId: 'fp-wiki' });
      expect(wikiAfterArchive.sha256).toBe(wikiAfter.sha256);
      expect(wikiAfterArchive.link_rows).toBe(wikiAfter.link_rows);

      const target = await engine.getPage('topics/fp-wiki-target', { sourceId: 'fp-wiki' });
      const other = await engine.getPage('topics/fp-wiki-other', { sourceId: 'fp-wiki' });
      expect(target?.id).toBeDefined();
      expect(other?.id).toBeDefined();
      const counts = await engine.getBacklinkCounts([target!.id, other!.id]);
      expect(counts.get(target!.id)).toBe(1);
      expect(counts.get(other!.id)).toBe(0);
    } finally {
      await engine.executeRaw(`UPDATE sources SET archived = false WHERE id = 'fp-notes'`);
    }
  });

  test('archiving an empty source changes sha256 without changing counts', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, archived) VALUES ('emptysrc', 'emptysrc', false)
       ON CONFLICT (id) DO UPDATE SET archived = false, name = 'emptysrc'`,
    );
    const before = await computeGraphFingerprint(engine);
    await engine.executeRaw(`UPDATE sources SET archived = true WHERE id = 'emptysrc'`);
    const after = await computeGraphFingerprint(engine);
    expect(after.active_pages).toBe(before.active_pages);
    expect(after.link_rows).toBe(before.link_rows);
    expect(after.valid_links).toBe(before.valid_links);
    expect(after.zero_degree_pages).toBe(before.zero_degree_pages);
    expect(after.sha256).not.toBe(before.sha256);
  });

  test('folds search configuration into sha256 without changing counts', async () => {
    const plain = await computeGraphFingerprint(engine);
    const conservative = await computeGraphFingerprint(engine, { searchConfig: '{"mode":"conservative"}' });
    const tokenmax = await computeGraphFingerprint(engine, { searchConfig: '{"mode":"tokenmax"}' });
    const again = await computeGraphFingerprint(engine, { searchConfig: '{"mode":"conservative"}' });
    expect(conservative.sha256).toBe(again.sha256);
    expect(conservative.sha256).not.toBe(tokenmax.sha256);
    expect(conservative.sha256).not.toBe(plain.sha256);
    expect(conservative.active_pages).toBe(plain.active_pages);
    expect(conservative.link_rows).toBe(plain.link_rows);
    expect(conservative.valid_links).toBe(plain.valid_links);
    expect(conservative.zero_degree_pages).toBe(plain.zero_degree_pages);
    expect(retrievalProofMutationCount(conservative, tokenmax)).toBeGreaterThan(0);
    const knobs = resolveSearchMode({ mode: 'balanced' });
    const column = {
      name: 'embedding', type: 'vector' as const, dimensions: 1536, embeddingModel: 'openai:text-embedding-3-small',
    };
    expect(canonicalSearchConfig(knobs, column)).not.toBe(
      canonicalSearchConfig(knobs, { ...column, name: 'embedding_image' }),
    );
    expect(canonicalSearchConfig(knobs, column)).not.toBe(
      canonicalSearchConfig(resolveSearchMode({ mode: 'balanced', overrides: { expansion: true } }), column),
    );
    expect(canonicalSearchConfig(resolveSearchMode({ mode: 'conservative' }), column))
      .toContain('"expansion_expander":null');
    expect(canonicalSearchConfig(resolveSearchMode({ mode: 'tokenmax' }), column))
      .toContain(`"expansion_expander":"${PROOF_EXPANSION_EXPANDER_ID}"`);
    expect(expandQuery.name).toBe(PROOF_EXPANSION_EXPANDER_ID);
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
    expect(retrievalProofMutationCount(before, { ...before }, { watermarkChanged: true })).toBe(1);
    expect(retrievalProofMutationCount(before, { ...before }, { watermarkChanged: false })).toBe(0);
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

  test('surplus positionals on retrieval-proof are rejected before the proof is read', async () => {
    const proof = join(import.meta.dir, 'fixtures/graph-usefulness/sample-retrieval-proof.json');
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-proof-surplus-'));
    const missing = join(dir, 'missing.json');
    const out = join(dir, 'receipt.json');
    const origLog = console.log;
    const origErr = console.error;
    const errors: string[] = [];
    console.log = () => {};
    console.error = (...a: unknown[]) => { errors.push(a.map(String).join(' ')); };
    try {
      await runGraphUsefulness(engine, [
        'retrieval-proof', 'run', proof, 'unexpected',
        '--out', out, '--source', 'not-a-real-source',
      ]);
      expect(currentExitCode()).toBe(2);
      expect(errors.join('\n')).toContain('Unexpected argument: unexpected');
      expect(errors.join('\n')).not.toMatch(/not found|archived/i);
      expect(existsSync(out)).toBe(false);

      errors.length = 0;
      _resetCliExitVerdictForTests();
      await runGraphUsefulness(engine, [
        'retrieval-proof', 'run', missing, 'unexpected', '--out', out,
      ]);
      expect(currentExitCode()).toBe(2);
      expect(errors.join('\n')).toContain('Unexpected argument: unexpected');
      expect(errors.join('\n')).not.toMatch(/ENOENT|no such file|not found/i);
      expect(existsSync(out)).toBe(false);

      errors.length = 0;
      _resetCliExitVerdictForTests();
      await runGraphUsefulness(engine, [
        'retrieval-proof', 'run', proof, '--', '--out', out,
      ]);
      expect(currentExitCode()).toBe(2);
      expect(errors.join('\n')).toContain('Unexpected arguments: --out');
      expect(existsSync(out)).toBe(false);
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
    const original = engine.executeRaw;
    let fpCalls = 0;
    let busy = false;
    engine.executeRaw = async function(this: BrainEngine, sql, params, opts) {
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
      return original.call(this, sql, params, opts);
    } as BrainEngine['executeRaw'];
    try {
      const result = await runRetrievalProof(engine, manifest, { sourceId: 'default' });
      expect(result.fingerprint_before.sha256).not.toBe(result.fingerprint_after.sha256);
      expect(result.passed).toBe(false);
      expect(result.checks.production_mutations).toBeGreaterThan(0);
    } finally {
      engine.executeRaw = original;
    }
  });

  test('a backlink added and removed during a question fails the proof', async () => {
    const from = 'topics/revert-from';
    const to = 'topics/revert-to';
    await engine.putPage(from, { title: 'From', compiled_truth: 'revert from', type: 'note' });
    await engine.putPage(to, { title: 'To', compiled_truth: 'revert to', type: 'note' });
    _setRetrievalProofSearchForTests(async () => {
      await engine.addLink(from, to, 'boost', 'related_to', 'manual');
      const removed = await engine.removeLink(from, to, 'related_to', 'manual');
      expect(removed).toBe(1);
      return [{ slug: to, source_id: 'default' }];
    });
    try {
      const result = await runRetrievalProof(engine, {
        proof_version: 2,
        questions: [
          { id: 'reverted-link', query: 'revert boost', relevant_slugs: [to] },
        ],
      }, { sourceId: 'default' });
      expect(result.questions.map(q => q.score)).toEqual(['pass']);
      expect(result.fingerprint_before.sha256).toBe(result.fingerprint_after.sha256);
      expect(result.fingerprint_before.link_rows).toBe(result.fingerprint_after.link_rows);
      expect(result.fingerprint_before.active_pages).toBe(result.fingerprint_after.active_pages);
      expect(result.checks.production_mutations).toBeGreaterThan(0);
      expect(result.passed).toBe(false);
      expect(await linkCount(engine, from, to)).toBe(0);
    } finally {
      _setRetrievalProofSearchForTests(null);
    }
  });

  test('a content rewrite during the proof counts as a mutation when identities stay put', async () => {
    const slug = 'topics/proof-corpus';
    await engine.putPage(slug, { title: 'Proof corpus', compiled_truth: 'before rewrite', type: 'note' });
    const raw = readFileSync(join(import.meta.dir, 'fixtures/graph-usefulness/sample-retrieval-proof.json'), 'utf8');
    const manifest = parseRetrievalProofManifest(raw);
    const original = engine.executeRaw;
    let fpCalls = 0;
    let busy = false;
    engine.executeRaw = async function(this: BrainEngine, sql, params, opts) {
      if (!busy && typeof sql === 'string' && sql.includes('zero_degree_pages')) {
        fpCalls += 1;
        if (fpCalls === 2) {
          busy = true;
          try {
            await engine.putPage(slug, {
              title: 'Proof corpus',
              compiled_truth: 'rewritten while the proof was running',
              type: 'note',
            });
          } finally {
            busy = false;
          }
        }
      }
      return original.call(this, sql, params, opts);
    } as BrainEngine['executeRaw'];
    try {
      const result = await runRetrievalProof(engine, manifest, { sourceId: 'default' });
      expect(result.fingerprint_after.active_pages).toBe(result.fingerprint_before.active_pages);
      expect(result.fingerprint_after.link_rows).toBe(result.fingerprint_before.link_rows);
      expect(result.fingerprint_after.valid_links).toBe(result.fingerprint_before.valid_links);
      expect(result.fingerprint_before.sha256).not.toBe(result.fingerprint_after.sha256);
      expect(result.passed).toBe(false);
      expect(result.checks.production_mutations).toBeGreaterThan(0);
    } finally {
      engine.executeRaw = original;
    }
  });

  test('pins search config for every question and fingerprints a live change', async () => {
    await engine.setConfig('search.mode', 'conservative');
    await engine.setConfig('search.expansion', 'true');
    const seen: Array<{ mode?: string; expansion?: boolean; column?: string } | undefined> = [];
    _setRetrievalProofSearchForTests(async (_eng, _query, opts) => {
      seen.push(opts._pinnedSearch
        ? {
          mode: opts._pinnedSearch.mode,
          expansion: opts._pinnedSearch.overrides.expansion,
          column: opts._pinnedSearch.embeddingColumn.name,
        }
        : undefined);
      if (seen.length === 1) {
        await engine.setConfig('search.mode', 'tokenmax');
        await engine.setConfig('search.expansion', 'false');
        await engine.setConfig('search_embedding_column', 'embedding_image');
      }
      return [{ slug: 'topics/parent-note', source_id: 'default' }];
    });
    try {
      const beforePin = await readProofSearchPin(engine);
      const result = await runRetrievalProof(engine, {
        proof_version: 2,
        questions: [
          { id: 'q1', query: 'one', relevant_slugs: ['topics/parent-note'] },
          { id: 'q2', query: 'two', relevant_slugs: ['topics/parent-note'] },
        ],
      }, { sourceId: 'default' });
      const afterPin = await readProofSearchPin(engine);
      expect(seen).toHaveLength(2);
      expect(seen[0]).toEqual(seen[1]);
      expect(seen[0]?.mode).toBe('conservative');
      expect(seen[0]?.expansion).toBe(true);
      expect(seen[0]?.column).toBe('embedding');
      expect(seen[1]?.column).toBe('embedding');
      expect(beforePin.canonical).not.toBe(afterPin.canonical);
      expect(afterPin.canonical).toContain('embedding_image');
      expect(afterPin.mode).toBe('tokenmax');
      expect(result.questions.map(q => q.score)).toEqual(['pass', 'pass']);
      expect(result.fingerprint_before.sha256).not.toBe(result.fingerprint_after.sha256);
      expect(result.fingerprint_before.sha256).toBe(
        (await computeGraphFingerprint(engine, { searchConfig: beforePin.canonical })).sha256,
      );
      expect(result.fingerprint_after.sha256).toBe(
        (await computeGraphFingerprint(engine, { searchConfig: afterPin.canonical })).sha256,
      );
      expect(result.checks.production_mutations).toBeGreaterThan(0);
      expect(result.passed).toBe(false);
      expect(await engine.getConfig('search.mode')).toBe('tokenmax');
    } finally {
      _setRetrievalProofSearchForTests(null);
      await engine.unsetConfig('search.mode');
      await engine.unsetConfig('search.expansion');
      await engine.unsetConfig('search_embedding_column');
    }
  });

  test('pins adaptive return and intent patterns and fingerprints a live change', async () => {
    await engine.setConfig('search.adaptive_return', 'false');
    await engine.setConfig('search.adaptive_return_entity_max', '2');
    await engine.setConfig('search.intent_patterns', '{"salience_on":["never-match-xyz"]}');
    const seen: Array<{ enabled?: boolean; entityMax?: number; patterns?: string | null }> = [];
    _setRetrievalProofSearchForTests(async (_eng, _query, opts) => {
      seen.push({
        enabled: opts._pinnedSearch?.adaptiveReturn.enabled,
        entityMax: opts._pinnedSearch?.adaptiveReturn.entityMax,
        patterns: opts._pinnedSearch?.intentPatterns ?? null,
      });
      if (seen.length === 1) {
        await engine.setConfig('search.adaptive_return', 'true');
        await engine.setConfig('search.adaptive_return_entity_max', '1');
        await engine.setConfig('search.intent_patterns', '{"salience_on":["always-match-xyz"]}');
      }
      return [{ slug: 'topics/parent-note', source_id: 'default' }];
    });
    try {
      const beforePin = await readProofSearchPin(engine);
      const result = await runRetrievalProof(engine, {
        proof_version: 2,
        questions: [
          { id: 'q1', query: 'one', relevant_slugs: ['topics/parent-note'] },
          { id: 'q2', query: 'two', relevant_slugs: ['topics/parent-note'] },
        ],
      }, { sourceId: 'default' });
      const afterPin = await readProofSearchPin(engine);
      expect(seen).toHaveLength(2);
      expect(seen[0]).toEqual(seen[1]);
      expect(seen[0]?.patterns).toBe(beforePin.intentPatterns);
      expect(seen[0]?.enabled).toBe(beforePin.adaptiveReturn.enabled);
      expect(seen[0]?.entityMax).toBe(beforePin.adaptiveReturn.entityMax);
      expect(beforePin.canonical).toContain('never-match-xyz');
      expect(beforePin.canonical).not.toBe(afterPin.canonical);
      expect(afterPin.canonical).toContain('always-match-xyz');
      expect(afterPin.intentPatterns).toContain('always-match-xyz');
      expect(afterPin.canonical).toContain('"search.adaptive_return":"true"');
      expect(result.fingerprint_before.sha256).not.toBe(result.fingerprint_after.sha256);
      expect(result.checks.production_mutations).toBeGreaterThan(0);
      expect(result.passed).toBe(false);
    } finally {
      _setRetrievalProofSearchForTests(null);
      await engine.unsetConfig('search.adaptive_return');
      await engine.unsetConfig('search.adaptive_return_entity_max');
      await engine.unsetConfig('search.intent_patterns');
    }
  });

  test('pinned hybrid search does not reread adaptive return or intent patterns', async () => {
    await engine.setConfig('search.adaptive_return', 'true');
    await engine.setConfig('search.intent_patterns', '{"entity":["parent"]}');
    const pin = await readProofSearchPin(engine);
    const originalGet = engine.getConfig.bind(engine);
    const originalAll = engine.getAllConfig.bind(engine);
    const seen: string[] = [];
    let allCalls = 0;
    engine.getConfig = async (key: string) => {
      seen.push(key);
      return originalGet(key);
    };
    engine.getAllConfig = async () => {
      allCalls += 1;
      return originalAll();
    };
    try {
      await hybridSearch(engine, 'parent note', {
        limit: 3,
        sourceId: 'default',
        _pinnedSearch: {
          mode: pin.mode,
          overrides: pin.overrides,
          embeddingColumn: pin.embeddingColumn,
          adaptiveReturn: pin.adaptiveReturn,
          intentPatterns: pin.intentPatterns,
          embeddingMultimodalModel: pin.embeddingMultimodalModel,
        },
      });
      expect(seen).not.toContain('search.intent_patterns');
      expect(seen).not.toContain('search.adaptive_return');
      expect(seen).not.toContain('search.adaptive_return_entity_max');
      expect(seen).not.toContain('search.mode');
      expect(allCalls).toBe(0);
    } finally {
      engine.getConfig = originalGet;
      engine.getAllConfig = originalAll;
      await engine.unsetConfig('search.adaptive_return');
      await engine.unsetConfig('search.intent_patterns');
    }
  });

  test('wires expandQuery when pinned retrieval enables expansion and omits it when expansion is off', async () => {
    const manifest = {
      proof_version: 2,
      questions: [
        { id: 'q1', query: 'parent note topic', relevant_slugs: ['topics/parent-note'] },
        { id: 'q2', query: 'child note topic', relevant_slugs: ['topics/child-note'] },
      ],
    };
    const seen: Array<typeof expandQuery | undefined> = [];
    _setRetrievalProofSearchForTests(async (_eng, _query, opts) => {
      seen.push(opts.expandFn);
      return [{ slug: 'topics/parent-note', source_id: 'default' }];
    });
    try {
      await engine.setConfig('search.mode', 'conservative');
      await engine.unsetConfig('search.expansion');
      const offPin = await readProofSearchPin(engine);
      expect(offPin.canonical).toContain('"expansion_expander":null');
      await runRetrievalProof(engine, manifest, { sourceId: 'default' });
      expect(seen).toEqual([undefined, undefined]);

      await engine.setConfig('search.mode', 'tokenmax');
      const modePin = await readProofSearchPin(engine);
      expect(modePin.canonical).toContain(`"expansion_expander":"${PROOF_EXPANSION_EXPANDER_ID}"`);
      expect(modePin.canonical).not.toBe(offPin.canonical);
      expect((await computeGraphFingerprint(engine, { searchConfig: offPin.canonical })).sha256)
        .not.toBe((await computeGraphFingerprint(engine, { searchConfig: modePin.canonical })).sha256);
      seen.length = 0;
      await runRetrievalProof(engine, manifest, { sourceId: 'default' });
      expect(seen).toEqual([expandQuery, expandQuery]);

      await engine.setConfig('search.mode', 'conservative');
      await engine.setConfig('search.expansion', 'true');
      seen.length = 0;
      let flipped = false;
      _setRetrievalProofSearchForTests(async (_eng, _query, opts) => {
        seen.push(opts.expandFn);
        if (!flipped) {
          flipped = true;
          await engine.setConfig('search.expansion', 'false');
        }
        return [{ slug: 'topics/parent-note', source_id: 'default' }];
      });
      const before = await readProofSearchPin(engine);
      const result = await runRetrievalProof(engine, manifest, { sourceId: 'default' });
      const after = await readProofSearchPin(engine);
      expect(seen).toEqual([expandQuery, expandQuery]);
      expect(before.canonical).toContain(`"expansion_expander":"${PROOF_EXPANSION_EXPANDER_ID}"`);
      expect(after.canonical).toContain('"expansion_expander":null');
      expect(result.fingerprint_before.sha256).not.toBe(result.fingerprint_after.sha256);
      expect(result.passed).toBe(false);
    } finally {
      _setRetrievalProofSearchForTests(null);
      await engine.unsetConfig('search.mode');
      await engine.unsetConfig('search.expansion');
    }
  });

  test('rejects a question without a non-empty id and query', async () => {
    const proof = (question: Record<string, unknown>) => JSON.stringify({
      proof_version: 2,
      questions: [question],
    });
    const relevant = { relevant_slugs: ['topics/parent-note'] };
    expect(() => parseRetrievalProofManifest(proof({ query: 'parent', ...relevant })))
      .toThrow(/non-empty string id/);
    expect(() => parseRetrievalProofManifest(proof({ id: '', query: 'parent', ...relevant })))
      .toThrow(/non-empty string id/);
    expect(() => parseRetrievalProofManifest(proof({ id: 1, query: 'parent', ...relevant })))
      .toThrow(/non-empty string id/);
    expect(() => parseRetrievalProofManifest(proof({ id: 'q-empty', query: '', ...relevant })))
      .toThrow(/Question q-empty: query must be a non-empty string/);
    expect(() => parseRetrievalProofManifest(proof({ id: 'q-missing', ...relevant })))
      .toThrow(/Question q-missing: query must be a non-empty string/);
    expect(() => parseRetrievalProofManifest(proof({ id: 'q-type', query: 1, ...relevant })))
      .toThrow(/Question q-type: query must be a non-empty string/);

    let searches = 0;
    _setRetrievalProofSearchForTests(async () => {
      searches += 1;
      return [{ slug: 'topics/parent-note', source_id: 'default' }];
    });
    try {
      await expect(runRetrievalProof(engine, {
        proof_version: 2,
        questions: [{ id: 'q-run', query: '', ...relevant } as never],
      }, { sourceId: 'default' })).rejects.toThrow(/Question q-run: query must be a non-empty string/);
      expect(searches).toBe(0);
    } finally {
      _setRetrievalProofSearchForTests(null);
    }
  });

  test('scores a warm production cache hit instead of a live recompute', async () => {
    const slug = 'topics/cache-proof-page';
    const query = 'cache proof sealed unique phrase';
    const dim = 1536;
    const priorMode = await engine.getConfig('search.mode');
    await engine.setConfig('search.mode', 'conservative');
    await engine.putPage(slug, {
      title: 'Cache Proof Page',
      compiled_truth: query,
      type: 'note',
    });
    await engine.upsertChunks(slug, [
      { chunk_index: 0, chunk_text: query, chunk_source: 'compiled_truth' },
    ], { sourceId: 'default' });
    await engine.executeRaw(
      `UPDATE content_chunks
          SET embedding = array_fill(0.25, ARRAY[${dim}])::vector,
              embedded_at = now()
        WHERE page_id = (SELECT id FROM pages WHERE slug = $1 AND source_id = 'default' AND deleted_at IS NULL)
          AND chunk_index = 0`,
      [slug],
    );
    configureGateway({
      embedding_model: 'openai:text-embedding-3-small',
      embedding_dimensions: dim,
      env: { OPENAI_API_KEY: 'sk-test-cache-proof' },
    });
    __setEmbedTransportForTests((async (opts: { values: string[] }) => ({
      embeddings: opts.values.map(() => new Array(dim).fill(0.25)),
    })) as never);
    const manifest = {
      proof_version: 2 as const,
      questions: [{ id: 'q-cache', query, relevant_slugs: [slug] }],
    };
    try {
      const first = await runRetrievalProof(engine, manifest, { sourceId: 'default' });
      expect(first.questions[0]?.score).toBe('pass');
      expect(first.passed).toBe(true);
      await awaitPendingSearchCacheWrites();
      const cached = await engine.executeRaw<{ n: string }>(
        `SELECT count(*)::text AS n FROM query_cache WHERE query_text = $1`,
        [query],
      );
      expect(Number(cached[0]?.n ?? 0)).toBeGreaterThan(0);
      await engine.executeRaw(
        `UPDATE query_cache
            SET results = $1::text::jsonb
          WHERE query_text = $2`,
        [JSON.stringify([{
          slug: 'topics/cache-decoy',
          source_id: 'default',
          score: 1,
          page_id: 1,
          chunk_text: 'decoy',
          chunk_index: 0,
          chunk_id: 0,
        }]), query],
      );
      const second = await runRetrievalProof(engine, manifest, { sourceId: 'default' });
      expect(second.questions[0]?.top_slugs).toEqual(['topics/cache-decoy']);
      expect(second.questions[0]?.score).toBe('fail');
      expect(second.checks.production_mutations).toBe(0);
      expect(second.passed).toBe(false);
    } finally {
      __setEmbedTransportForTests(null);
      resetGateway();
      _setRetrievalProofSearchForTests(null);
      if (priorMode == null) await engine.unsetConfig('search.mode');
      else await engine.setConfig('search.mode', priorMode);
      await engine.executeRaw(`DELETE FROM query_cache WHERE query_text = $1`, [query]);
      await engine.executeRaw(
        `DELETE FROM pages WHERE slug = $1 AND source_id = 'default'`,
        [slug],
      );
    }
  });

  test('cached lookup keys follow the proof pin, not the intent-pattern TTL', async () => {
    const slug = 'topics/pin-cache-page';
    const query = 'pin cache key sealed unique phrase';
    const dim = 1536;
    const stalePatterns = '{"salience_on":["never-match-stale-pin"]}';
    const freshPatterns = '{"salience_on":["never-match-fresh-pin"]}';
    clearIntentPatternConfigForTests();
    await engine.setConfig('search.intent_patterns', stalePatterns);
    const warmed = await loadEngineIntentPatterns(engine);
    expect(warmed.raw).toBe(stalePatterns);
    await engine.setConfig('search.intent_patterns', freshPatterns);
    const stillStale = await loadEngineIntentPatterns(engine);
    expect(stillStale.raw).toBe(stalePatterns);
    const pin = await readProofSearchPin(engine);
    expect(pin.intentPatterns).toBe(freshPatterns);
    await engine.putPage(slug, {
      title: 'Pin Cache Page',
      compiled_truth: query,
      type: 'note',
    });
    await engine.upsertChunks(slug, [
      { chunk_index: 0, chunk_text: query, chunk_source: 'compiled_truth' },
    ], { sourceId: 'default' });
    await engine.executeRaw(
      `UPDATE content_chunks
          SET embedding = array_fill(0.25, ARRAY[${dim}])::vector,
              embedded_at = now()
        WHERE page_id = (SELECT id FROM pages WHERE slug = $1 AND source_id = 'default' AND deleted_at IS NULL)
          AND chunk_index = 0`,
      [slug],
    );
    configureGateway({
      embedding_model: 'openai:text-embedding-3-small',
      embedding_dimensions: dim,
      env: { OPENAI_API_KEY: 'sk-test-pin-cache' },
    });
    __setEmbedTransportForTests((async (opts: { values: string[] }) => ({
      embeddings: opts.values.map(() => new Array(dim).fill(0.25)),
    })) as never);
    const searchWith = (intentPatterns: string, mode?: string) => hybridSearchCached(engine, query, {
      limit: 3,
      sourceId: 'default',
      _pinnedSearch: {
        mode: mode ?? pin.mode,
        overrides: pin.overrides,
        embeddingColumn: pin.embeddingColumn,
        adaptiveReturn: pin.adaptiveReturn,
        intentPatterns,
        embeddingMultimodalModel: pin.embeddingMultimodalModel,
      },
    });
    const storedHash = async () => {
      const rows = await engine.executeRaw<{ knobs_hash: string }>(
        `SELECT knobs_hash FROM query_cache WHERE query_text = $1`,
        [query],
      );
      return rows[0]?.knobs_hash ?? '';
    };
    try {
      await searchWith(stalePatterns);
      await awaitPendingSearchCacheWrites();
      const staleHash = await storedHash();
      expect(staleHash).not.toBe('');
      await engine.executeRaw(`DELETE FROM query_cache WHERE query_text = $1`, [query]);

      await searchWith(freshPatterns);
      await awaitPendingSearchCacheWrites();
      const freshHash = await storedHash();
      expect(freshHash).not.toBe('');
      expect(freshHash).not.toBe(staleHash);

      await engine.executeRaw(`DELETE FROM query_cache WHERE query_text = $1`, [query]);
      const otherMode = pin.mode === 'tokenmax' ? 'conservative' : 'tokenmax';
      await searchWith(freshPatterns, otherMode);
      await awaitPendingSearchCacheWrites();
      const modeHash = await storedHash();
      expect(modeHash).not.toBe('');
      expect(modeHash).not.toBe(freshHash);

      await engine.executeRaw(
        `UPDATE query_cache SET knobs_hash = $1, results = $2::text::jsonb WHERE query_text = $3`,
        [staleHash, JSON.stringify([{
          slug: 'topics/stale-pattern-decoy',
          source_id: 'default',
          score: 1,
          page_id: 1,
          chunk_text: 'decoy',
          chunk_index: 0,
          chunk_id: 0,
        }]), query],
      );
      const freshHit = await searchWith(freshPatterns);
      expect(freshHit.map(h => h.slug)).not.toContain('topics/stale-pattern-decoy');
      const staleHit = await searchWith(stalePatterns);
      expect(staleHit.map(h => h.slug)).toContain('topics/stale-pattern-decoy');
    } finally {
      __setEmbedTransportForTests(null);
      resetGateway();
      clearIntentPatternConfigForTests();
      await engine.unsetConfig('search.intent_patterns');
      await engine.executeRaw(`DELETE FROM query_cache WHERE query_text = $1`, [query]);
      await engine.executeRaw(
        `DELETE FROM pages WHERE slug = $1 AND source_id = 'default'`,
        [slug],
      );
    }
  });

  test('rejects a question with no relevant expectation before search', async () => {
    const proof = (question: Record<string, unknown>) => JSON.stringify({
      proof_version: 2,
      questions: [question],
    });
    const message = /Question q-none: must include at least one distinct relevant expectation/;
    expect(() => parseRetrievalProofManifest(proof({
      id: 'q-none', query: 'parent',
    }))).toThrow(message);
    expect(() => parseRetrievalProofManifest(proof({
      id: 'q-none', query: 'parent', relevant_slugs: [], relevant_pages: [],
    }))).toThrow(message);
    expect(() => parseRetrievalProofManifest(proof({
      id: 'q-none', query: 'parent', forbidden_slugs: ['topics/secret'],
    }))).toThrow(message);
    expect(parseRetrievalProofManifest(proof({
      id: 'q-dup',
      query: 'parent',
      relevant_slugs: ['topics/parent-note', 'topics/parent-note'],
    })).questions).toHaveLength(1);
    expect(parseRetrievalProofManifest(proof({
      id: 'q-page',
      query: 'parent',
      relevant_pages: [
        { source_id: 'wiki', slug: 'topics/parent-note' },
        { source_id: 'wiki', slug: 'topics/parent-note' },
      ],
    })).questions).toHaveLength(1);

    let searches = 0;
    _setRetrievalProofSearchForTests(async () => {
      searches += 1;
      return [{ slug: 'topics/parent-note', source_id: 'default' }];
    });
    try {
      await expect(runRetrievalProof(engine, {
        proof_version: 2,
        questions: [{ id: 'q-none', query: 'parent', relevant_slugs: [], forbidden_slugs: ['topics/secret'] }],
      }, { sourceId: 'default' })).rejects.toThrow(message);
      expect(searches).toBe(0);
      expect(scoreRetrievalQuestion({
        id: 'q-none', query: 'parent', relevant_slugs: [],
      }, [{ slug: 'topics/parent-note', source_id: 'default' }], 'default')).toBe('partial');
    } finally {
      _setRetrievalProofSearchForTests(null);
    }
  });

  test('rejects a string expectation list instead of walking its characters', () => {
    const proof = (field: string, value: unknown) => JSON.stringify({
      proof_version: 2,
      questions: [{
        id: 'q-shape',
        query: 'parent',
        relevant_slugs: ['topics/parent-note'],
        [field]: value,
      }],
    });
    expect(() => parseRetrievalProofManifest(proof('forbidden_slugs', 'topics/secret')))
      .toThrow(/Question q-shape: forbidden_slugs must be an array of non-empty slug strings/);
    expect(() => parseRetrievalProofManifest(proof('relevant_slugs', 'topics/parent-note')))
      .toThrow(/relevant_slugs must be an array of non-empty slug strings/);
    expect(() => parseRetrievalProofManifest(proof('forbidden_pages', 'wiki::topics/secret')))
      .toThrow(/forbidden_pages must be an array of \{source_id, slug\} objects/);
    expect(() => parseRetrievalProofManifest(proof('relevant_pages', { source_id: 'wiki', slug: 'topics/parent-note' })))
      .toThrow(/relevant_pages must be an array/);
    expect(() => scoreRetrievalQuestion({
      id: 'q-shape',
      query: 'parent',
      relevant_slugs: ['topics/parent-note'],
      forbidden_slugs: 'topics/secret' as unknown as string[],
    }, [
      { slug: 'topics/secret', source_id: 'wiki' },
    ], 'wiki')).toThrow(/forbidden_slugs must be an array of non-empty slug strings/);
  });

  test('rejects an unknown or archived source in page expectations before search', async () => {
    let searches = 0;
    _setRetrievalProofSearchForTests(async () => {
      searches += 1;
      return [{ slug: 'topics/secret', source_id: 'wiki' }];
    });
    try {
      await expect(runRetrievalProof(engine, {
        proof_version: 2,
        questions: [{
          id: 'typo-src',
          query: 'secret',
          relevant_pages: [{ source_id: 'default', slug: 'topics/parent-note' }],
          forbidden_pages: [{ source_id: 'wkii', slug: 'topics/secret' }],
        }],
      })).rejects.toThrow(/Source "wkii" not found/);
      expect(searches).toBe(0);

      await engine.executeRaw(
        `INSERT INTO sources (id, name, archived) VALUES ('oldwiki', 'oldwiki', true)
         ON CONFLICT (id) DO UPDATE SET archived = true`,
      );
      await expect(runRetrievalProof(engine, {
        proof_version: 2,
        questions: [{
          id: 'arch-src',
          query: 'secret',
          relevant_pages: [{ source_id: 'default', slug: 'topics/parent-note' }],
          forbidden_pages: [{ source_id: 'oldwiki', slug: 'topics/secret' }],
        }],
      })).rejects.toThrow(/not found or is archived/);
      expect(searches).toBe(0);
    } finally {
      _setRetrievalProofSearchForTests(null);
    }
  });

  test('rejects a non-positive min_hits_in_top_k while parsing', () => {
    const proof = (minHits: unknown) => JSON.stringify({
      proof_version: 2,
      questions: [{
        id: 'q-min',
        query: 'parent',
        relevant_slugs: ['topics/parent-note'],
        min_hits_in_top_k: minHits,
      }],
    });
    expect(() => parseRetrievalProofManifest(proof(0))).toThrow(/Question q-min: min_hits_in_top_k must be a positive integer/);
    expect(() => parseRetrievalProofManifest(proof(-1))).toThrow(/positive integer/);
    expect(() => parseRetrievalProofManifest(proof(1.5))).toThrow(/positive integer/);
    expect(parseRetrievalProofManifest(proof(1)).questions[0]?.min_hits_in_top_k).toBe(1);
    const omitted = JSON.stringify({
      proof_version: 2,
      questions: [{ id: 'q-omit', query: 'parent', relevant_slugs: ['topics/parent-note'] }],
    });
    expect(parseRetrievalProofManifest(omitted).questions).toHaveLength(1);

    const zero = {
      id: 'q-zero',
      query: 'parent',
      relevant_slugs: ['topics/parent-note'],
      min_hits_in_top_k: 0,
    };
    expect(() => scoreRetrievalQuestion(zero, [
      { slug: 'topics/parent-note', source_id: 'default' },
    ], 'default')).toThrow(/positive integer/);
  });

  test('repeated relevant expectations count once toward min_hits_in_top_k', () => {
    const oneHit = [{ slug: 'topics/parent-note', source_id: 'wiki' }];
    expect(scoreRetrievalQuestion({
      id: 'q-dup-slug',
      query: 'parent',
      relevant_slugs: ['topics/parent-note', 'topics/parent-note'],
      min_hits_in_top_k: 2,
    }, oneHit, 'wiki')).toBe('fail');
    expect(scoreRetrievalQuestion({
      id: 'q-dup-page',
      query: 'parent',
      relevant_pages: [
        { source_id: 'wiki', slug: 'topics/parent-note' },
        { source_id: 'wiki', slug: 'topics/parent-note' },
      ],
      min_hits_in_top_k: 2,
    }, oneHit)).toBe('fail');
    expect(scoreRetrievalQuestion({
      id: 'q-dup-both',
      query: 'parent',
      relevant_slugs: ['topics/parent-note'],
      relevant_pages: [{ source_id: 'wiki', slug: 'topics/parent-note' }],
      min_hits_in_top_k: 2,
    }, oneHit, 'wiki')).toBe('fail');
    expect(scoreRetrievalQuestion({
      id: 'q-two',
      query: 'parent',
      relevant_slugs: ['topics/parent-note', 'topics/child-note'],
      min_hits_in_top_k: 2,
    }, [
      { slug: 'topics/parent-note', source_id: 'wiki' },
      { slug: 'topics/child-note', source_id: 'wiki' },
    ], 'wiki')).toBe('pass');
  });

  test('rejects a non-positive top_k before search or slice', async () => {
    const proof = (topK: unknown) => JSON.stringify({
      proof_version: 2,
      questions: [{
        id: 'q-topk',
        query: 'parent',
        relevant_slugs: ['topics/parent-note'],
        top_k: topK,
      }],
    });
    expect(() => parseRetrievalProofManifest(proof(-1))).toThrow(/Question q-topk: top_k must be a positive integer/);
    expect(() => parseRetrievalProofManifest(proof(0))).toThrow(/top_k must be a positive integer/);
    expect(() => parseRetrievalProofManifest(proof(1.5))).toThrow(/top_k must be a positive integer/);
    expect(parseRetrievalProofManifest(proof(5)).questions[0]?.top_k).toBe(5);

    const hits = [
      { slug: 'topics/other', source_id: 'default' },
      { slug: 'topics/parent-note', source_id: 'default' },
      { slug: 'topics/tail', source_id: 'default' },
    ];
    expect(() => scoreRetrievalQuestion({
      id: 'q-topk',
      query: 'parent',
      relevant_slugs: ['topics/parent-note'],
      top_k: -1,
    }, hits, 'default')).toThrow(/top_k must be a positive integer/);

    let searches = 0;
    _setRetrievalProofSearchForTests(async () => {
      searches += 1;
      return hits;
    });
    try {
      await expect(runRetrievalProof(engine, {
        proof_version: 2,
        questions: [{
          id: 'q-topk',
          query: 'parent',
          relevant_pages: [{ source_id: 'default', slug: 'topics/parent-note' }],
          top_k: -1,
        }],
      })).rejects.toThrow(/top_k must be a positive integer/);
      expect(searches).toBe(0);
    } finally {
      _setRetrievalProofSearchForTests(null);
    }
  });

  test('cited_readwise_pages counts hits inside one question', async () => {
    const topPages = [
      { source_id: 'readwise', slug: 'articles/one' },
      { source_id: 'readwise', slug: 'articles/two' },
      { source_id: 'default', slug: 'topics/parent-note' },
    ];
    expect(citedReadwisePageCount([{ top_pages: topPages }])).toBe(2);
    expect(citedReadwisePageCount([
      { top_pages: [topPages[0]!] },
      { top_pages: [{ source_id: 'default', slug: 'topics/other' }] },
    ])).toBe(1);

    _setRetrievalProofSearchForTests(async () => topPages);
    try {
      const result = await runRetrievalProof(engine, {
        proof_version: 2,
        questions: [{
          id: 'rw-hits',
          query: 'parent',
          relevant_pages: [{ source_id: 'default', slug: 'topics/parent-note' }],
          top_k: 5,
        }],
      });
      expect(result.questions[0]?.cited_readwise).toBe(true);
      expect(result.checks.cited_readwise_pages).toBe(2);
      expect(result.passed).toBe(false);
    } finally {
      _setRetrievalProofSearchForTests(null);
    }
  });

  test('a failed retrieval proof exits nonzero after the result is printed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-proof-exit-'));
    const proof = join(dir, 'proof.json');
    const outPath = join(dir, 'out.json');
    writeFileSync(proof, JSON.stringify({
      proof_version: 2,
      questions: [{
        id: 'miss',
        query: 'parent note topic',
        relevant_slugs: ['topics/no-such-page-dav6220'],
        min_hits_in_top_k: 1,
        top_k: 5,
      }],
    }));
    const origLog = console.log;
    const origErr = console.error;
    let stdout = '';
    console.log = (...a: unknown[]) => { stdout += a.map(String).join(' ') + '\n'; };
    console.error = () => {};
    try {
      await runGraphUsefulness(engine, [
        '--source', 'default', 'retrieval-proof', 'run', proof, '--out', outPath,
      ]);
      expect(stdout).toContain('retrieval-proof:');
      expect(stdout).toContain('fail=1');
      expect(currentExitCode()).toBe(1);
      const saved = JSON.parse(readFileSync(outPath, 'utf8'));
      expect(saved.passed).toBe(false);

      _resetCliExitVerdictForTests();
      stdout = '';
      await runGraphUsefulness(engine, [
        '--source', 'default', 'retrieval-proof', 'run', proof, '--json',
      ]);
      const parsed = JSON.parse(stdout);
      expect(parsed.passed).toBe(false);
      expect(currentExitCode()).toBe(1);
    } finally {
      console.log = origLog;
      console.error = origErr;
      process.exitCode = undefined;
      _resetCliExitVerdictForTests();
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
    try {
      await runGraphUsefulness(engine, [
        'relations', 'apply', manifestPath, '--receipt-out', join(dir, 'hidden.json'), '--json',
        '--', '--apply', '--yes', '--dry-run',
      ]);
      expect(currentExitCode()).toBe(2);
      expect(await linkCount(engine, from, to)).toBe(0);
      expect(stdout).toBe('');

      stdout = '';
      _resetCliExitVerdictForTests();
      await runGraphUsefulness(engine, [
        'relations', 'apply', manifestPath, '--apply', '--yes', '--json',
        '--receipt-out', join(dir, 'real.json'),
      ]);
      expect(await linkCount(engine, from, to)).toBe(1);
      const applied = JSON.parse(stdout);
      expect(applied.mode).toBe('apply');
      expect(applied.applied).toBe(1);
    } finally {
      console.log = origLog;
      console.error = origErr;
      process.exitCode = undefined;
      _resetCliExitVerdictForTests();
    }
  });

  test('surplus positionals on relations apply are rejected before the manifest is read', async () => {
    const from = 'topics/surplus-from';
    const to = 'topics/surplus-to';
    await engine.putPage(from, { title: 'From', compiled_truth: 'surplus from', type: 'note' });
    await engine.putPage(to, { title: 'To', compiled_truth: 'surplus to', type: 'note' });
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-rel-surplus-'));
    const manifestPath = join(dir, 'manifest.json');
    writeFileSync(manifestPath, relationManifest([{
      id: 'surplus-1',
      from_slug: from,
      to_slug: to,
      link_type: 'related_to',
      link_source: 'tana-relation-r2',
      guards: TRUE_GUARDS,
    }]));
    const origLog = console.log;
    const origErr = console.error;
    const errors: string[] = [];
    console.log = () => {};
    console.error = (...a: unknown[]) => { errors.push(a.map(String).join(' ')); };
    try {
      await runGraphUsefulness(engine, [
        'relations', 'apply', manifestPath, 'unexpected', '--apply', '--yes',
        '--source', 'not-a-real-source',
      ]);
      expect(currentExitCode()).toBe(2);
      expect(await linkCount(engine, from, to)).toBe(0);
      expect(errors.join('\n')).toContain('Unexpected argument: unexpected');
      expect(errors.join('\n')).not.toMatch(/not found|archived/i);

      errors.length = 0;
      _resetCliExitVerdictForTests();
      await runGraphUsefulness(engine, [
        'relations', 'apply', join(dir, 'missing.json'), 'unexpected', '--apply', '--yes',
      ]);
      expect(currentExitCode()).toBe(2);
      expect(errors.join('\n')).toContain('Unexpected argument: unexpected');
      expect(errors.join('\n')).not.toMatch(/ENOENT|no such file|not found/i);
      expect(await linkCount(engine, from, to)).toBe(0);
    } finally {
      console.log = origLog;
      console.error = origErr;
      process.exitCode = undefined;
      _resetCliExitVerdictForTests();
    }
  });

  test('GBRAIN_SOURCE and sources.default fill omitted manifest endpoint sources', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('wiki', 'wiki') ON CONFLICT (id) DO NOTHING`,
    );
    const guards = TRUE_GUARDS;
    const origLog = console.log;
    const origErr = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
      const envFrom = 'topics/ambient-env-from';
      const envTo = 'topics/ambient-env-to';
      await engine.putPage(envFrom, { title: 'From', compiled_truth: 'env from', type: 'note' }, { sourceId: 'wiki' });
      await engine.putPage(envTo, { title: 'To', compiled_truth: 'env to', type: 'note' }, { sourceId: 'wiki' });
      await engine.putPage(envFrom, { title: 'From', compiled_truth: 'env from default', type: 'note' }, { sourceId: 'default' });
      await engine.putPage(envTo, { title: 'To', compiled_truth: 'env to default', type: 'note' }, { sourceId: 'default' });
      const dir = mkdtempSync(join(tmpdir(), 'gbrain-ambient-src-'));
      const manifestPath = join(dir, 'manifest.json');
      writeFileSync(manifestPath, relationManifest([{
        id: 'ambient-env',
        from_slug: envFrom,
        to_slug: envTo,
        link_type: 'related_to',
        link_source: 'tana-relation-r2',
        guards,
      }]));
      await withEnv({ GBRAIN_SOURCE: 'wiki' }, async () => {
        await runGraphUsefulness(engine, [
          'relations', 'apply', manifestPath, '--apply', '--yes',
          '--receipt-out', join(dir, 'env-receipt.json'), '--json',
        ]);
      });
      const envLinks = await engine.executeRaw<{ from_source: string; to_source: string }>(
        `SELECT fp.source_id AS from_source, tp.source_id AS to_source
           FROM links l
           JOIN pages fp ON fp.id = l.from_page_id
           JOIN pages tp ON tp.id = l.to_page_id
          WHERE fp.slug = $1 AND tp.slug = $2
            AND fp.deleted_at IS NULL AND tp.deleted_at IS NULL`,
        [envFrom, envTo],
      );
      expect(envLinks).toEqual([{ from_source: 'wiki', to_source: 'wiki' }]);

      const cfgFrom = 'topics/ambient-cfg-from';
      const cfgTo = 'topics/ambient-cfg-to';
      await engine.putPage(cfgFrom, { title: 'From', compiled_truth: 'cfg from', type: 'note' }, { sourceId: 'wiki' });
      await engine.putPage(cfgTo, { title: 'To', compiled_truth: 'cfg to', type: 'note' }, { sourceId: 'wiki' });
      const cfgPath = join(dir, 'cfg.json');
      writeFileSync(cfgPath, relationManifest([{
        id: 'ambient-cfg',
        from_slug: cfgFrom,
        to_slug: cfgTo,
        link_type: 'related_to',
        link_source: 'tana-relation-r2',
        guards,
      }]));
      await engine.setConfig('sources.default', 'wiki');
      await withEnv({ GBRAIN_SOURCE: undefined }, async () => {
        await runGraphUsefulness(engine, [
          'relations', 'apply', cfgPath, '--apply', '--yes',
          '--receipt-out', join(dir, 'cfg-receipt.json'), '--json',
        ]);
      });
      const cfgLinks = await engine.executeRaw<{ from_source: string; to_source: string }>(
        `SELECT fp.source_id AS from_source, tp.source_id AS to_source
           FROM links l
           JOIN pages fp ON fp.id = l.from_page_id
           JOIN pages tp ON tp.id = l.to_page_id
          WHERE fp.slug = $1 AND tp.slug = $2
            AND fp.deleted_at IS NULL AND tp.deleted_at IS NULL`,
        [cfgFrom, cfgTo],
      );
      expect(cfgLinks).toEqual([{ from_source: 'wiki', to_source: 'wiki' }]);
    } finally {
      await engine.unsetConfig('sources.default');
      console.log = origLog;
      console.error = origErr;
      process.exitCode = undefined;
      _resetCliExitVerdictForTests();
    }
  });

  test('rejects an archived source named by a manifest row before addLink', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('archsrc', 'archsrc') ON CONFLICT (id) DO NOTHING`,
    );
    const from = 'topics/arch-from';
    const to = 'topics/arch-to';
    await engine.putPage(from, { title: 'From', compiled_truth: 'arch from', type: 'note' }, { sourceId: 'archsrc' });
    await engine.putPage(to, { title: 'To', compiled_truth: 'arch to', type: 'note' }, { sourceId: 'archsrc' });
    await engine.executeRaw(`UPDATE sources SET archived = true WHERE id = 'archsrc'`);
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-arch-src-'));
    const manifestPath = join(dir, 'manifest.json');
    const receiptPath = join(dir, 'receipt.json');
    const raw = relationManifest([{
      id: 'arch-row',
      from_slug: from,
      to_slug: to,
      from_source_id: 'archsrc',
      to_source_id: 'archsrc',
      link_type: 'related_to',
      link_source: 'tana-relation-r2',
      guards: TRUE_GUARDS,
    }]);
    writeFileSync(manifestPath, raw);
    const manifest = parseRelationManifest(raw);
    const original = engine.addLink;
    let calls = 0;
    engine.addLink = async (...args) => {
      calls += 1;
      return original(...args);
    };
    const origLog = console.log;
    const origErr = console.error;
    const errors: string[] = [];
    console.log = () => {};
    console.error = (...a: unknown[]) => { errors.push(a.map(String).join(' ')); };
    try {
      await expect(applyRelationManifest(engine, manifest, raw, {
        apply: true,
        receiptPath,
        defaultSourceId: 'default',
      })).rejects.toThrow(/Source "archsrc" not found or is archived/);
      expect(calls).toBe(0);
      expect(existsSync(receiptPath)).toBe(false);
      expect(await linkCount(engine, from, to)).toBe(0);

      const sentinel = relationManifest([{
        id: 'all-row',
        from_slug: from,
        to_slug: to,
        from_source_id: '__all__',
        to_source_id: 'default',
        link_type: 'related_to',
        link_source: 'tana-relation-r2',
        guards: TRUE_GUARDS,
      }]);
      const allManifest = parseRelationManifest(sentinel);
      await expect(applyRelationManifest(engine, allManifest, sentinel, {
        apply: true,
        defaultSourceId: 'default',
      })).rejects.toThrow(/Invalid --source value "__all__"/);
      expect(calls).toBe(0);

      await runGraphUsefulness(engine, [
        'relations', 'apply', manifestPath, '--apply', '--yes', '--json',
        '--receipt-out', join(dir, 'cli-receipt.json'),
      ]);
      expect(currentExitCode()).toBe(1);
      expect(errors.some(line => line.includes('Source "archsrc" not found or is archived'))).toBe(true);
      expect(calls).toBe(0);
      expect(existsSync(join(dir, 'cli-receipt.json'))).toBe(false);
    } finally {
      engine.addLink = original;
      console.log = origLog;
      console.error = origErr;
      process.exitCode = undefined;
      _resetCliExitVerdictForTests();
    }
  });

  test('unknown --source is rejected before apply', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-missing-src-'));
    const manifestPath = join(dir, 'manifest.json');
    writeFileSync(manifestPath, relationManifest([{
      id: 'missing-src',
      from_slug: 'topics/parent-note',
      to_slug: 'topics/child-note',
      link_type: 'related_to',
      link_source: 'tana-relation-r2',
      guards: TRUE_GUARDS,
    }]));
    const origLog = console.log;
    const origErr = console.error;
    const errors: string[] = [];
    console.log = () => {};
    console.error = (...a: unknown[]) => { errors.push(a.map(String).join(' ')); };
    const original = engine.addLink;
    let calls = 0;
    engine.addLink = async (...args) => {
      calls += 1;
      return original(...args);
    };
    try {
      await runGraphUsefulness(engine, [
        'relations', 'apply', manifestPath, '--source', 'no-such-src', '--apply', '--yes', '--json',
      ]);
      expect(currentExitCode()).toBe(1);
      expect(errors.some(line => line.includes('not found or is archived'))).toBe(true);
      expect(calls).toBe(0);
    } finally {
      engine.addLink = original;
      console.log = origLog;
      console.error = origErr;
      process.exitCode = undefined;
      _resetCliExitVerdictForTests();
    }
  });
});

describe('usefulness read source resolution', () => {
  test('measure and retrieval-proof reject an unknown --source', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('src-read', 'src-read') ON CONFLICT (id) DO NOTHING`,
    );
    await engine.putPage('topics/src-read-only', {
      title: 'Scoped read',
      compiled_truth: 'only on src-read',
      type: 'note',
    }, { sourceId: 'src-read' });

    const dir = mkdtempSync(join(tmpdir(), 'gbrain-read-src-'));
    const proof = join(dir, 'proof.json');
    writeFileSync(proof, JSON.stringify({
      proof_version: 2,
      questions: [{
        id: 'scoped',
        query: 'parent note topic',
        relevant_slugs: ['topics/parent-note'],
        top_k: 5,
      }],
    }));

    const origLog = console.log;
    const origErr = console.error;
    let stdout = '';
    const errors: string[] = [];
    console.log = (...a: unknown[]) => { stdout += a.map(String).join(' ') + '\n'; };
    console.error = (...a: unknown[]) => { errors.push(a.map(String).join(' ')); };
    try {
      await runGraphUsefulness(engine, ['measure', '--source', 'wkii', '--json']);
      expect(currentExitCode()).toBe(1);
      expect(stdout).toBe('');
      expect(errors.some(line => line.includes('Source "wkii" not found or is archived'))).toBe(true);

      _resetCliExitVerdictForTests();
      stdout = '';
      errors.length = 0;
      await runGraphUsefulness(engine, ['retrieval-proof', 'run', proof, '--source', 'wkii', '--json']);
      expect(currentExitCode()).toBe(1);
      expect(stdout).toBe('');
      expect(errors.some(line => line.includes('Source "wkii" not found or is archived'))).toBe(true);

      _resetCliExitVerdictForTests();
      stdout = '';
      errors.length = 0;
      await runGraphUsefulness(engine, ['stats', '--source', 'Not_A_Slug', '--json']);
      expect(currentExitCode()).toBe(1);
      expect(stdout).toBe('');
      expect(errors.some(line => line.includes('Invalid --source value'))).toBe(true);

      _resetCliExitVerdictForTests();
      stdout = '';
      errors.length = 0;
      await runGraphUsefulness(engine, ['measure', '--source', 'src-read', '--json']);
      expect(currentExitCode()).toBe(0);
      const scoped = JSON.parse(stdout) as { active_pages: number };
      expect(scoped.active_pages).toBeGreaterThanOrEqual(1);

      _resetCliExitVerdictForTests();
      stdout = '';
      await runGraphUsefulness(engine, ['measure', '--source', '__all__', '--json']);
      expect(currentExitCode()).toBe(0);
      const all = JSON.parse(stdout) as { active_pages: number };
      expect(all.active_pages).toBeGreaterThan(scoped.active_pages);
    } finally {
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
