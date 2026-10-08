#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { projectPage, type PageSnapshot } from './display-projection.ts';
import { loadHistoricalSource, verifyHistoricalSource, type SourceBundle } from './display-projection-source.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = 'tana-export-20250131';
const MAX_FIXTURE_BYTES = 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024;
const ORIGINAL_PACKET_SEAL = 'f30dc5b6384fafdfc0e7e6b244ca44c755b2ccc53fc360f19d7e18ed176a4ad5';
const QUERY_SOURCE_HASH = 'bcd9e8dd5327aa00776533a5f9389add60ea0835cc6d3bf1ece94728fd174ecf';
const ASSESSMENT_SOURCE_HASH = '8014f7b4d58257f7896525003d33f100664defadab45285bc4e45dc00dfa9020';
const AUTHORING_HISTORY_HASH = '81ba963cf8dfedc0f3422814da760761fabe5a668b1bd18840ebef79ae781796';

const HELP = `Usage:
  bun scripts/display-projection-retrieval-dry-run.ts
    --fixture PATH --fixture-sha256 SHA256
    --snapshot PATH --snapshot-sha256 SHA256
    --source-records PATH --source-records-sha256 SHA256
    --receipt out/PATH.json

Offline only. All three private regular files must have exact pinned SHA256 bytes.
The fixture contains recovered original questions and historical manual
assessments, not a complete sealed reviewed query+groundtruth packet.
--historical-seal PATH --historical-seal-sha256 SHA256 verifies the original seal
bytes and the recovered producer hashes against its authenticated manifest.
The snapshot contains native keyword and optional keyless hybrid results captured
before and after display derivation in one read-only transaction. Readwise rows
are excluded. Exact result identities, ranks, text and scores must be unchanged.
Every captured source page is verified against the original export and projected.
Canonical fields, indexes and database state are never written by this utility.
Retrieval grading is NOT_SCORED while that reviewed packet is absent.
Historical manual scores are not current grades or semantic improvement evidence.
The redacted receipt is exclusively created with mode 0600 under repository out/.
No database, environment configuration, provider, embedding or reindex path exists.
--apply is refused. Errors contain fixed codes only.
`;

class ProofError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const questionId = positiveId.max(10);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const assessment = z.strictObject({
  id: questionId,
  score: z.enum(['pass', 'partial', 'fail']),
  citations: z.array(positiveId).max(1000),
  finding: z.string().min(1),
  gap: z.string().nullable(),
});
const fixtureSchema = z.strictObject({
  schema_version: z.literal(1),
  provenance: z.strictObject({
    historical_packet_seal_sha256: z.literal(ORIGINAL_PACKET_SEAL),
    historical_packet_complete: z.literal(false),
    query_source_sha256: z.literal(QUERY_SOURCE_HASH),
    assessment_source_sha256: z.literal(ASSESSMENT_SOURCE_HASH),
    authoring_history_sha256: z.literal(AUTHORING_HISTORY_HASH),
  }),
  questions: z.array(z.strictObject({
    id: questionId,
    query: z.string().min(1),
    expected: z.string().min(1),
    kind: z.string().min(1),
    assessment,
  })).length(10),
});
const resultSchema = z.strictObject({
  page_id: positiveId,
  title: z.string(),
  chunk_id: positiveId.nullable(),
  chunk_text: z.string().nullable(),
  score: z.number().finite(),
  source_id: z.string().min(1),
  slug: z.string().min(1),
  readwise_excluded: z.boolean(),
});
const capturedQuestion = z.strictObject({
  id: questionId,
  results: z.array(resultSchema).max(1000),
  hybrid_results: z.array(resultSchema).max(1000).optional(),
});
const snapshotSchema = z.strictObject({
  schema_version: z.literal(1),
  source_id: z.literal(SOURCE),
  pages: z.array(z.strictObject({
    id: positiveId,
    slug: z.string().min(1),
    source_id: z.literal(SOURCE),
    title: z.string(),
    compiled_truth: z.string(),
    record_id: z.string().min(1),
    sourceHash: sha256,
  })).min(1).max(40_731),
  before: z.array(capturedQuestion).length(10),
  after: z.array(capturedQuestion).length(10),
  database: z.strictObject({
    transaction_read_only: z.literal('on'),
    pooler_port: z.literal(6543),
    page_and_chunk_snapshot_unchanged: z.literal(true),
  }),
  native_search: z.strictObject({
    implementation: z.literal('PostgresEngine.searchKeyword'),
    query_expansion: z.literal(false),
    vector_exercised: z.literal(false),
    semantic_grading_exercised: z.literal(false),
    hybrid_implementation: z.literal('hybridSearch').optional(),
    hybrid_exercised: z.boolean().optional(),
    evaluation_clock_ms: z.number().int().positive().optional(),
  }),
});

