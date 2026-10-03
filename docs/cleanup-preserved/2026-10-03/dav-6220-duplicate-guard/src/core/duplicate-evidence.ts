import { createHash } from 'crypto';

export const DUPLICATE_EVIDENCE_SCHEMA_VERSION = 2;
export const DUPLICATE_AUDIT_SCHEMA_VERSION = 2;

export interface DuplicateEvidencePage {
  id: number;
  source_id: string;
  slug: string;
  title: string;
  content_hash?: string | null;
  compiled_truth: string;
  effective_date?: Date | string | null;
  provenance?: unknown;
}

export interface DuplicateEvidenceRow {
  page_id: number;
  source_id: string;
  slug: string;
  title: string;
  normalized_title: string;
  content_hash: string | null;
  content_digest: string;
  content_bytes: number;
  effective_date: string | null;
  provenance: unknown;
  references: string[];
}

export interface DuplicateCluster {
  cluster_id: string;
  confidence: 'high' | 'medium';
  evidence: Array<
    | { kind: 'exact_content_digest'; content_digest: string }
    | { kind: 'normalized_title_and_content_similarity'; normalized_title: string; min_similarity: number }
  >;
  canonical_display: {
    page_id: number;
    source_id: string;
    slug: string;
    reason: 'stable_display_only';
    safe_to_discard_others: false;
    limitations: string[];
  };
  relationships: Array<{ a: number; b: number; confidence: 'high' | 'medium'; evidence: DuplicateCluster['evidence'][number] }>;
  pages: DuplicateEvidenceRow[];
}

export interface DuplicateEvidenceManifest {
  schema_version: number;
  input_snapshot_hash: string;
  manifest_hash: string;
  pages_scanned: number;
  clusters: DuplicateCluster[];
  source_counts: Record<string, number>;
  limitations: string[];
  skipped_similarity_groups: Array<{ normalized_title: string; pages: number; distinct_bodies: number }>;
}

export interface DuplicateAuditCandidate {
  cluster_id: string;
  page_id: number;
  source_id: string;
  slug: string;
  content_hash: string | null;
  approved: boolean;
  content_digest: string;
}

export interface DuplicateAuditHandoff {
  schema_version: number;
  input_snapshot_hash: string;
  evidence_manifest_hash: string;
  candidate_hash: string;
  approved_by: string;
  candidates: DuplicateAuditCandidate[];
}

export interface AuditHandoffValidation {
  ok: boolean;
  errors: string[];
  authorized_for_mutation: false;
  approval_provenance: 'self_asserted_unverified';
}

interface Edge {
  a: number;
  b: number;
  evidence: DuplicateCluster['evidence'][number];
}

const GENERIC_TITLES = new Set(['untitled', 'note', 'notes', 'meeting notes', 'new page']);
const MAX_SIMILARITY_COMPARISONS = 2_000_000;
const MIN_TITLE_LENGTH = 12;
const MIN_TITLE_CONTENT_SIMILARITY = 0.8;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function compareText(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function stableHash(value: unknown): string {
  const hash = createHash('sha256');
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) {
      hash.update('[');
      item.forEach((entry,index) => { if (index) hash.update(','); visit(entry); });
      hash.update(']');
    } else if (item && typeof item === 'object') {
      hash.update('{');
      Object.keys(item).sort().forEach((key,index) => {
        if (index) hash.update(',');
        hash.update(JSON.stringify(key)+':');
        visit((item as Record<string,unknown>)[key]);
      });
      hash.update('}');
    } else hash.update(JSON.stringify(item) ?? 'null');
  };
  visit(value);
  return hash.digest('hex');
}

function decodeTitle(value: string): string {
  let decoded = value;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded;
}

export function normalizeDuplicateTitle(value: string): string {
  return decodeTitle(value)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function isStableTitle(value: string): boolean {
  return value.length >= MIN_TITLE_LENGTH && value.split(' ').length >= 2 && !GENERIC_TITLES.has(value);
}

function contentTokenSet(value: string): Set<string> {
  const normalized = decodeTitle(value)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  return new Set(normalized.slice(0, 5_000));
}

export function tokenJaccard(a: string, b: string): number {
  return setJaccard(contentTokenSet(a), contentTokenSet(b));
}

function setJaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection++;
  return intersection / (left.size + right.size - intersection);
}

