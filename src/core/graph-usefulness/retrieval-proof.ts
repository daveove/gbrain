import { readFileSync } from 'fs';
import type { BrainEngine } from '../engine.ts';
import { hybridSearch } from '../search/hybrid.ts';
import { slugLooksReadwise } from './junk-classify.ts';
import { computeGraphFingerprint } from './fingerprint.ts';
import type {
  GraphFingerprint,
  RetrievalPageRef,
  RetrievalProofManifest,
  RetrievalProofQuestion,
  RetrievalProofQuestionResult,
  RetrievalProofResult,
  RetrievalScore,
} from './types.ts';
import { RETRIEVAL_PROOF_VERSION } from './types.ts';

export class SlugOnlyProofNeedsSourceError extends Error {
  constructor() {
    super(
      'Retrieval proof lists bare slugs. Pass a single --source so hits are scored as (source_id, slug), or use relevant_pages and forbidden_pages with source_id.',
    );
    this.name = 'SlugOnlyProofNeedsSourceError';
  }
}

export function retrievalHitKey(
  hit: { slug: string; source_id?: string },
  sourceId?: string,
): string {
  const sid = hit.source_id ?? sourceId ?? 'default';
  return `${sid}::${hit.slug}`;
}

function pageRefKey(ref: RetrievalPageRef): string {
  if (!ref?.source_id || !ref?.slug) {
    throw new Error('relevant_pages and forbidden_pages entries require source_id and slug');
  }
  return `${ref.source_id}::${ref.slug}`;
}

/** True when any question lists bare slugs that are not source-qualified. */
export function manifestUsesBareSlugs(manifest: RetrievalProofManifest): boolean {
  return manifest.questions.some(q =>
    (q.relevant_slugs?.length ?? 0) > 0 || (q.forbidden_slugs?.length ?? 0) > 0,
  );
}

function expectationKeys(
  pages: RetrievalPageRef[] | undefined,
  slugs: string[] | undefined,
  sourceId: string | undefined,
): string[] {
  const keys = (pages ?? []).map(pageRefKey);
  if ((slugs?.length ?? 0) > 0) {
    if (!sourceId) throw new SlugOnlyProofNeedsSourceError();
    for (const slug of slugs ?? []) keys.push(`${sourceId}::${slug}`);
  }
  return keys;
}

/** Missing threshold defaults to 1. Zero, negative, and non-integers are rejected. */
function positiveHitThreshold(value: unknown, questionId: string): number {
  if (value === undefined) return 1;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`Question ${questionId}: min_hits_in_top_k must be a positive integer`);
  }
  return value;
}

export function parseRetrievalProofManifest(raw: string): RetrievalProofManifest {
  const parsed = JSON.parse(raw) as RetrievalProofManifest;
  if (parsed.proof_version !== RETRIEVAL_PROOF_VERSION) {
    throw new Error(`Unsupported proof_version ${parsed.proof_version}; expected ${RETRIEVAL_PROOF_VERSION}`);
  }
  if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) {
    throw new Error('Retrieval proof manifest must include questions');
  }
  for (const q of parsed.questions) {
    positiveHitThreshold(q.min_hits_in_top_k, q.id || '(missing id)');
  }
  return parsed;
}

/**
 * Score one question against source-qualified hits.
 * Bare `relevant_slugs` / `forbidden_slugs` require `sourceId`.
 * `relevant_pages` / `forbidden_pages` already carry `(source_id, slug)`.
 */
export function scoreRetrievalQuestion(
  q: RetrievalProofQuestion,
  hits: Array<{ slug: string; source_id?: string }>,
  sourceId?: string,
): RetrievalScore {
  const k = q.top_k ?? 10;
  const slice = hits.slice(0, k).map(h => retrievalHitKey(h, sourceId));
  const forbidden = expectationKeys(q.forbidden_pages, q.forbidden_slugs, sourceId);
  if (forbidden.some(s => slice.includes(s))) return 'fail';

  const relevant = expectationKeys(q.relevant_pages, q.relevant_slugs, sourceId);
  if (relevant.length === 0) return 'partial';

  const matched = relevant.filter(s => slice.includes(s)).length;
  const minHits = positiveHitThreshold(q.min_hits_in_top_k, q.id || '(missing id)');
  if (matched >= minHits && slice[0] && relevant.includes(slice[0])) return 'pass';
  if (matched >= minHits) return 'partial';
  return 'fail';
}

