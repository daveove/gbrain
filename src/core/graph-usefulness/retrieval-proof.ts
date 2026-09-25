import { readFileSync } from 'fs';
import type { BrainEngine } from '../engine.ts';
import { expandQuery } from '../search/expansion.ts';
import { hybridSearch } from '../search/hybrid.ts';
import { isValidSourceId, ALL_SOURCES } from '../source-id.ts';
import { resolveSourceId, SourceTargetError } from '../source-resolver.ts';
import { slugLooksReadwise } from './junk-classify.ts';
import { computeGraphFingerprint } from './fingerprint.ts';
import {
  readProofSearchPin,
  type PinnedProofSearch,
} from './search-pin.ts';
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

/**
 * A sealed question is only runnable with a real id and a real query.
 * A missing or empty query used to parse when a relevant expectation was set,
 * then search ran with that empty string.
 */
function assertQuestionIdentity(q: RetrievalProofQuestion): void {
  const id = (q as { id?: unknown } | null)?.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('Retrieval proof question requires a non-empty string id');
  }
  const query = (q as { query?: unknown }).query;
  if (typeof query !== 'string' || query.length === 0) {
    throw new Error(`Question ${id}: query must be a non-empty string`);
  }
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

/**
 * A question with no relevant slug or page scores `partial`, and a proof
 * ignores partial when deciding `passed`. Require one distinct expectation
 * so that path cannot report success.
 */
function assertRelevantExpectation(q: RetrievalProofQuestion): void {
  const questionId = questionLabel(q);
  const pages = readPageList(q.relevant_pages, questionId, 'relevant_pages') ?? [];
  const slugs = readSlugList(q.relevant_slugs, questionId, 'relevant_slugs') ?? [];
  // Prefix the two kinds so a bare slug cannot collapse into a page key.
  const distinct = distinctKeys([
    ...pages.map(ref => `page:${pageRefKey(ref)}`),
    ...slugs.map(slug => `slug:${slug}`),
  ]);
  if (distinct.length > 0) return;
  throw new Error(
    `Question ${questionId}: must include at least one distinct relevant expectation (relevant_slugs or relevant_pages)`,
  );
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
    assertQuestionIdentity(q);
    const questionId = questionLabel(q);
    assertExpectationShape(q);
    assertRelevantExpectation(q);
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
  // Parsing and runRetrievalProof reject this. Direct scoring stays partial
  // so a caller can tell an empty expectation set from a miss.
  if (relevant.length === 0) return 'partial';

  const matched = relevant.filter(s => slice.includes(s)).length;
  const minHits = positiveHitThreshold(q.min_hits_in_top_k, questionId);
  if (matched >= minHits && slice[0] && relevant.includes(slice[0])) return 'pass';
  if (matched >= minHits) return 'partial';
  return 'fail';
}

export interface RunRetrievalProofOpts {
  /** Scalar scope. Bare slugs are scored in this source. */
  sourceId?: string;
  /**
   * Production federated set (`federatedSearchScope`). Wins over `sourceId`
   * for the search call. Isolated sources are not members.
   */
  sourceIds?: string[];
  limit?: number;
}

/**
 * Non-zero when the graph fingerprint changed during the proof, or when
 * `watermarkChanged` is set. The flag covers corpus sequence/xmin movement.
 * A matching sha256 with a stable watermark is the only zero. Any difference
 * is at least 1 so a changing graph cannot be reported as
 * production_mutations: 0.
 */
export function retrievalProofMutationCount(
  before: GraphFingerprint,
  after: GraphFingerprint,
  opts?: { watermarkChanged?: boolean },
): number {
  const watermarkChanged = opts?.watermarkChanged === true;
  if (before.sha256 === after.sha256 && !watermarkChanged) return 0;
  const delta =
    Math.abs(after.active_pages - before.active_pages)
    + Math.abs(after.link_rows - before.link_rows)
    + Math.abs(after.valid_links - before.valid_links)
    + Math.abs(after.zero_degree_pages - before.zero_degree_pages);
  return Math.max(1, delta);
}

/**
 * Tables whose rows change retrieval. Sequence counters catch an insert
 * that is deleted before the final fingerprint. Row xmin catches an update
 * that is written back. pg_stat tuple counters are not used: they flush
 * late and can move during a proof that did not write.
 */
const CORPUS_WATERMARK_TABLES = [
  'pages',
  'links',
  'content_chunks',
  'sources',
  'page_aliases',
  'slug_aliases',
  'takes',
  'config',
] as const;

const CORPUS_WATERMARK_SEQUENCES = [
  'pages_id_seq',
  'links_id_seq',
  'content_chunks_id_seq',
  'page_aliases_id_seq',
  'slug_aliases_id_seq',
  'takes_id_seq',
] as const;

/**
 * Monotonic corpus-mutation watermark. Endpoint fingerprints miss a
 * backlink that is committed during a question and removed before the
 * final snapshot: the hashes match, but the sequence or the row xmin
 * does not return to its earlier value.
 */