type Fixture = z.infer<typeof fixtureSchema>;
type Snapshot = z.infer<typeof snapshotSchema>;
type NativeResult = z.infer<typeof resultSchema>;

export interface RetrievalProofOptions {
  fixture: string;
  fixtureSha256: string;
  snapshot: string;
  snapshotSha256: string;
  sourceRecords: string;
  sourceRecordsSha256: string;
  receipt: string;
  historicalSeal?: string;
  historicalSealSha256?: string;
}

function parseOptions(args: string[]): RetrievalProofOptions | null {
  if (args.some((arg) => arg === '--apply' || arg.startsWith('--apply='))) throw new ProofError('APPLY_REFUSED');
  if (args.includes('--help') || args.includes('-h')) return null;
  const flags: Record<string, keyof RetrievalProofOptions> = {
    '--fixture': 'fixture', '--fixture-sha256': 'fixtureSha256',
    '--snapshot': 'snapshot', '--snapshot-sha256': 'snapshotSha256',
    '--source-records': 'sourceRecords', '--source-records-sha256': 'sourceRecordsSha256',
    '--receipt': 'receipt',
    '--historical-seal': 'historicalSeal', '--historical-seal-sha256': 'historicalSealSha256',
  };
  const values: Partial<RetrievalProofOptions> = {};
  for (let index = 0; index < args.length; index++) {
    const key = Object.hasOwn(flags, args[index]) ? flags[args[index]] : undefined;
    const value = args[++index];
    if (!key || !value || value.startsWith('--') || values[key] !== undefined) throw new ProofError('INVALID_ARGUMENT');
    values[key] = value;
  }
  if (!values.fixture || !values.fixtureSha256 || !values.snapshot || !values.snapshotSha256
    || !values.sourceRecords || !values.sourceRecordsSha256 || !values.receipt) throw new ProofError('MISSING_ARGUMENT');
  for (const hash of [values.fixtureSha256, values.snapshotSha256, values.sourceRecordsSha256]) {
    if (!/^[a-f0-9]{64}$/i.test(hash)) throw new ProofError('INVALID_INPUT_HASH');
  }
  if (Boolean(values.historicalSeal) !== Boolean(values.historicalSealSha256)) throw new ProofError('INVALID_SEAL_OPTIONS');
  if (values.historicalSealSha256 && !/^[a-f0-9]{64}$/i.test(values.historicalSealSha256)) throw new ProofError('INVALID_INPUT_HASH');
  return values as RetrievalProofOptions;
}

async function readPinnedJson(path: string, expectedHash: string, limit: number, kind: 'FIXTURE' | 'SNAPSHOT' | 'SEAL') {
  if (!/^[a-f0-9]{64}$/i.test(expectedHash)) throw new ProofError('INVALID_INPUT_HASH');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes: Buffer;
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > limit || (before.mode & 0o077) !== 0) throw new ProofError(`INVALID_${kind}_FILE`);
    bytes = await file.readFile();
    const after = await file.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || bytes.length !== before.size) throw new ProofError(`${kind}_FILE_CHANGED`);
  } finally {
    await file.close();
  }
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (hash !== expectedHash.toLowerCase()) throw new ProofError(`${kind}_HASH_MISMATCH`);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new ProofError(`INVALID_${kind}_JSON`);
  }
  return { value, sha256: hash };
}

function decodeFixture(value: unknown): Fixture {
  const decoded = fixtureSchema.safeParse(value);
  if (!decoded.success) throw new ProofError('INVALID_FIXTURE');
  const fixture = decoded.data;
  if (new Set(fixture.questions.map(({ id }) => id)).size !== 10
    || fixture.questions.some(({ id, assessment }) => assessment.id !== id
      || new Set(assessment.citations).size !== assessment.citations.length)) {
    throw new ProofError('INVALID_FIXTURE');
  }
  return fixture;
}