function evidenceRow(page: DuplicateEvidencePage): DuplicateEvidenceRow {
  const effectiveDate = page.effective_date ? new Date(page.effective_date) : null;
  return {
    page_id: page.id,
    source_id: page.source_id,
    slug: page.slug,
    title: page.title,
    normalized_title: normalizeDuplicateTitle(page.title),
    content_hash: page.content_hash ?? null,
    content_digest: sha256(page.compiled_truth),
    content_bytes: Buffer.byteLength(page.compiled_truth, 'utf8'),
    effective_date: effectiveDate && !Number.isNaN(effectiveDate.getTime()) ? effectiveDate.toISOString() : null,
    provenance: page.provenance ?? null,
    references: [...new Set(page.compiled_truth.match(/https?:\/\/[^\s<>\])]+|!\[\[[^\]]+\]\]|\[\[[^\]]+\]\]/g) ?? [])].sort(),
  };
}

function compareRows(a: DuplicateEvidenceRow, b: DuplicateEvidenceRow): number {
  return compareText(a.source_id, b.source_id)
    || compareText(a.slug, b.slug)
    || a.page_id - b.page_id;
}

function compareCanonical(a: DuplicateEvidenceRow, b: DuplicateEvidenceRow): number {
  return compareRows(a, b);
}

function union(parent: number[], a: number, b: number): void {
  const root = (value: number): number => {
    while (parent[value] !== value) {
      parent[value] = parent[parent[value]];
      value = parent[value];
    }
    return value;
  };
  const left = root(a);
  const right = root(b);
  if (left !== right) parent[right] = left;
}

function find(parent: number[], value: number): number {
  while (parent[value] !== value) {
    parent[value] = parent[parent[value]];
    value = parent[value];
  }
  return value;
}

export function snapshotHash(pages: ReadonlyArray<DuplicateEvidencePage>): string {
  return snapshotRowsHash(pages.map(evidenceRow).sort(compareRows));
}

function snapshotRowsHash(evidence: ReadonlyArray<DuplicateEvidenceRow>): string {
  const rows = evidence.map((row) => ({
    page_id: row.page_id,
    source_id: row.source_id,
    slug: row.slug,
    title: row.title,
    content_hash: row.content_hash,
    content_digest: row.content_digest,
    effective_date: row.effective_date,
    provenance: row.provenance,
  }));
  return stableHash(rows);
}

export function candidateHash(candidates: ReadonlyArray<DuplicateAuditCandidate>): string {
  return stableHash([...candidates].sort((a, b) =>
    compareText(a.source_id, b.source_id) || compareText(a.slug, b.slug) || a.page_id - b.page_id,
  ));
}

function isValidCandidate(candidate: unknown): candidate is DuplicateAuditCandidate {
  if (!candidate || typeof candidate !== 'object') return false;
  const value = candidate as Partial<DuplicateAuditCandidate>;
  return Number.isInteger(value.page_id) &&
    typeof value.cluster_id === 'string' &&
    typeof value.source_id === 'string' &&
    typeof value.slug === 'string' &&
    (value.content_hash === null || typeof value.content_hash === 'string') &&
    typeof value.content_digest === 'string' && /^[a-f0-9]{64}$/.test(value.content_digest) &&
    typeof value.approved === 'boolean';
}

