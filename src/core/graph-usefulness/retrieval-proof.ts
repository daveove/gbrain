import { readFileSync } from 'fs';
import type { BrainEngine } from '../engine.ts';
import { hybridSearch } from '../search/hybrid.ts';
import { isValidSourceId, ALL_SOURCES } from '../source-id.ts';
import { resolveSourceId, SourceTargetError } from '../source-resolver.ts';
import { slugLooksReadwise } from './junk-classify.ts';
import { computeGraphFingerprint } from './fingerprint.ts';
import { readProofSearchPin, type PinnedProofSearch } from './search-pin.ts';
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

function questionLabel(q: { id?: string }): string {
  return q.id || '(missing id)';
}

function expectationError(questionId: string, field: string, detail: string): Error {
  return new Error(`Question ${questionId}: ${field} ${detail}`);
}

/** Slug expectation fields must be arrays of non-empty strings. A string would be walked character by character. */
function readSlugList(value: unknown, questionId: string, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length === 0)) {
    throw expectationError(questionId, field, 'must be an array of non-empty slug strings');
  }
  return value as string[];
}

/** Page expectation fields must be arrays of `{source_id, slug}` objects. */
function readPageList(value: unknown, questionId: string, field: string): RetrievalPageRef[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw expectationError(questionId, field, 'must be an array of {source_id, slug} objects');
  }
  const refs: RetrievalPageRef[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw expectationError(questionId, field, 'entries require source_id and slug');
    }
    const sourceId = (entry as { source_id?: unknown }).source_id;
    const slug = (entry as { slug?: unknown }).slug;
    if (typeof sourceId !== 'string' || sourceId.length === 0 || typeof slug !== 'string' || slug.length === 0) {
      throw expectationError(questionId, field, 'entries require source_id and slug');
    }
    refs.push({ source_id: sourceId, slug });
  }
  return refs;
}

function assertExpectationShape(q: RetrievalProofQuestion): void {
  const questionId = questionLabel(q);
  readSlugList(q.relevant_slugs, questionId, 'relevant_slugs');
  readSlugList(q.forbidden_slugs, questionId, 'forbidden_slugs');
  readPageList(q.relevant_pages, questionId, 'relevant_pages');
  readPageList(q.forbidden_pages, questionId, 'forbidden_pages');
}

function pageRefKey(ref: RetrievalPageRef): string {
  return `${ref.source_id}::${ref.slug}`;
}

/** True when any question lists bare slugs that are not source-qualified. */
export function manifestUsesBareSlugs(manifest: RetrievalProofManifest): boolean {
  return manifest.questions.some(q =>
    (q.relevant_slugs?.length ?? 0) > 0 || (q.forbidden_slugs?.length ?? 0) > 0,
  );
}

