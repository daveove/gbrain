import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { PageSnapshot, ReferenceSnapshot } from './display-projection.ts';

const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const ORIGINAL_RECORD_COUNT = 40_731;

export interface SourceBundle {
  source: string;
  sha256: string;
  records: ReadonlyMap<string, ReferenceSnapshot>;
  recordHashes: ReadonlyMap<string, string>;
  excludedReadwise: number;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function canonicalNodeHash(node: unknown): string {
  const serialized = JSON.stringify(node, (_key, value: unknown) => {
    if (!object(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]));
  });
  if (serialized === undefined) throw new Error('INVALID_SOURCE_RECORD');
  return createHash('sha256').update(serialized).digest('hex');
}

export async function loadHistoricalSource(path: string, expectedHash: string, source: string): Promise<SourceBundle> {
  if (!/^[a-f0-9]{64}$/i.test(expectedHash)) throw new Error('INVALID_SOURCE_HASH');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes: Buffer;
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > MAX_SOURCE_BYTES) throw new Error('INVALID_SOURCE_FILE');
    bytes = await file.readFile();
    const after = await file.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== before.size) {
      throw new Error('SOURCE_FILE_CHANGED');
    }
  } finally {
    await file.close();
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== expectedHash.toLowerCase()) throw new Error('SOURCE_HASH_MISMATCH');
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('INVALID_SOURCE_JSON');
  }
  const docs = Array.isArray(value) ? value : object(value) && Array.isArray(value.docs) ? value.docs : null;
  if (docs === null || docs.length !== ORIGINAL_RECORD_COUNT) throw new Error('INVALID_ORIGINAL_EXPORT');
  const records = new Map<string, ReferenceSnapshot>();
  const recordHashes = new Map<string, string>();
  let excludedReadwise = 0;
  for (const doc of docs) {
    if (!object(doc) || typeof doc.id !== 'string' || !doc.id || !object(doc.props)) {
      throw new Error('INVALID_SOURCE_RECORD');
    }
    if (records.has(doc.id)) throw new Error('DUPLICATE_SOURCE_RECORD');
    const serialized = JSON.stringify(doc);
    const readwise = /readwise/i.test(serialized);
    if (readwise) excludedReadwise++;
    records.set(doc.id, { source_id: source, record_id: doc.id, compiled_truth: serialized, readwise });
    recordHashes.set(doc.id, canonicalNodeHash(doc));
  }
  return { source, sha256, records, recordHashes, excludedReadwise };
}

export function verifyHistoricalSource(
  bundle: SourceBundle,
  pages: readonly { page: PageSnapshot; sourceHash: string | null }[],
): number {
  for (const { page, sourceHash } of pages) {
    if (page.source_id !== bundle.source || page.record_id === null || sourceHash === null
      || bundle.recordHashes.get(page.record_id) !== sourceHash) {
      throw new Error('SOURCE_REVISION_MISMATCH');
    }
    let stored: unknown;
    try {
      stored = JSON.parse(page.compiled_truth);
    } catch {
      throw new Error('INVALID_STORED_SOURCE');
    }
    if (canonicalNodeHash(stored) !== sourceHash) throw new Error('STORED_SOURCE_HASH_MISMATCH');
  }
  return pages.length;
}