function* buildSteps(pages: ReadonlyArray<DuplicateEvidencePage>): Generator<void, DuplicateEvidenceManifest> {
  const sortedPages = [...pages].sort((a, b) =>
    compareText(a.source_id, b.source_id) || compareText(a.slug, b.slug) || a.id - b.id,
  );
  yield;
  const rows: DuplicateEvidenceRow[] = [];
  for (const page of sortedPages) {
    rows.push(evidenceRow(page));
    if (rows.length % 1000 === 0) yield;
  }
  const parent = rows.map((_, index) => index);
  const edges: Edge[] = [];
  const byHash = new Map<string, number[]>();
  const byTitle = new Map<string, number[]>();
  const skipped_similarity_groups: DuplicateEvidenceManifest['skipped_similarity_groups'] = [];
  let comparisons = 0;
  const identities = new Set<string>();
  const ids = new Set<number>();

  for (const [index, row] of rows.entries()) {
    if (index % 1000 === 0) yield;
    const identity = stableJson([row.source_id, row.slug]);
    if (identities.has(identity) || ids.has(row.page_id)) throw new Error('Duplicate page identity in input snapshot');
    identities.add(identity);
    ids.add(row.page_id);
    if (row.content_bytes > 0) {
      const indexes = byHash.get(row.content_digest) ?? [];
      indexes.push(index);
      byHash.set(row.content_digest, indexes);
    }
    if (isStableTitle(row.normalized_title)) {
      const indexes = byTitle.get(row.normalized_title) ?? [];
      indexes.push(index);
      byTitle.set(row.normalized_title, indexes);
    }
  }

  for (const [contentHash, indexes] of byHash) {
    const first = indexes[0];
    for (const index of indexes.slice(1)) {
      union(parent, first, index);
      edges.push({ a: first, b: index, evidence: { kind: 'exact_content_digest', content_digest: contentHash } });
    }
  }

  for (const [normalizedTitle, allIndexes] of byTitle) {
    const indexes = [...new Map(allIndexes.map((index) => [rows[index].content_digest, index])).values()];
    const tokens = new Map<number, Set<string>>();
    for (const index of indexes) {
      tokens.set(index, contentTokenSet(sortedPages[index].compiled_truth));
      if (tokens.size % 1000 === 0) yield;
    }
    for (let left = 0; left < indexes.length; left++) {
      for (let right = left + 1; right < indexes.length; right++) {
        const a = indexes[left];
        const b = indexes[right];
        if (++comparisons > MAX_SIMILARITY_COMPARISONS) throw new Error('Similarity comparison limit exceeded (2000000); no complete manifest produced. Narrow the source scope or review this corpus with a larger offline comparison budget.');
        if (comparisons % 1000 === 0) yield;
        if (find(parent, a) === find(parent, b)) continue;
        const similarity = setJaccard(tokens.get(a)!, tokens.get(b)!);
        if (similarity < MIN_TITLE_CONTENT_SIMILARITY) continue;
        union(parent, a, b);
        edges.push({
          a,
          b,
          evidence: { kind: 'normalized_title_and_content_similarity', normalized_title: normalizedTitle, min_similarity: similarity },
        });
      }
    }
  }

  const groups = new Map<number, number[]>();
  rows.forEach((_, index) => {
    const root = find(parent, index);
    const indexes = groups.get(root) ?? [];
    indexes.push(index);
    groups.set(root, indexes);
  });

  const edgesByRoot = new Map<number, Edge[]>();
  for (const edge of edges) {
    const root = find(parent, edge.a);
    const entries = edgesByRoot.get(root) ?? [];
    entries.push(edge);
    edgesByRoot.set(root, entries);
  }
  const clusters = [...groups.values()]
    .filter((indexes) => indexes.length > 1)
    .map((indexes): DuplicateCluster => {
      const clusterEdges = edgesByRoot.get(find(parent, indexes[0])) ?? [];
      const evidence = clusterEdges
        .map((edge) => edge.evidence)
        .sort((a, b) => compareText(stableJson(a), stableJson(b)));
      const uniqueEvidence = evidence.filter((entry, index) => index === 0 || stableJson(entry) !== stableJson(evidence[index - 1]));
      const pagesInCluster = indexes.map((index) => rows[index]).sort(compareRows);
      const canonical = [...pagesInCluster].sort(compareCanonical)[0];
      const high = pagesInCluster.every((row) => row.content_digest === pagesInCluster[0].content_digest);
      const clusterId = sha256(stableJson(pagesInCluster.map((row) => ({ page_id: row.page_id, source_id: row.source_id, slug: row.slug }))));
      return {
        cluster_id: `duplicate:${clusterId}`,
        confidence: high ? 'high' : 'medium',
        evidence: uniqueEvidence,
        relationships: clusterEdges.map((edge) => ({ a: rows[edge.a].page_id, b: rows[edge.b].page_id, confidence: edge.evidence.kind === 'exact_content_digest' ? 'high' : 'medium', evidence: edge.evidence })),
        canonical_display: {
          page_id: canonical.page_id,
          source_id: canonical.source_id,
          slug: canonical.slug,
          reason: 'stable_display_only',
          safe_to_discard_others: false,
          limitations: ['Display ordering does not establish completeness or a safe survivor. Attachment bytes and graph links have not been compared.', ...(high ? [] : ['Bodies differ; preserve every version and review the source content.'])],
        },
        pages: pagesInCluster,
      };
    })
    .sort((a, b) => compareText(a.cluster_id, b.cluster_id));

  const input_snapshot_hash = snapshotRowsHash(rows);
  const source_counts: Record<string, number> = Object.create(null);
  for (const row of rows) source_counts[row.source_id] = (source_counts[row.source_id] ?? 0) + 1;
  const withoutHash = { schema_version: DUPLICATE_EVIDENCE_SCHEMA_VERSION, input_snapshot_hash, pages_scanned: sortedPages.length, source_counts, clusters, skipped_similarity_groups, limitations: ['Only active pages are scanned. Empty bodies are excluded from exact matching.', 'Similarity considers stable titles and the first 5000 tokens only; different titles and short/generic titles can have missed near matches.', 'Relationships are a spanning set of verified comparisons, not every pair in a cluster.', 'Exact body equality is not proof of equivalent attachments, graph links, provenance, or safe disposal.'] };
  return { ...withoutHash, manifest_hash: stableHash(withoutHash) };
}

