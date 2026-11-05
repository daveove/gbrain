/**
 * DAV-7473: a resolver looks up bare names in the database instead of reading every slug of the
 * source. The answers must equal the full basename index; the full read happens at most once, and
 * not at all for a small run. Hermetic PGLite.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildBasenameIndex, makeResolver, queryBasenameIndex } from '../src/core/link-extraction.ts';
import type { PageInput } from '../src/core/types.ts';

const page = (title: string): PageInput => ({ type: 'concept', title, compiled_truth: 'body', timeline: '' });

let engine: PGLiteEngine;
const SRC = 'big-source';
const SLUGS = [
  'people/alice-example', 'archive/alice-example', 'companies/fast-weigh', 'notes/Fast-Weigh', 'notes/Mixed_Case',
  'notes/under_score', 'notes/dot.name', 'notes/double--hyphen', 'wiki/cafe', 'wiki/Café', 'solo', 'Solo-Upper',
  'a/b/deep-name', 'tana-block-abc123-f8c8261e',
];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb)`, [SRC]);
  await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('other-source', 'other-source', '{}'::jsonb)`);
  for (const slug of SLUGS) {
    await engine.putPage(slug, page(slug), { sourceId: SRC });
  }
  await engine.putPage('elsewhere/only-other', page('x'), { sourceId: 'other-source' });
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

/** Counts full source slug reads and targeted resolver reads. */
function countReads() {
  const counts = { fullScans: 0, slugReads: 0 };
  const getAllSlugs = engine.getAllSlugs.bind(engine);
  const executeRaw = engine.executeRaw.bind(engine);
  engine.getAllSlugs = (async (opts?: { sourceId?: string }) => { counts.fullScans++; return getAllSlugs(opts); }) as typeof engine.getAllSlugs;
  engine.executeRaw = (async (sql: string, params?: unknown[]) => {
    if (/AS slugs FROM pages/.test(sql)) counts.fullScans++;
    if (/SELECT slug FROM pages WHERE source_id=\$1 AND/.test(sql)) counts.slugReads++;
    return executeRaw(sql, params);
  }) as typeof engine.executeRaw;
  return { counts, restore() { engine.getAllSlugs = getAllSlugs as typeof engine.getAllSlugs; engine.executeRaw = executeRaw as typeof engine.executeRaw; } };
}

describe('resolver basename lookup', () => {
  test('answers every name like the full basename index, in the same order', async () => {
    const full = buildBasenameIndex(await engine.getAllSlugs({ sourceId: SRC }));
    const names = ['alice-example', 'Alice-Example', 'fast-weigh', 'Fast-Weigh', 'FAST-WEIGH', 'Fast Weigh', 'mixed-case', 'Mixed_Case',
      'under_score', 'underscore', 'dot.name', 'dotname', 'double-hyphen', 'double--hyphen', 'cafe', 'Café', 'solo', 'Solo', 'SOLO-UPPER',
      'deep-name', 'tana-block-abc123-f8c8261e', 'only-other', 'never-existed', '  alice-example  ', '', '   '];
    const resolver = makeResolver(engine, { mode: 'batch', sourceId: SRC });
    for (const name of names) {
      expect(await resolver.resolveBasenameMatches!(name)).toEqual(queryBasenameIndex(full, name));
    }
  });

  test('a small run reads no full slug set and reads the irregular slugs once', async () => {
    const reads = countReads();
    try {
      const resolver = makeResolver(engine, { mode: 'batch', sourceId: SRC });
      for (let i = 0; i < 40; i++) await resolver.resolveBasenameMatches!(i % 2 ? 'alice-example' : `missing-name-${i}`);
      expect(reads.counts.fullScans).toBe(0);
      // 20 distinct missing names + 1 repeated hit: one indexed read each, plus one irregular read.
      expect(reads.counts.slugReads).toBe(21 + 1);
    } finally {
      reads.restore();
    }
  });

  test('a run past the name limit reads the whole source once and keeps answering the same', async () => {
    const full = buildBasenameIndex(await engine.getAllSlugs({ sourceId: SRC }));
    const reads = countReads();
    try {
      const resolver = makeResolver(engine, { mode: 'batch', sourceId: SRC });
      for (let i = 0; i < 400; i++) expect(await resolver.resolveBasenameMatches!(`name-${i}`)).toEqual([]);
      expect(await resolver.resolveBasenameMatches!('fast-weigh')).toEqual(queryBasenameIndex(full, 'fast-weigh'));
      expect(await resolver.resolveBasenameMatches!('Solo')).toEqual(queryBasenameIndex(full, 'Solo'));
      expect(reads.counts.fullScans).toBe(1);
    } finally {
      reads.restore();
    }
  });

  test('a resolver without a source keeps the full read', async () => {
    const reads = countReads();
    try {
      const resolver = makeResolver(engine, { mode: 'batch' });
      expect(await resolver.resolveBasenameMatches!('only-other')).toEqual(['elsewhere/only-other']);
      expect(await resolver.resolveBasenameMatches!('solo')).toEqual(['solo']);
      expect(reads.counts.fullScans).toBe(1);
    } finally {
      reads.restore();
    }
  });
});