function decodeSnapshot(value: unknown): Snapshot {
  const decoded = snapshotSchema.safeParse(value);
  if (!decoded.success) throw new ProofError('INVALID_SNAPSHOT');
  const snapshot = decoded.data;
  if (new Set(snapshot.pages.map(({ id }) => id)).size !== snapshot.pages.length
    || new Set(snapshot.pages.map(({ record_id }) => record_id)).size !== snapshot.pages.length
    || new Set(snapshot.before.map(({ id }) => id)).size !== 10
    || new Set(snapshot.after.map(({ id }) => id)).size !== 10) throw new ProofError('INVALID_SNAPSHOT');
  const hybrid = snapshot.native_search.hybrid_exercised === true;
  if (hybrid !== (snapshot.native_search.hybrid_implementation !== undefined)
    || [...snapshot.before, ...snapshot.after].some((question) => (question.hybrid_results !== undefined) !== hybrid)) {
    throw new ProofError('INVALID_SNAPSHOT');
  }
  const pages = new Map(snapshot.pages.map((page) => [page.id, page]));
  for (const question of [...snapshot.before, ...snapshot.after]) {
    if (question.results.some((result) => result.chunk_id === null || result.chunk_text === null)) throw new ProofError('INVALID_SNAPSHOT');
    for (const results of [question.results, ...(question.hybrid_results === undefined ? [] : [question.hybrid_results])]) {
      const chunkIds = results.flatMap(({ chunk_id }) => chunk_id === null ? [] : [chunk_id]);
      if (new Set(results.map(({ page_id, chunk_id }) => `${page_id}:${chunk_id ?? 'page'}`)).size !== results.length
        || new Set(chunkIds).size !== chunkIds.length) throw new ProofError('INVALID_SNAPSHOT');
      for (const result of results) {
        const page = pages.get(result.page_id);
        if (result.source_id === SOURCE && !page) throw new ProofError('INCOMPLETE_SOURCE_SNAPSHOT');
        if (page && (result.source_id !== page.source_id || result.slug !== page.slug || result.title !== page.title)) {
          throw new ProofError('RESULT_PAGE_MISMATCH');
        }
      }
    }
  }
  return snapshot;
}

async function receiptPath(requested: string): Promise<string> {
  const root = await realpath(REPO_ROOT);
  const out = join(root, 'out');
  await mkdir(out, { mode: 0o700, recursive: true });
  if ((await lstat(out)).isSymbolicLink() || await realpath(out) !== out) throw new ProofError('UNSAFE_RECEIPT_PATH');
  const target = isAbsolute(requested) ? resolve(requested) : resolve(root, requested);
  const inside = relative(out, target);
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)
    || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/.test(basename(target))) throw new ProofError('UNSAFE_RECEIPT_PATH');
  let parent = out;
  for (const part of relative(out, dirname(target)).split(sep).filter(Boolean)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part)) throw new ProofError('UNSAFE_RECEIPT_PATH');
    parent = join(parent, part);
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(parent) !== parent) {
      throw new ProofError('UNSAFE_RECEIPT_PATH');
    }
  }
  return target;
}

function eligibleResults(results: NativeResult[], excludedPageIds: ReadonlySet<number>) {
  return results.map((result, index) => ({ native_rank: index + 1, result }))
    .filter(({ result }) => !result.readwise_excluded && !excludedPageIds.has(result.page_id));
}

