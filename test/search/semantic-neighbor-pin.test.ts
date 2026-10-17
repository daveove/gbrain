import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ensureRelationalEvidenceSlot } from '../../src/core/search/relational-recall.ts';
import { ensureSemanticNeighborSlot } from '../../src/core/search/semantic-neighbor-pin.ts';
import type { SearchResult } from '../../src/core/types.ts';

function row(slug: string, score: number, cosine: number): SearchResult {
  return {
    slug, score, cosine, source_id: 'default', title: slug, chunk_text: '',
    page_id: 1, type: 'note', chunk_source: 'compiled_truth', chunk_id: 1, chunk_index: 0, stale: false,
  };
}

describe('semantic neighbor pin', () => {
  test('promotes a near-best cosine page buried by lexical fusion to rank 3', () => {
    const pool = [
      row('lexical-a', 1.045, 0.6909),
      row('nearest', 1.014, 0.7295),
      row('lexical-b', 0.768, 0.5475),
      row('mid', 0.70, 0.7043),
      ...Array.from({ length: 87 }, (_, i) => row(`other-${i}`, 0.5 - i * 0.001, 0.4)),
      row('topic', 0.22, 0.7166),
    ];
    const { pool: out, decision } = ensureSemanticNeighborSlot(pool, 10, 0);
    expect(decision).toEqual({
      action: 'promoted', slug: 'topic', source_id: 'default', from_rank: 91, cosine: 0.7166,
    });
    expect(out.slice(0, 3).map(r => r.slug)).toEqual(['lexical-a', 'nearest', 'topic']);
    expect(out[2].score).toBeGreaterThan(out[3].score);
    expect(out[2].score).toBeLessThan(out[1].score);
    expect(out.map(r => r.slug).filter(s => s === 'topic')).toHaveLength(1);
  });

  test('does not promote a near neighbor that is already inside the result window', () => {
    const pool = [
      row('lexical-a', 1.0, 0.50),
      row('nearest', 0.95, 0.80),
      row('lexical-b', 0.9, 0.40),
      row('on-page', 0.85, 0.795),
      ...Array.from({ length: 6 }, (_, i) => row(`filler-${i}`, 0.6 - i * 0.01, 0.3)),
    ];
    const { pool: out, decision } = ensureSemanticNeighborSlot(pool, 10, 0);
    expect(decision).toBeUndefined();
    expect(out.map(r => r.slug)).toEqual(pool.map(r => r.slug));
  });

  test('leaves a near neighbor already inside the result window in fused order', () => {
    const pool = [
      row('lexical-a', 1.0, 0.50),
      row('nearest', 0.95, 0.80),
      row('lexical-b', 0.9, 0.40),
      row('on-page', 0.85, 0.795),
      ...Array.from({ length: 6 }, (_, i) => row(`filler-${i}`, 0.6 - i * 0.01, 0.3)),
      row('buried', 0.2, 0.79),
    ];
    const { pool: out, decision } = ensureSemanticNeighborSlot(pool, 10, 0);
    expect(decision?.slug).toBe('buried');
    expect(out.slice(0, 4).map(r => r.slug)).toEqual(['lexical-a', 'nearest', 'buried', 'lexical-b']);
    expect(out[4].slug).toBe('on-page');
  });

  test('leaves the list alone when the near neighbor is already in the top 3', () => {
    const pool = [
      row('nearest', 1, 0.73),
      row('topic', 0.9, 0.72),
      row('lexical', 0.8, 0.4),
      row('other', 0.7, 0.3),
    ];
    const { pool: out, decision } = ensureSemanticNeighborSlot(pool, 10, 0);
    expect(decision).toBeUndefined();
    expect(out.map(r => r.slug)).toEqual(pool.map(r => r.slug));
  });

  test('does not promote a neighbor outside the cosine gap or below the floor', () => {
    const wide = [
      row('nearest', 1, 0.9),
      row('second', 0.8, 0.5),
      row('third', 0.7, 0.4),
      row('buried', 0.2, 0.85),
    ];
    expect(ensureSemanticNeighborSlot(wide, 10, 0).decision).toBeUndefined();
    const low = [
      row('a', 1, 0.6),
      row('b', 0.9, 0.59),
      row('c', 0.8, 0.58),
      row('d', 0.2, 0.595),
    ];
    expect(ensureSemanticNeighborSlot(low, 10, 0).decision).toBeUndefined();
  });

  test('skips later pages and short limits', () => {
    const pool = [row('a', 1, 0.8), row('b', 0.9, 0.79), row('c', 0.8, 0.2), row('d', 0.1, 0.795)];
    expect(ensureSemanticNeighborSlot(pool, 10, 5).decision).toBeUndefined();
    expect(ensureSemanticNeighborSlot(pool, 2, 0).decision).toBeUndefined();
  });

  test('pinning before the relational slot keeps that answer inside the page', () => {
    const limit = 4;
    const pool = [
      row('lexical-a', 1.0, 0.50),
      row('nearest', 0.9, 0.80),
      row('lexical-b', 0.8, 0.40),
      row('filler', 0.7, 0.30),
      row('other', 0.6, 0.20),
      row('relational', 0.5, 0.10),
      row('topic', 0.2, 0.79),
    ];
    const relational = [row('relational', 0.5, 0.10)];
    const page = (rows: SearchResult[]) => rows.slice(0, limit).map(r => r.slug);

    const pinnedFirst = ensureSemanticNeighborSlot(pool, limit, 0).pool;
    const safe = ensureRelationalEvidenceSlot(pinnedFirst, relational, limit, 0).pool;
    expect(safe[2].slug).toBe('topic');
    expect(page(safe)).toContain('relational');

    const relationalFirst = ensureRelationalEvidenceSlot(pool, relational, limit, 0).pool;
    const unsafe = ensureSemanticNeighborSlot(relationalFirst, limit, 0).pool;
    expect(page(unsafe)).not.toContain('relational');
    expect(unsafe[limit].slug).toBe('relational');
  });
});

test('rank.ts promotes the semantic neighbor before the relational slot', () => {
  const src = readFileSync(new URL('../../src/core/search/hybrid/rank.ts', import.meta.url), 'utf8');
  const semantic = src.indexOf('ensureSemanticNeighborSlot(returnPool');
  const relational = src.indexOf('ensureRelationalEvidenceSlot(returnPool');
  expect(semantic).toBeGreaterThan(-1);
  expect(relational).toBeGreaterThan(semantic);
});
