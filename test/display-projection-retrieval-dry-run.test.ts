import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOfflineRetrievalProof, type RetrievalProofOptions } from '../scripts/display-projection-retrieval-dry-run.ts';
import { canonicalNodeHash } from '../scripts/display-projection-source.ts';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = 'tana-export-20250131';
const root = { id: 'root', props: { name: 'Synthetic original note' }, children: [] };
const excluded = { id: 'excluded', props: { name: 'Synthetic Readwise note' }, children: [] };
const docs = Array.from({ length: 40_731 }, (_, index) => ({
  id: `synthetic-record-${index}`, props: { name: 'Synthetic note' }, children: [] as string[],
}));
docs[0] = root;
docs[1] = excluded;
const originalBytes = JSON.stringify({ docs });
const originalHash = hash(originalBytes);
let inputs: string;
let outputs: string;
let sequence = 0;

function hash(bytes: string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function fixture() {
  return {
    schema_version: 1,
    provenance: {
      historical_packet_seal_sha256: 'f30dc5b6384fafdfc0e7e6b244ca44c755b2ccc53fc360f19d7e18ed176a4ad5',
      historical_packet_complete: false,
      query_source_sha256: 'bcd9e8dd5327aa00776533a5f9389add60ea0835cc6d3bf1ece94728fd174ecf',
      assessment_source_sha256: '8014f7b4d58257f7896525003d33f100664defadab45285bc4e45dc00dfa9020',
      authoring_history_sha256: '81ba963cf8dfedc0f3422814da760761fabe5a668b1bd18840ebef79ae781796',
    },
    questions: Array.from({ length: 10 }, (_, index) => ({
      id: index + 1, query: `Synthetic query ${index + 1}`, expected: 'Synthetic evidence', kind: 'synthetic',
      assessment: {
        id: index + 1,
        score: index === 0 ? 'pass' : index < 4 ? 'partial' : 'fail',
        citations: [1, 2, 333333], finding: 'Synthetic finding', gap: index === 0 ? null : 'Synthetic gap',
      },
    })),
  };
}

function snapshot() {
  const rows = [
    { page_id: 1, title: root.props.name, chunk_id: 11, chunk_text: 'Synthetic root chunk', score: 0.5,
      source_id: source, slug: 'synthetic-root', readwise_excluded: false },
    { page_id: 2, title: excluded.props.name, chunk_id: 12, chunk_text: 'Synthetic excluded chunk', score: 0.4,
      source_id: source, slug: 'synthetic-excluded', readwise_excluded: false },
    { page_id: 333333, title: 'Synthetic external excluded page', chunk_id: 13, chunk_text: 'Synthetic external chunk', score: 0.3,
      source_id: 'synthetic-other', slug: 'synthetic-other', readwise_excluded: true },
  ];
  const before = Array.from({ length: 10 }, (_, index) => ({ id: index + 1, results: structuredClone(rows) }));
  return {
    schema_version: 1,
    source_id: source,
    pages: [root, excluded].map((node, index) => ({
      id: index + 1, slug: index === 0 ? 'synthetic-root' : 'synthetic-excluded', source_id: source,
      title: node.props.name, compiled_truth: JSON.stringify(node), record_id: node.id, sourceHash: canonicalNodeHash(node),
    })),
    before,
    after: structuredClone(before),
    database: { transaction_read_only: 'on', pooler_port: 6543, page_and_chunk_snapshot_unchanged: true },
    native_search: {
      implementation: 'PostgresEngine.searchKeyword', query_expansion: false,
      vector_exercised: false, semantic_grading_exercised: false,
    },
  };
}

async function options(fixtureValue: unknown = fixture(), snapshotValue: unknown = snapshot()): Promise<RetrievalProofOptions> {
  const name = `case-${++sequence}`;
  const fixtureBytes = JSON.stringify(fixtureValue);
  const snapshotBytes = JSON.stringify(snapshotValue);
  const fixturePath = join(inputs, `${name}-fixture.json`);
  const snapshotPath = join(inputs, `${name}-snapshot.json`);
  await writeFile(fixturePath, fixtureBytes, { mode: 0o600 });
  await writeFile(snapshotPath, snapshotBytes, { mode: 0o600 });
  return {
    fixture: fixturePath, fixtureSha256: hash(fixtureBytes), snapshot: snapshotPath, snapshotSha256: hash(snapshotBytes),
    sourceRecords: join(inputs, 'source.json'), sourceRecordsSha256: originalHash,
    receipt: join(outputs, `${name}.json`),
  };
}

beforeAll(async () => {
  inputs = await mkdtemp(join(tmpdir(), 'gbrain-offline-retrieval-'));
  await mkdir(join(repository, 'out'), { recursive: true });
  outputs = await mkdtemp(join(repository, 'out', 'dav6220-retrieval-test-'));
  await writeFile(join(inputs, 'source.json'), originalBytes, { mode: 0o600 });
});

afterAll(async () => {
  await rm(inputs, { recursive: true, force: true });
  await rm(outputs, { recursive: true, force: true });
});

describe('offline display retrieval integrity', () => {
  test('excludes original Readwise roots and flagged rows without treating historical scores as new grades', async () => {
    const input = await options();
    const result = await runOfflineRetrievalProof(input);
    expect(result.counts).toMatchObject({
      questions: 10, source_records: 40_731, verified_source_roots: 2,
      projected_pages: 2, complete: 1, held: 1, idempotency_failures: 0,
      excluded_readwise_source_records: 1, excluded_readwise_roots: 1,
      raw_results_before: 30, raw_results_after: 30, eligible_results_before: 10, eligible_results_after: 10,
    });
    const receipt = JSON.parse(await readFile(input.receipt, 'utf8')) as {
      historical_packet: { complete: boolean; historical_seal_bytes_verified: boolean };
      grading: {
        current_manual_grading_exercised: boolean; semantic_improvement_established: boolean;
        original_historical_manual_scores: { pass: number; partial: number; fail: number };
      };
      questions: Array<{
        original_citation_count: number; original_citations_retained_before: number; original_citations_retained_after: number;
        raw_count_before: number; eligible_count_before: number;
      }>;
    };
    expect(receipt.historical_packet.complete).toBe(false);
    expect(receipt.historical_packet.historical_seal_bytes_verified).toBe(false);
    expect(receipt.grading.current_manual_grading_exercised).toBe(false);
    expect(receipt.grading.semantic_improvement_established).toBe(false);
    expect(receipt.grading.original_historical_manual_scores).toEqual({ pass: 1, partial: 3, fail: 6 });
    expect(receipt.questions.map((question) => [
      question.raw_count_before, question.eligible_count_before, question.original_citation_count,
      question.original_citations_retained_before, question.original_citations_retained_after,
    ])).toEqual(Array.from({ length: 10 }, () => [3, 1, 3, 1, 1]));
    expect((await stat(input.receipt)).mode & 0o777).toBe(0o600);
    await expect(runOfflineRetrievalProof(input)).rejects.toMatchObject({ code: 'EEXIST' });
  });

  test('rejects changed fixture bytes despite valid JSON and matching identities', async () => {
    const input = await options();
    await writeFile(input.fixture, `${await readFile(input.fixture, 'utf8')}\n`);
    await expect(runOfflineRetrievalProof(input)).rejects.toThrow('FIXTURE_HASH_MISMATCH');
  });

  test('rejects duplicate IDs, mismatched assessment IDs and malformed citation types with exact file pins', async () => {
    const duplicate = fixture();
    duplicate.questions[9].id = 1;
    await expect(runOfflineRetrievalProof(await options(duplicate))).rejects.toThrow('INVALID_FIXTURE');
    const mismatched = fixture();
    mismatched.questions[0].assessment.id = 2;
    await expect(runOfflineRetrievalProof(await options(mismatched))).rejects.toThrow('INVALID_FIXTURE');
    const malformed = fixture();
    const invalid = { ...malformed, questions: malformed.questions.map((question, index) => index === 0
      ? { ...question, assessment: { ...question.assessment, citations: ['1'] } } : question) };
    await expect(runOfflineRetrievalProof(await options(invalid))).rejects.toThrow('INVALID_FIXTURE');
  });

  test('rejects native score drift and native rank drift across excluded rows', async () => {
    const scoreDrift = snapshot();
    scoreDrift.after[0].results[0].score = 0.6;
    await expect(runOfflineRetrievalProof(await options(fixture(), scoreDrift))).rejects.toThrow('NATIVE_RESULT_DRIFT');
    const excludedDrift = snapshot();
    excludedDrift.after[0].results[2].score = 0.9;
    await expect(runOfflineRetrievalProof(await options(fixture(), excludedDrift))).rejects.toThrow('NATIVE_RESULT_DRIFT');
    const rankDrift = snapshot();
    [rankDrift.after[0].results[0], rankDrift.after[0].results[1]] = [rankDrift.after[0].results[1], rankDrift.after[0].results[0]];
    await expect(runOfflineRetrievalProof(await options(fixture(), rankDrift))).rejects.toThrow('NATIVE_RESULT_DRIFT');
  });

  test('retains chunkless hybrid evidence and counts original citations across both channels', async () => {
    const base = snapshot();
    const hybridRows = [base.before[0].results[0], {
      page_id: 4, title: 'Synthetic exact-title page', chunk_id: null, chunk_text: null, score: 0.7,
      source_id: 'synthetic-other', slug: 'synthetic-exact-title', readwise_excluded: false,
    }];
    const before = base.before.map((question) => ({ ...question, hybrid_results: structuredClone(hybridRows) }));
    const captured = {
      ...base, before, after: structuredClone(before),
      native_search: { ...base.native_search, hybrid_implementation: 'hybridSearch', hybrid_exercised: true },
    };
    const original = fixture();
    const criteria = { ...original, questions: original.questions.map((question) => ({
      ...question, assessment: { ...question.assessment, citations: [1, 4, 2, 333333] },
    })) };
    const input = await options(criteria, captured);
    const proof = await runOfflineRetrievalProof(input);
    expect(proof.counts.eligible_hybrid_results_before).toBe(20);
    expect(proof.counts.eligible_hybrid_results_after).toBe(20);
    const receipt = JSON.parse(await readFile(input.receipt, 'utf8'));
    expect(receipt.questions.map((question: { original_citations_retained_before: number; original_citations_retained_after: number }) => [
      question.original_citations_retained_before, question.original_citations_retained_after,
    ])).toEqual(Array.from({ length: 10 }, () => [2, 2]));
    const drift = structuredClone(captured);
    drift.after[0].hybrid_results[1].score = 0.8;
    await expect(runOfflineRetrievalProof(await options(criteria, drift))).rejects.toThrow('NATIVE_RESULT_DRIFT');
  });

  test('retains distinct native chunks from the same page and rejects duplicate result identities', async () => {
    const base = snapshot();
    const first = base.before[0].results[0];
    const before = base.before.map((question) => ({
      ...question, hybrid_results: [first, { ...first, chunk_id: 999, chunk_text: 'Synthetic second chunk', score: 0.4 }],
    }));
    const captured = {
      ...base, before, after: structuredClone(before),
      native_search: { ...base.native_search, hybrid_implementation: 'hybridSearch', hybrid_exercised: true },
    };
    const proof = await runOfflineRetrievalProof(await options(fixture(), captured));
    expect(proof.counts.eligible_hybrid_results_before).toBe(20);
    const duplicate = structuredClone(captured);
    duplicate.before[0].hybrid_results[1] = duplicate.before[0].hybrid_results[0];
    duplicate.after = structuredClone(duplicate.before);
    await expect(runOfflineRetrievalProof(await options(fixture(), duplicate))).rejects.toThrow('INVALID_SNAPSHOT');
  });

  test('rejects an arbitrary pinned ledger as the original historical seal', async () => {
    const input = await options();
    const path = join(inputs, 'not-original-seal.json');
    const bytes = JSON.stringify({ rows: [] });
    await writeFile(path, bytes, { mode: 0o600 });
    await expect(runOfflineRetrievalProof({ ...input, historicalSeal: path })).rejects.toThrow('INVALID_SEAL_OPTIONS');
    await expect(runOfflineRetrievalProof({
      ...input, historicalSeal: path, historicalSealSha256: hash(bytes),
    })).rejects.toThrow('INVALID_HISTORICAL_SEAL');
  });

  test('rejects a hash-pinned later source revision against every immutable imported root', async () => {
    const input = await options();
    const later = docs.slice();
    later[0] = { ...root, props: { name: 'Synthetic later revision' } };
    const bytes = JSON.stringify({ docs: later });
    const path = join(inputs, 'later-source.json');
    await writeFile(path, bytes, { mode: 0o600 });
    await expect(runOfflineRetrievalProof({ ...input, sourceRecords: path, sourceRecordsSha256: hash(bytes) }))
      .rejects.toThrow('SOURCE_REVISION_MISMATCH');
  });

  test('refuses public inputs and receipt symlink escapes', async () => {
    const input = await options();
    await chmod(input.fixture, 0o644);
    await expect(runOfflineRetrievalProof(input)).rejects.toThrow('INVALID_FIXTURE_FILE');
    await chmod(input.fixture, 0o600);
    const link = join(outputs, 'outside');
    await symlink(inputs, link, 'dir');
    await expect(runOfflineRetrievalProof({ ...input, receipt: join(link, 'escaped.json') })).rejects.toThrow('UNSAFE_RECEIPT_PATH');
  });

  test('prints only a fixed error code when private input parsing fails', async () => {
    const input = await options();
    const privateBytes = 'Synthetic private invalid JSON payload';
    await writeFile(input.fixture, privateBytes);
    const child = Bun.spawn([
      process.execPath, join(repository, 'scripts/display-projection-retrieval-dry-run.ts'),
      '--fixture', input.fixture, '--fixture-sha256', hash(privateBytes),
      '--snapshot', input.snapshot, '--snapshot-sha256', input.snapshotSha256,
      '--source-records', input.sourceRecords, '--source-records-sha256', input.sourceRecordsSha256,
      '--receipt', input.receipt,
    ], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ stdout, stderr, code }).toEqual({ stdout: '', stderr: 'INVALID_FIXTURE_JSON\n', code: 1 });
  });
});