function deriveReceipt(fixture: Fixture, snapshot: Snapshot, source: SourceBundle, hashes: {
  fixture: string; snapshot: string; source_records: string; historical_seal?: string;
}) {
  const verified = verifyHistoricalSource(source, snapshot.pages.map((page) => ({ page, sourceHash: page.sourceHash })));
  const unchanged = JSON.stringify(snapshot);
  const excludedPageIds = new Set(snapshot.pages.filter((page) => source.records.get(page.record_id)?.readwise === true)
    .map(({ id }) => id));
  const counts = {
    questions: 10, source_records: source.records.size, verified_source_roots: verified,
    projected_pages: snapshot.pages.length, complete: 0, held: 0, idempotency_failures: 0,
    excluded_readwise_source_records: source.excludedReadwise, excluded_readwise_roots: excludedPageIds.size,
    raw_results_before: 0, raw_results_after: 0, eligible_results_before: 0, eligible_results_after: 0,
    raw_hybrid_results_before: 0, raw_hybrid_results_after: 0,
    eligible_hybrid_results_before: 0, eligible_hybrid_results_after: 0,
  };
  for (const stored of snapshot.pages) {
    const page: PageSnapshot = Object.freeze({
      id: stored.id, slug: stored.slug, source_id: stored.source_id, title: stored.title,
      compiled_truth: stored.compiled_truth, record_id: stored.record_id,
      readwise: excludedPageIds.has(stored.id),
    });
    const original = JSON.stringify(page);
    const projected = projectPage(page, source.records);
    const second = projectPage(Object.freeze({ ...page, title: projected.caption, compiled_truth: projected.display_body }), source.records);
    const idempotent = second.caption === projected.caption && second.display_body === projected.display_body;
    if (!idempotent) counts.idempotency_failures++;
    counts[projected.status === 'held' || !idempotent ? 'held' : 'complete']++;
    if (JSON.stringify(page) !== original) throw new ProofError('PAGE_SNAPSHOT_MUTATED');
  }
  const beforeById = new Map(snapshot.before.map((question) => [question.id, question]));
  const afterById = new Map(snapshot.after.map((question) => [question.id, question]));
  const historicalManualScores = { pass: 0, partial: 0, fail: 0 };
  const questions = [...fixture.questions].sort((a, b) => a.id - b.id).map((question) => {
    const before = beforeById.get(question.id)!;
    const after = afterById.get(question.id)!;
    const eligibleBefore = eligibleResults(before.results, excludedPageIds);
    const eligibleAfter = eligibleResults(after.results, excludedPageIds);
    const eligibleHybridBefore = eligibleResults(before.hybrid_results ?? [], excludedPageIds);
    const eligibleHybridAfter = eligibleResults(after.hybrid_results ?? [], excludedPageIds);
    if (JSON.stringify(before.results) !== JSON.stringify(after.results)
      || JSON.stringify(before.hybrid_results) !== JSON.stringify(after.hybrid_results)) throw new ProofError('NATIVE_RESULT_DRIFT');
    const beforeIds = new Set([...eligibleBefore, ...eligibleHybridBefore].map(({ result }) => result.page_id));
    const afterIds = new Set([...eligibleAfter, ...eligibleHybridAfter].map(({ result }) => result.page_id));
    counts.raw_results_before += before.results.length;
    counts.raw_results_after += after.results.length;
    counts.eligible_results_before += eligibleBefore.length;
    counts.eligible_results_after += eligibleAfter.length;
    counts.raw_hybrid_results_before += before.hybrid_results?.length ?? 0;
    counts.raw_hybrid_results_after += after.hybrid_results?.length ?? 0;
    counts.eligible_hybrid_results_before += eligibleHybridBefore.length;
    counts.eligible_hybrid_results_after += eligibleHybridAfter.length;
    historicalManualScores[question.assessment.score]++;
    return {
      ordinal: question.id,
      raw_count_before: before.results.length, raw_count_after: after.results.length,
      eligible_count_before: eligibleBefore.length, eligible_count_after: eligibleAfter.length,
      excluded_readwise_count_before: before.results.length - eligibleBefore.length,
      excluded_readwise_count_after: after.results.length - eligibleAfter.length,
      raw_hybrid_count_before: before.hybrid_results?.length ?? 0,
      raw_hybrid_count_after: after.hybrid_results?.length ?? 0,
      eligible_hybrid_count_before: eligibleHybridBefore.length,
      eligible_hybrid_count_after: eligibleHybridAfter.length,
      exact_native_result_identity_retained: true,
      original_citation_count: question.assessment.citations.length,
      original_citations_retained_before: question.assessment.citations.filter((id) => beforeIds.has(id)).length,
      original_citations_retained_after: question.assessment.citations.filter((id) => afterIds.has(id)).length,
      original_manual_score: question.assessment.score,
    };
  });
  if (JSON.stringify(snapshot) !== unchanged) throw new ProofError('SNAPSHOT_MUTATED');
  if (counts.idempotency_failures !== 0) throw new ProofError('PROJECTION_NOT_IDEMPOTENT');
  return {
    schema_version: 1,
    mode: 'offline-derived-display-retrieval-compatibility',
    input_sha256: hashes,
    historical_packet: {
      status: 'incomplete_original_sealed_packet',
      complete: false,
      historical_seal_sha256: fixture.provenance.historical_packet_seal_sha256,
      historical_seal_bytes_verified: hashes.historical_seal === ORIGINAL_PACKET_SEAL,
      recovered_source_hashes_in_verified_seal: hashes.historical_seal === ORIGINAL_PACKET_SEAL,
      recovered_query_source_sha256: fixture.provenance.query_source_sha256,
      recovered_assessment_source_sha256: fixture.provenance.assessment_source_sha256,
      authoring_history_sha256: fixture.provenance.authoring_history_sha256,
    },
    native_search: snapshot.native_search,
    capture_attestation: snapshot.database,
    compatibility: {
      status: 'exact_native_results_retained',
      rank_basis: 'Original native positions retained before Readwise exclusion.',
      canonical_snapshot_unchanged: true,
      derivation_idempotent: true,
      database_accesses: 0,
      canonical_writes: 0,
      reindexes: 0,
    },
    grading: {
      status: 'NOT_SCORED',
      reason: 'SEALED_REVIEWED_QUERY_GROUNDTRUTH_PACKET_ABSENT',
      current_manual_grading_exercised: false,
      semantic_improvement_established: false,
      original_historical_manual_scores: historicalManualScores,
      limitation: 'Recovered historical manual assessments are not current grades. Exact native result preservation proves display compatibility, not semantic retrieval improvement or complete historical packet recovery.',
    },
    counts,
    questions,
  };
}