export function buildDuplicateEvidenceManifest(pages: ReadonlyArray<DuplicateEvidencePage>): DuplicateEvidenceManifest {
  const steps = buildSteps(pages);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

export async function buildDuplicateEvidenceManifestAsync(pages: ReadonlyArray<DuplicateEvidencePage>, signal?: AbortSignal): Promise<DuplicateEvidenceManifest> {
  const steps = buildSteps(pages);
  for (;;) {
    signal?.throwIfAborted();
    const step = steps.next();
    await new Promise<void>((resolve) => setImmediate(resolve));
    signal?.throwIfAborted();
    if (step.done) return step.value;
  }
}

function validateAgainstManifest(
  handoff: DuplicateAuditHandoff,
  livePages: ReadonlyArray<DuplicateEvidencePage>,
  liveManifest: DuplicateEvidenceManifest,
): AuditHandoffValidation {
  const errors: string[] = [];
  const result = (): AuditHandoffValidation => ({ ok: errors.length === 0, errors, authorized_for_mutation: false, approval_provenance: 'self_asserted_unverified' });
  if (!handoff || typeof handoff !== 'object') { errors.push('audit handoff must be an object'); return result(); }
  if (handoff.schema_version !== DUPLICATE_AUDIT_SCHEMA_VERSION) errors.push('unsupported audit manifest schema_version');
  if (typeof handoff.approved_by !== 'string' || !handoff.approved_by.trim()) errors.push('approved_by is required');
  if (!Array.isArray(handoff.candidates) || handoff.candidates.length === 0) {
    errors.push('at least one candidate is required');
    return result();
  }
  if (!handoff.candidates.every(isValidCandidate)) {
    errors.push('candidate has an invalid shape');
    return result();
  }
  if (handoff.input_snapshot_hash !== liveManifest.input_snapshot_hash) errors.push('input_snapshot_hash does not match live pages');
  if (handoff.evidence_manifest_hash !== liveManifest.manifest_hash) errors.push('evidence_manifest_hash does not match live duplicate evidence');
  if (handoff.candidate_hash !== candidateHash(handoff.candidates)) errors.push('candidate_hash does not match candidates');

  const byPageId = new Map(livePages.map((page) => [page.id, page]));
  const evidencePageIds = new Map<string, Set<number>>(
    liveManifest.clusters.map((cluster) => [cluster.cluster_id, new Set(cluster.pages.map((page) => page.page_id))]),
  );
  const seen = new Set<number>();
  for (const candidate of handoff.candidates) {
    if (liveManifest.clusters.some((cluster) => cluster.cluster_id === candidate.cluster_id && cluster.canonical_display.page_id === candidate.page_id)) errors.push(`candidate ${candidate.page_id} is the selected display survivor`);
    if (!candidate.approved) errors.push(`candidate ${candidate.page_id} is not approved`);
    if (seen.has(candidate.page_id)) errors.push(`candidate ${candidate.page_id} is duplicated`);
    seen.add(candidate.page_id);
    if (!evidencePageIds.get(candidate.cluster_id)?.has(candidate.page_id)) {
      errors.push(`candidate ${candidate.page_id} is not present in duplicate cluster ${candidate.cluster_id}`);
    }
    const live = byPageId.get(candidate.page_id);
    if (!live) {
      errors.push(`candidate ${candidate.page_id} is absent from live pages`);
      continue;
    }
    if (live.source_id !== candidate.source_id || live.slug !== candidate.slug || (live.content_hash ?? null) !== candidate.content_hash || sha256(live.compiled_truth) !== candidate.content_digest) {
      errors.push(`candidate ${candidate.page_id} does not match its live source, slug, or content hash`);
    }
  }
  return result();
}

export function validateDuplicateAuditHandoff(handoff: DuplicateAuditHandoff, livePages: ReadonlyArray<DuplicateEvidencePage>): AuditHandoffValidation {
  return validateAgainstManifest(handoff, livePages, buildDuplicateEvidenceManifest(livePages));
}

export async function validateDuplicateAuditHandoffAsync(handoff: DuplicateAuditHandoff, livePages: ReadonlyArray<DuplicateEvidencePage>, signal?: AbortSignal): Promise<AuditHandoffValidation> {
  return validateAgainstManifest(handoff, livePages, await buildDuplicateEvidenceManifestAsync(livePages, signal));
}