/** First-seen order. Repeated relevant pages must not each count as a hit. */
function distinctKeys(keys: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function expectationKeys(
  pages: RetrievalPageRef[] | undefined,
  slugs: string[] | undefined,
  sourceId: string | undefined,
  questionId: string,
  pageField: string,
  slugField: string,
): string[] {
  const pageRefs = readPageList(pages, questionId, pageField) ?? [];
  const slugRefs = readSlugList(slugs, questionId, slugField);
  const keys = pageRefs.map(pageRefKey);
  if ((slugRefs?.length ?? 0) > 0) {
    if (!sourceId) throw new SlugOnlyProofNeedsSourceError();
    for (const slug of slugRefs ?? []) keys.push(`${sourceId}::${slug}`);
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

/** Missing top_k defaults to 10. Zero, negative, and non-integers are rejected. */
function positiveTopK(value: unknown, questionId: string): number {
  if (value === undefined) return 10;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`Question ${questionId}: top_k must be a positive integer`);
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
    const questionId = questionLabel(q);
    assertExpectationShape(q);
    positiveHitThreshold(q.min_hits_in_top_k, questionId);
    positiveTopK(q.top_k, questionId);
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
  const questionId = questionLabel(q);
  const k = positiveTopK(q.top_k, questionId);
  const slice = hits.slice(0, k).map(h => retrievalHitKey(h, sourceId));
  const forbidden = expectationKeys(
    q.forbidden_pages, q.forbidden_slugs, sourceId, questionId, 'forbidden_pages', 'forbidden_slugs',
  );
  if (forbidden.some(s => slice.includes(s))) return 'fail';

  const relevant = distinctKeys(expectationKeys(
    q.relevant_pages, q.relevant_slugs, sourceId, questionId, 'relevant_pages', 'relevant_slugs',
  ));
  if (relevant.length === 0) return 'partial';

  const matched = relevant.filter(s => slice.includes(s)).length;
  const minHits = positiveHitThreshold(q.min_hits_in_top_k, questionId);
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

/** Readwise hits in one result list, via slug or source_id. */
export function countReadwiseHits(
  hits: Array<{ slug: string; source_id?: string }>,
  scopeSourceId?: string,
): number {
  let count = 0;
  for (const h of hits) {
    if (slugLooksReadwise(h.slug, h.source_id ?? scopeSourceId ?? 'default')) count += 1;
  }
  return count;
}

/** True when any hit carries Readwise lineage via slug or source_id. */
export function hitsIncludeReadwiseLineage(
  hits: Array<{ slug: string; source_id?: string }>,
  scopeSourceId?: string,
): boolean {
  return countReadwiseHits(hits, scopeSourceId) > 0;
}

/**
 * Receipt total for `cited_readwise_pages`.
 * One question with several Readwise hits contributes each hit, not 1.
 */
export function citedReadwisePageCount(
  results: Array<{ top_pages?: Array<{ slug: string; source_id?: string }> }>,
  scopeSourceId?: string,
): number {
  let count = 0;
  for (const r of results) count += countReadwiseHits(r.top_pages ?? [], scopeSourceId);
  return count;
}

type RetrievalProofSearch = (
  engine: BrainEngine,
  query: string,
  opts: {
    limit?: number;
    sourceId?: string;
    _pinnedSearch?: Pick<PinnedProofSearch, 'mode' | 'overrides' | 'embeddingColumn'>;
  },
) => Promise<Array<{ slug: string; source_id?: string }>>;

/** @internal Replace hybrid search so a proof can be scored without a corpus. */
let retrievalSearchForTests: RetrievalProofSearch | null = null;

export function _setRetrievalProofSearchForTests(fn: RetrievalProofSearch | null): void {
  retrievalSearchForTests = fn;
}

/**
 * Every distinct relevant_pages / forbidden_pages source must be an active
 * concrete source. A typo such as `wkii` would otherwise fail to match a
 * real hit and let the proof pass. Same bar as CLI scope and relation rows.
 */
async function assertActiveExpectationSources(
  engine: BrainEngine,
  questions: RetrievalProofQuestion[],
): Promise<void> {
  const ids = new Set<string>();
  for (const q of questions) {
    const questionId = questionLabel(q);
    for (const ref of readPageList(q.relevant_pages, questionId, 'relevant_pages') ?? []) ids.add(ref.source_id);
    for (const ref of readPageList(q.forbidden_pages, questionId, 'forbidden_pages') ?? []) ids.add(ref.source_id);
  }
  for (const id of ids) {
    if (id === ALL_SOURCES || !isValidSourceId(id)) {
      throw new SourceTargetError(
        `Invalid --source value "${id}". Must match [a-z0-9-]{1,32}.`,
      );
    }
    await resolveSourceId(engine, id);
  }
}

export async function runRetrievalProof(
  engine: BrainEngine,
  manifest: RetrievalProofManifest,
  opts: RunRetrievalProofOpts = {},
): Promise<RetrievalProofResult> {
  const questions = opts.limit ? manifest.questions.slice(0, opts.limit) : manifest.questions;
  for (const q of questions) assertExpectationShape(q);
  if (manifestUsesBareSlugs({ ...manifest, questions }) && !opts.sourceId) {
    throw new SlugOnlyProofNeedsSourceError();
  }

  // Reject a malformed top_k before any search. slice(0, -1) would otherwise
  // score almost the whole result set.
  for (const q of questions) {
    positiveTopK(q.top_k, questionLabel(q));
  }
  await assertActiveExpectationSources(engine, questions);

  // Resolve search.mode, per-key overrides, and the embedding column once.
  // Every question receives this pin. hybridSearch would otherwise reload
  // those settings per query, so a concurrent config write could mix
  // retrieval configurations inside one proof.
  const pin = await readProofSearchPin(engine);
  const pinnedSearch = {
    mode: pin.mode,
    overrides: pin.overrides,
    embeddingColumn: pin.embeddingColumn,
  };
  const before = await computeGraphFingerprint(engine, { searchConfig: pin.canonical });
  const results: RetrievalProofQuestionResult[] = [];

  for (const q of questions) {
    const topK = positiveTopK(q.top_k, questionLabel(q));
    const searchOpts = {
      limit: topK,
      ...(opts.sourceId ? { sourceId: opts.sourceId } : {}),
      _pinnedSearch: pinnedSearch,
    };
    const hits = retrievalSearchForTests
      ? await retrievalSearchForTests(engine, q.query, searchOpts)
      : await hybridSearch(engine, q.query, searchOpts);
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

  // Live config again. A change since the pin makes sha256 differ even
  // when the graph counts did not, so production_mutations cannot stay 0.
  const afterPin = await readProofSearchPin(engine);
  const after = await computeGraphFingerprint(engine, { searchConfig: afterPin.canonical });
  const scores = { pass: 0, partial: 0, fail: 0 };
  for (const r of results) scores[r.score] += 1;
  const citedReadwise = citedReadwisePageCount(results, opts.sourceId);
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
