/**
 * DAV-7120 — short-query lexical anchor (src/core/search/lexical-anchor.ts).
 *
 * Hermetic corpus (in-memory PGLite + deterministic basisEmbedding):
 *   - NAME page: the codename appears in its body, NO embedding (the vector
 *     arm never sees it), so it reaches fusion through the keyword arm only.
 *   - NEIGHBOUR page: embedded at the query's basis dim (vector #1, cosine 1)
 *     and never mentions the codename.
 *
 * Without the anchor the neighbour wins rank 1 (RRF tie, cosine breaks it);
 * the anchor lifts the keyword arm's #1 to rank 1 for short queries only.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import { findLexicalAnchor, LEXICAL_ANCHOR_KEY } from '../../src/core/search/lexical-anchor.ts';
import { basisEmbedding } from '../../src/eval/deterministic-embed.ts';
import type { SearchResult } from '../../src/core/types.ts';

const DIM = 1536;
const QUERY_DIM = 7;
const NAME = 'concepts/primary-agents-example';
const NEIGHBOUR = 'people/jedi-example';
const NAME_TEXT = 'Primary agents such as Mandalorian orchestrate: the codename orchestrator seat plans and delegates.';
const NEIGHBOUR_TEXT = 'Jedi Example is a person on the team who joined in 2025.';

function row(slug: string, overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    slug, page_id: 1, title: slug, type: 'concept', chunk_text: '', chunk_source: 'compiled_truth',
    chunk_id: slug.length, chunk_index: 0, score: 1, stale: false, ...overrides,
  };
}

describe('findLexicalAnchor (pure)', () => {
  const name = row(NAME, { score: 0.8, chunk_id: 1 });
  const neighbour = row(NEIGHBOUR, { score: 1.1, chunk_id: 2 });
  const lists = { keywordFusionList: [name], titleFusionList: [], relationalList: [] };

  test('short query, vector-only rank 1, strict keyword hit → the keyword #1 row', () => {
    expect(findLexicalAnchor([neighbour, name], 'Mandalorian', lists)).toBe(name);
    expect(findLexicalAnchor([neighbour, name], 'the Yoda agent', lists)).toBe(name);
  });

  test('no-ops: lexical rank 1, long query, empty or relaxed-only keyword arm, single row', () => {
    expect(findLexicalAnchor([name, neighbour], 'Mandalorian', lists)).toBeNull();
    expect(findLexicalAnchor([neighbour, name], 'which agent watches outbound network traffic', lists)).toBeNull();
    expect(findLexicalAnchor([neighbour, name], 'Mandalorian', { ...lists, keywordFusionList: [] })).toBeNull();
    const relaxed = row(NAME, { score: 0.8, chunk_id: 1, keyword_relaxed: true });
    expect(findLexicalAnchor([neighbour, relaxed], 'Mandalorian', { ...lists, keywordFusionList: [relaxed] })).toBeNull();
    expect(findLexicalAnchor([neighbour], 'Mandalorian', lists)).toBeNull();
  });

  test('a title or relational vote on rank 1 counts as lexical', () => {
    expect(findLexicalAnchor([neighbour, name], 'Mandalorian', { ...lists, titleFusionList: [neighbour] })).toBeNull();
    expect(findLexicalAnchor([neighbour, name], 'Mandalorian', { ...lists, relationalList: [neighbour] })).toBeNull();
  });

  test('a penalized or unverified keyword #1 is never lifted', () => {
    for (const penalty of [
      { superseded: true }, { supersede_penalty: 0.5 }, { generated_demotion: 0.5 },
      { injection_suspected: true as const }, { unverified: true },
    ]) {
      const penalized = row(NAME, { score: 0.4, chunk_id: 1, ...penalty });
      expect(findLexicalAnchor([neighbour, penalized], 'Mandalorian', { ...lists, keywordFusionList: [penalized] })).toBeNull();
    }
  });
});

let engine: PGLiteEngine;

beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: DIM, env: {} });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.putPage(NAME, { type: 'concept', title: 'Primary agents example', compiled_truth: NAME_TEXT, timeline: '' });
  await installFixtureChunks(engine, NAME, [{ chunk_index: 0, chunk_text: NAME_TEXT, chunk_source: 'compiled_truth', token_count: 20 }]);
  await engine.putPage(NEIGHBOUR, { type: 'person', title: 'Jedi Example', compiled_truth: NEIGHBOUR_TEXT, timeline: '' });
  await installFixtureChunks(engine, NEIGHBOUR, [{
    chunk_index: 0, chunk_text: NEIGHBOUR_TEXT, chunk_source: 'compiled_truth', embedding: basisEmbedding(QUERY_DIM, DIM), token_count: 14,
  }]);
}, 120_000);

afterAll(async () => {
  resetGateway();
  await engine.disconnect();
});

const run = (query: string) => hybridSearch(engine, query, {
  limit: 5,
  queryEmbedFn: () => basisEmbedding(QUERY_DIM, DIM),
});

describe('lexical anchor through hybridSearch (hermetic)', () => {
  test('short name query: the page naming it takes rank 1; the vector neighbour drops to rank 2', async () => {
    const results = await run('Mandalorian');
    expect(results.map((r) => r.slug)).toEqual([NAME, NEIGHBOUR]);
    expect(results[0].lexical_anchor_boost).toBeGreaterThan(1);
  });

  test('search.lexical_anchor=false restores the fused order', async () => {
    try {
      await engine.setConfig(LEXICAL_ANCHOR_KEY, 'false');
      const results = await run('Mandalorian');
      expect(results.map((r) => r.slug)).toEqual([NEIGHBOUR, NAME]);
      expect(results[1].lexical_anchor_boost).toBeUndefined();
    } finally {
      await engine.setConfig(LEXICAL_ANCHOR_KEY, 'true');
    }
  });

  test('a longer query keeps the fused order (vector neighbour first)', async () => {
    const results = await run('Mandalorian codename orchestrator seat');
    expect(results.map((r) => r.slug)).toEqual([NEIGHBOUR, NAME]);
    expect(results.some((r) => r.lexical_anchor_boost !== undefined)).toBe(false);
  });
});
