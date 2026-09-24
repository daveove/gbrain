import { readFileSync } from 'fs';
import type { BrainEngine } from '../engine.ts';
import { hybridSearch } from '../search/hybrid.ts';
import { slugLooksReadwise } from './junk-classify.ts';
import { computeGraphFingerprint } from './fingerprint.ts';
import type {
  RetrievalProofManifest,
  RetrievalProofQuestion,
  RetrievalProofQuestionResult,
  RetrievalProofResult,
  RetrievalScore,
} from './types.ts';
import { RETRIEVAL_PROOF_VERSION } from './types.ts';

export function parseRetrievalProofManifest(raw: string): RetrievalProofManifest {
  const parsed = JSON.parse(raw) as RetrievalProofManifest;
  if (parsed.proof_version !== RETRIEVAL_PROOF_VERSION) {
    throw new Error(`Unsupported proof_version ${parsed.proof_version}; expected ${RETRIEVAL_PROOF_VERSION}`);
  }
  if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) {
    throw new Error('Retrieval proof manifest must include questions');
  }
  return parsed;
}

function scoreQuestion(
  q: RetrievalProofQuestion,
  topSlugs: string[],
): RetrievalScore {
  const k = q.top_k ?? 10;
  const slice = topSlugs.slice(0, k);
  const forbidden = q.forbidden_slugs ?? [];
  if (forbidden.some(s => slice.includes(s))) return 'fail';

  const relevant = q.relevant_slugs ?? [];
  if (relevant.length === 0) return 'partial';

  const hits = relevant.filter(s => slice.includes(s)).length;
  const minHits = q.min_hits_in_top_k ?? 1;
  if (hits >= minHits && slice[0] && relevant.includes(slice[0])) return 'pass';
  if (hits >= minHits) return 'partial';
  return 'fail';
}

export interface RunRetrievalProofOpts {
  sourceId?: string;
  limit?: number;
}

export async function runRetrievalProof(
  engine: BrainEngine,
  manifest: RetrievalProofManifest,
  opts: RunRetrievalProofOpts = {},
): Promise<RetrievalProofResult> {
  const before = await computeGraphFingerprint(engine);
  const questions = opts.limit ? manifest.questions.slice(0, opts.limit) : manifest.questions;
  const results: RetrievalProofQuestionResult[] = [];

  for (const q of questions) {
    const hits = await hybridSearch(engine, q.query, {
      limit: q.top_k ?? 10,
      ...(opts.sourceId ? { sourceId: opts.sourceId } : {}),
    });
    const topSlugs = hits.map(h => h.slug);
    const citedReadwise = topSlugs.some(s => slugLooksReadwise(s, opts.sourceId ?? 'default'));
    results.push({
      id: q.id,
      query: q.query,
      score: scoreQuestion(q, topSlugs),
      top_slugs: topSlugs,
      cited_readwise: citedReadwise,
    });
  }

  const after = await computeGraphFingerprint(engine);
  const scores = { pass: 0, partial: 0, fail: 0 };
  for (const r of results) scores[r.score] += 1;
  const citedReadwise = results.filter(r => r.cited_readwise).length;

  return {
    passed: scores.fail === 0 && citedReadwise === 0,
    checks: {
      questions: results.length,
      scores,
      cited_readwise_pages: citedReadwise,
      production_mutations: 0,
    },
    questions: results,
    fingerprint_before: before,
    fingerprint_after: after,
  };
}

export function loadRetrievalProofFile(path: string): RetrievalProofManifest {
  return parseRetrievalProofManifest(readFileSync(path, 'utf8'));
}