export async function runOfflineRetrievalProof(options: RetrievalProofOptions) {
  const target = await receiptPath(options.receipt);
  const pinnedFixture = await readPinnedJson(options.fixture, options.fixtureSha256, MAX_FIXTURE_BYTES, 'FIXTURE');
  const fixture = decodeFixture(pinnedFixture.value);
  const pinnedSnapshot = await readPinnedJson(options.snapshot, options.snapshotSha256, MAX_SNAPSHOT_BYTES, 'SNAPSHOT');
  const snapshot = decodeSnapshot(pinnedSnapshot.value);
  if (Boolean(options.historicalSeal) !== Boolean(options.historicalSealSha256)) throw new ProofError('INVALID_SEAL_OPTIONS');
  const pinnedSeal = options.historicalSeal === undefined ? undefined
    : await readPinnedJson(options.historicalSeal, options.historicalSealSha256!, MAX_FIXTURE_BYTES, 'SEAL');
  if (pinnedSeal !== undefined) {
    if (pinnedSeal.sha256 !== ORIGINAL_PACKET_SEAL) throw new ProofError('INVALID_HISTORICAL_SEAL');
    const decodedSeal = z.object({ rows: z.array(z.object({ path: z.string(), sha256 })) }).safeParse(pinnedSeal.value);
    if (!decodedSeal.success) throw new ProofError('INVALID_HISTORICAL_SEAL');
    const rows = decodedSeal.data.rows;
    if (rows.find((row) => row.path === 'run.ts')?.sha256 !== QUERY_SOURCE_HASH
      || rows.find((row) => row.path === 'score.ts')?.sha256 !== ASSESSMENT_SOURCE_HASH) throw new ProofError('INVALID_HISTORICAL_SEAL');
  }
  const sourceFile = await open(options.sourceRecords, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await sourceFile.stat();
    if (!info.isFile() || info.size > MAX_SNAPSHOT_BYTES || (info.mode & 0o077) !== 0) throw new ProofError('INVALID_SOURCE_FILE');
  } finally {
    await sourceFile.close();
  }
  const source = await loadHistoricalSource(options.sourceRecords, options.sourceRecordsSha256, SOURCE);
  const receipt = deriveReceipt(fixture, snapshot, source, {
    fixture: pinnedFixture.sha256, snapshot: pinnedSnapshot.sha256, source_records: source.sha256,
    ...(pinnedSeal === undefined ? {} : { historical_seal: pinnedSeal.sha256 }),
  });
  if (await realpath(dirname(target)) !== dirname(target)) throw new ProofError('UNSAFE_RECEIPT_PATH');
  const file = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await file.chmod(0o600);
    await file.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
  return { receipt: relative(REPO_ROOT, target), counts: receipt.counts };
}

const SAFE_SOURCE_ERRORS: Record<string, true> = {
  INVALID_SOURCE_HASH: true, INVALID_SOURCE_FILE: true, SOURCE_FILE_CHANGED: true, SOURCE_HASH_MISMATCH: true,
  INVALID_SOURCE_JSON: true, INVALID_ORIGINAL_EXPORT: true, INVALID_SOURCE_RECORD: true, DUPLICATE_SOURCE_RECORD: true,
  SOURCE_REVISION_MISMATCH: true, INVALID_STORED_SOURCE: true, STORED_SOURCE_HASH_MISMATCH: true,
};

function sanitizedError(error: unknown): string {
  if (error instanceof ProofError) return error.code;
  if (error instanceof Error && Object.hasOwn(SAFE_SOURCE_ERRORS, error.message)) return error.message;
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    && ['EEXIST', 'EACCES', 'ENOENT', 'ENOTDIR', 'ELOOP', 'ENOSPC'].includes(error.code)) return error.code;
  return 'RUN_FAILED';
}

if (import.meta.main) {
  (async () => {
    const options = parseOptions(process.argv.slice(2));
    if (options === null) console.log(HELP);
    else console.log(JSON.stringify(await runOfflineRetrievalProof(options)));
  })().catch((error: unknown) => {
    console.error(sanitizedError(error));
    process.exitCode = 1;
  });
}
