import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalNodeHash, loadHistoricalSource, verifyHistoricalSource } from '../scripts/display-projection-source.ts';
import { projectPage, type PageSnapshot } from '../scripts/display-projection.ts';

let directory: string;
const source = 'tana-example';
const root = { id: 'root', props: { name: 'Original note' }, children: ['excluded'] };
const excluded = { id: 'excluded', props: { name: 'Readwise source text' } };
const docs = Array.from({ length: 40_731 }, (_, index) => ({ id: `record-${index}`, props: { name: 'Synthetic note' } }));
const originalDocs: unknown[] = docs.slice();
originalDocs[0] = root;
originalDocs[1] = excluded;
const originalBytes = JSON.stringify({ docs: originalDocs });
const originalHash = createHash('sha256').update(originalBytes).digest('hex');
const originalPage: PageSnapshot = {
  id: 1, source_id: source, slug: 'original-note', title: 'Original note',
  compiled_truth: JSON.stringify(root), record_id: root.id,
};

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'gbrain-display-source-'));
  await writeFile(join(directory, 'original.json'), originalBytes, { mode: 0o600 });
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

describe('historical source admission', () => {
  test('rejects changed file bytes even when node identities still match', async () => {
    const changed = originalDocs.slice();
    changed[0] = { ...root, props: { name: 'Later revision' } };
    const path = join(directory, 'later.json');
    await writeFile(path, JSON.stringify({ docs: changed }), { mode: 0o600 });
    await expect(loadHistoricalSource(path, originalHash, source)).rejects.toThrow('SOURCE_HASH_MISMATCH');
  });

  test.skipIf(process.platform === 'win32')('rejects a FIFO without waiting for a writer', async () => {
    const path = join(directory, 'source-fifo');
    if (spawnSync('mkfifo', ['-m', '600', path]).status !== 0) throw new Error('Synthetic FIFO setup failed');
    await expect(loadHistoricalSource(path, originalHash, source)).rejects.toThrow('INVALID_SOURCE_FILE');
  });

  test('rejects a pinned later revision against the immutable imported record hash', async () => {
    const changed = originalDocs.slice();
    changed[0] = { ...root, props: { name: 'Later revision' } };
    const bytes = JSON.stringify({ docs: changed });
    const path = join(directory, 'pinned-later.json');
    await writeFile(path, bytes, { mode: 0o600 });
    const bundle = await loadHistoricalSource(path, createHash('sha256').update(bytes).digest('hex'), source);
    expect(() => verifyHistoricalSource(bundle, [{ page: originalPage, sourceHash: canonicalNodeHash(root) }]))
      .toThrow('SOURCE_REVISION_MISMATCH');
  });

  test('rejects source substitution and a stored body that no longer matches its provenance', async () => {
    const bundle = await loadHistoricalSource(join(directory, 'original.json'), originalHash, source);
    expect(() => verifyHistoricalSource(bundle, [{
      page: { ...originalPage, source_id: 'other-source' }, sourceHash: canonicalNodeHash(root),
    }])).toThrow('SOURCE_REVISION_MISMATCH');
    expect(() => verifyHistoricalSource(bundle, [{
      page: { ...originalPage, compiled_truth: JSON.stringify({ ...root, props: { name: 'Changed stored text' } }) },
      sourceHash: canonicalNodeHash(root),
    }])).toThrow('STORED_SOURCE_HASH_MISMATCH');
  });

  test('retains the import exclusion boundary when an original source supplies missing children', async () => {
    const bundle = await loadHistoricalSource(join(directory, 'original.json'), originalHash, source);
    verifyHistoricalSource(bundle, [{ page: originalPage, sourceHash: canonicalNodeHash(root) }]);
    const derived = projectPage(originalPage, bundle.records);
    expect(derived.display_body).toContain('Original note');
    expect(derived.display_body).not.toContain('Readwise source text');
    expect(derived.status).toBe('held');
    expect(originalPage.compiled_truth).toBe(JSON.stringify(root));
  });
});