export interface RunRetrievalProofOpts {
  sourceId?: string;
  limit?: number;
}

/**
 * Non-zero when the graph fingerprint changed during the proof.
 * A matching sha256 is the only zero. Any difference is at least 1 so a
 * changing graph cannot be reported as production_mutations: 0.
 */
export function retrievalProofMutationCount(
  before: GraphFingerprint,
  after: GraphFingerprint,
): number {
  if (before.sha256 === after.sha256) return 0;
  const delta =
    Math.abs(after.active_pages - before.active_pages)
    + Math.abs(after.link_rows - before.link_rows)
    + Math.abs(after.valid_links - before.valid_links)
    + Math.abs(after.zero_degree_pages - before.zero_degree_pages);
  return Math.max(1, delta);
}

/** Pass requires no failed questions, no Readwise cites, and an unchanged graph. */
export function retrievalProofPassed(
  failCount: number,
  citedReadwise: number,
  productionMutations: number,
): boolean {
  return failCount === 0 && citedReadwise === 0 && productionMutations === 0;
}

/** True when any hit carries Readwise lineage via slug or source_id. */
export function hitsIncludeReadwiseLineage(
  hits: Array<{ slug: string; source_id?: string }>,
  scopeSourceId?: string,
): boolean {
  return hits.some(h =>
    slugLooksReadwise(h.slug, h.source_id ?? scopeSourceId ?? 'default'),
  );
}

export async function runRetrievalProof(
  engine: BrainEngine,
  manifest: RetrievalProofManifest,
  opts: RunRetrievalProofOpts = {},
): Promise<RetrievalProofResult> {
  if (manifestUsesBareSlugs(manifest) && !opts.sourceId) {
    throw new SlugOnlyProofNeedsSourceError();
  }

  const before = await computeGraphFingerprint(engine);
  const questions = opts.limit ? manifest.questions.slice(0, opts.limit) : manifest.questions;
  const results: RetrievalProofQuestionResult[] = [];

  for (const q of questions) {
    const hits = await hybridSearch(engine, q.query, {
      limit: q.top_k ?? 10,
      ...(opts.sourceId ? { sourceId: opts.sourceId } : {}),
    });
    const topPages: RetrievalPageRef[] = hits.map(h => ({
      source_id: h.source_id ?? opts.sourceId ?? 'default',
      slug: h.slug,
    }));
    const citedReadwise = hitsIncludeReadwiseLineage(hits, opts.sourceId);
    results.push({
      id: q.id,
      query: q.query,
      score: scoreRetrievalQuestion(q, topPages, opts.sourceId),
      top_slugs: topPages.map(p => p.slug),
      top_pages: topPages,
      cited_readwise: citedReadwise,
    });
  }

  const after = await computeGraphFingerprint(engine);
  const scores = { pass: 0, partial: 0, fail: 0 };
  for (const r of results) scores[r.score] += 1;
  const citedReadwise = results.filter(r => r.cited_readwise).length;
  const productionMutations = retrievalProofMutationCount(before, after);

  return {
    passed: retrievalProofPassed(scores.fail, citedReadwise, productionMutations),
    checks: {
      questions: results.length,
      scores,
      cited_readwise_pages: citedReadwise,
      production_mutations: productionMutations,
    },
    questions: results,
    fingerprint_before: before,
    fingerprint_after: after,
  };
}

export function loadRetrievalProofFile(path: string): RetrievalProofManifest {
  return parseRetrievalProofManifest(readFileSync(path, 'utf8'));
}
