/**
 * DAV-6220 graph usefulness — shared manifest + receipt types.
 * Read-only measurement and guarded, manifest-bound link applies.
 */

export const RELATION_MANIFEST_VERSION = 1;
export const RETRIEVAL_PROOF_VERSION = 2;

/** Immutable guard flags precomputed when the manifest was sealed. */
export interface RelationRowGuards {
  exact_endpoint_match: boolean;
  source_relation_current: boolean;
  no_incident_edge: boolean;
  readwise_clear: boolean;
}

export interface RelationManifestRow {
  id: string;
  from_slug: string;
  to_slug: string;
  link_type: string;
  link_source: string;
  context?: string;
  from_source_id?: string;
  to_source_id?: string;
  guards: RelationRowGuards;
}

export interface RelationManifest {
  manifest_version: number;
  issue?: string;
  apply?: boolean;
  rows: RelationManifestRow[];
  counts?: Record<string, number>;
}

export type RelationRowStatus =
  | 'ready'
  | 'skipped_guard'
  | 'skipped_already_linked'
  | 'skipped_missing_endpoint'
  | 'skipped_readwise'
  | 'applied'
  | 'dry_run';

export interface RelationRowOutcome {
  id: string;
  status: RelationRowStatus;
  reason?: string;
}

export interface RelationApplyResult {
  mode: 'dry-run' | 'apply';
  manifest_sha256: string;
  rows_total: number;
  ready: number;
  applied: number;
  skipped: number;
  outcomes: RelationRowOutcome[];
  before: GraphFingerprint;
  after: GraphFingerprint;
  receipt_path?: string;
}

export interface GraphFingerprint {
  active_pages: number;
  link_rows: number;
  valid_links: number;
  zero_degree_pages: number;
  /**
   * Hash of the four counts, ordered active-page `(source_id, slug)`
   * identities, ordered link endpoints, type, context, and source, and a
   * content/chunk revision (page generation, content hash, compiled truth,
   * chunk text, chunk source, and embedding revision). Retrieval-proof fingerprints also
   * hash the effective search configuration (resolved mode, per-key
   * overrides, and embedding column). Aggregate counts alone stay on
   * this object for receipts.
   */
  sha256: string;
}

export interface GraphMeasureResult {
  active_pages: number;
  link_rows: number;
  valid_links: number;
  zero_degree_pages: number;
  avg_degree: number;
  median_degree: number;
  junk_slug_samples: JunkSlugSample[];
  fingerprint: GraphFingerprint;
}

export interface JunkSlugSample {
  pattern: string;
  count: number;
  examples: string[];
}

export type RetrievalScore = 'pass' | 'partial' | 'fail';

/** Source-qualified page identity. Pages are `(source_id, slug)`, not slug alone. */
export interface RetrievalPageRef {
  source_id: string;
  slug: string;
}

export interface RetrievalProofQuestion {
  id: string;
  query: string;
  /**
   * Bare slugs. Scored only when the run passes a single source id, which
   * qualifies every slug as `(source, slug)`.
   */
  relevant_slugs?: string[];
  /** Bare slugs. Same single-source rule as `relevant_slugs`. */
  forbidden_slugs?: string[];
  /** Source-qualified hits that count as relevant. */
  relevant_pages?: RetrievalPageRef[];
  /** Source-qualified hits that fail the question. */
  forbidden_pages?: RetrievalPageRef[];
  min_hits_in_top_k?: number;
  top_k?: number;
}

export interface RetrievalProofManifest {
  proof_version: number;
  questions: RetrievalProofQuestion[];
}

export interface RetrievalProofQuestionResult {
  id: string;
  query: string;
  score: RetrievalScore;
  top_slugs: string[];
  /** Hit identities in rank order. Scoring uses these, not bare slugs. */
  top_pages: RetrievalPageRef[];
  cited_readwise: boolean;
}

export interface RetrievalProofResult {
  passed: boolean;
  checks: {
    questions: number;
    scores: { pass: number; partial: number; fail: number };
    cited_readwise_pages: number;
    production_mutations: number;
    /** Proofs score live hybrid search. They never read or write query_cache. */
    search_path: 'live';
  };
  questions: RetrievalProofQuestionResult[];
  fingerprint_before: GraphFingerprint;
  fingerprint_after: GraphFingerprint;
}

export interface MutationReceipt {
  issue: string;
  mode: 'dry-run' | 'apply';
  created_at: string;
  manifest_sha256: string;
  operator: string;
  counts: {
    planned: number;
    applied: number;
    skipped: number;
  };
  before: GraphFingerprint;
  after: GraphFingerprint;
  outcomes: RelationRowOutcome[];
  /** Set when apply aborted mid-run after one or more links committed. */
  partial_failure?: boolean;
  error?: string;
}