async function readCorpusMutationWatermark(engine: BrainEngine): Promise<string> {
  const xidSql = CORPUS_WATERMARK_TABLES
    .map((table) => `COALESCE((SELECT max(xmin::text::bigint) FROM ${table}), 0)::text`)
    .join(` || ',' || `);
  const rows = await engine.executeRaw<{ watermark: string | null }>(
    `SELECT
       COALESCE((
         SELECT string_agg(
           sequencename || '=' || COALESCE(last_value::text, 'none'),
           ',' ORDER BY sequencename
         )
         FROM pg_sequences
         WHERE sequencename = ANY($1::text[])
       ), '')
       || '|' ||
       ${xidSql}
       AS watermark`,
    [[...CORPUS_WATERMARK_SEQUENCES]],
  );
  const watermark = rows[0]?.watermark;
  if (typeof watermark !== 'string' || watermark.length === 0) {
    throw new Error('Corpus mutation watermark returned no row');
  }
  return watermark;
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
    sourceIds?: string[];
    /**
     * Query operation default (`expand !== false`). Forces expansion on
     * even when the pinned mode's expansion knob is off.
     */
    expansion?: boolean;
    /** Production `expandQuery`, wired with that default. */
    expandFn?: (query: string) => Promise<string[]>;
    _pinnedSearch?: Pick<
      PinnedProofSearch,
      'mode' | 'overrides' | 'embeddingColumn' | 'cacheEmbeddingModel' | 'cacheEmbeddingDimensions' | 'adaptiveReturn' | 'intentPatterns' | 'embeddingMultimodalModel'
    >;
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
  // Identity first, before any fingerprint or source lookup.
  for (const q of questions) {
    assertQuestionIdentity(q);
    assertExpectationShape(q);
    assertRelevantExpectation(q);
  }
  if (manifestUsesBareSlugs({ ...manifest, questions }) && !opts.sourceId) {
    throw new SlugOnlyProofNeedsSourceError();
  }

  // Reject a malformed top_k before any search. slice(0, -1) would otherwise
  // score almost the whole result set.
  for (const q of questions) {
    positiveTopK(q.top_k, questionLabel(q));
  }
  await assertActiveExpectationSources(engine, questions);

  // Resolve every live retrieval setting once. Every question receives
  // this pin. hybridSearch would otherwise reload mode, adaptive return,
  // intent patterns, and the embedding column per query, so a concurrent
  // config write could mix retrieval configurations inside one proof.
  const pin = await readProofSearchPin(engine);
  const pinnedSearch = {
    mode: pin.mode,
    overrides: pin.overrides,
    embeddingColumn: pin.embeddingColumn,
    cacheEmbeddingModel: pin.cacheEmbeddingModel,
    cacheEmbeddingDimensions: pin.cacheEmbeddingDimensions,
    adaptiveReturn: pin.adaptiveReturn,
    intentPatterns: pin.intentPatterns,
    embeddingMultimodalModel: pin.embeddingMultimodalModel,
  };
  // Query operation default: `expand = p.expand !== false`, which passes
  // expansion:true and expandQuery. That per-call override wins over the
  // mode bundle, so conservative and balanced still expand. Decided once
  // so a config write between questions cannot turn it off.
  // Watermark first, fingerprint last on the way out, so every question
  // sits inside the window. A reverted write still moves the watermark.
  const watermarkBefore = await readCorpusMutationWatermark(engine);
  const before = await computeGraphFingerprint(engine, { searchConfig: pin.canonical });
  const results: RetrievalProofQuestionResult[] = [];
  for (const q of questions) {
    const topK = positiveTopK(q.top_k, questionLabel(q));
    const searchOpts = {
      limit: topK,
      expansion: true,
      expandFn: expandQuery,
      ...(opts.sourceIds && opts.sourceIds.length > 0
        ? { sourceIds: opts.sourceIds }
        : opts.sourceId
          ? { sourceId: opts.sourceId }
          : {}),
      _pinnedSearch: pinnedSearch,
    };
    // Live hybridSearch, never hybridSearchCached. The cache gate advances
    // only on page writes, so a cached row can replay the ranking from
    // before a link apply for its whole TTL, and a cache store would write
    // production rows during a read-only proof.
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
  // The watermark covers the case the hashes miss: a write during a
  // question that is undone before this snapshot.
  const afterPin = await readProofSearchPin(engine);
  const after = await computeGraphFingerprint(engine, { searchConfig: afterPin.canonical });
  const watermarkAfter = await readCorpusMutationWatermark(engine);
  const scores = { pass: 0, partial: 0, fail: 0 };
  for (const r of results) scores[r.score] += 1;
  const citedReadwise = citedReadwisePageCount(results, opts.sourceId);
  const productionMutations = retrievalProofMutationCount(before, after, {
    watermarkChanged: watermarkBefore !== watermarkAfter,
  });

  return {
    passed: retrievalProofPassed(scores.fail, citedReadwise, productionMutations),
    checks: {
      questions: results.length,
      scores,
      cited_readwise_pages: citedReadwise,
      production_mutations: productionMutations,
      search_path: 'live',
    },
    questions: results,
    fingerprint_before: before,
    fingerprint_after: after,
  };
}

export function loadRetrievalProofFile(path: string): RetrievalProofManifest {
  return parseRetrievalProofManifest(readFileSync(path, 'utf8'));
}
