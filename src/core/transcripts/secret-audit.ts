/**
 * The installed-base transcript secret audit (#6147 follow-through).
 * Conversation pages imported before the `labeled_credential` detector
 * shipped keep any prose credential they carried: re-ingest skips them
 * (content hash and `--since last`), and nothing rewrites a page on its own.
 * `gbrain transcripts audit-secrets` scans those pages with the same
 * transcript-lane detectors the importer uses now and lists the affected
 * page slugs with hit counts per pattern. It never prints, returns or stores
 * a matched value or a preview, and it changes no page. Its summary is
 * cached in the config row `transcripts.secret_audit` so the
 * `transcript_secret_exposure` doctor check reads it instead of scanning.
 *
 * Scope `conversations` (DAV-7162) scans every conversation page, imported
 * or not, including its frontmatter keys and string values, and stores a
 * result record in the config row `conversations.secret_audit`. A read-only
 * monitor reads that row and never needs read access to conversation text.
 * The record holds counts, pattern names, affected page ids with their
 * content hashes and the scan start time; never a slug, a matched value or a
 * preview.
 *
 * Bounded memory: conversation parts run to ~300 KB, so pages stream in id
 * order in small keyset batches.
 */
import type { BrainEngine } from '../engine.ts';
import { scanText } from '../secret-scan.ts';

/** Bump when the transcript-lane detectors change, so doctor asks for a fresh audit. */
export const TRANSCRIPT_SECRET_AUDIT_VERSION = 1;
export const TRANSCRIPT_SECRET_AUDIT_KEY = 'transcripts.secret_audit';
/** Config row the conversations-scope audit writes for the read-only monitor (DAV-7162). */
export const CONVERSATION_SECRET_AUDIT_KEY = 'conversations.secret_audit';
export const CONVERSATION_SECRET_AUDIT_SCHEMA = 1;
const BATCH = 25;
const LINES_PER_PAGE = 20;
/** The stored record lists at most this many affected pages; `affected_pages_capped` says when more exist. */
const AFFECTED_PAGES_STORED = 500;

/** The page set the importer writes: conversation pages stamped with `transcript_import`. */
export const TRANSCRIPT_PAGE_PREDICATE = `type = 'conversation' AND deleted_at IS NULL AND frontmatter ? 'transcript_import'`;
/** Every live conversation page, imported or not. */
export const CONVERSATION_PAGE_PREDICATE = `type = 'conversation' AND deleted_at IS NULL`;

export type SecretAuditScope = 'transcripts' | 'conversations';

export interface TranscriptSecretAuditPage {
  id: number;
  slug: string;
  source_id: string;
  /** The page's stored content hash, so a reader can tell an edited page from an unchanged one. */
  content_hash: string | null;
  hits: Record<string, number>;
  /** 1-based body line numbers of the hits (first 20), so a reviewer can find them; never the text. */
  lines: number[];
}

export interface TranscriptSecretAuditSummary {
  scope: SecretAuditScope;
  detector_version: number;
  /** When the scan began: every page write committed before it is in this result. */
  started_at: string;
  scanned_at: string;
  source_id: string | null;
  pages_scanned: number;
  pages_affected: number;
  hits_total: number;
  by_pattern: Record<string, number>;
}

export interface TranscriptSecretAuditResult extends TranscriptSecretAuditSummary {
  pages: TranscriptSecretAuditPage[];
}

/** The monitor-readable record in `conversations.secret_audit`: no slugs, no text. */
export interface ConversationSecretAuditRecord extends TranscriptSecretAuditSummary {
  schema_version: number;
  scope: 'conversations';
  complete: true;
  affected_pages: Array<{ id: number; source_id: string; content_hash: string | null; hits: Record<string, number> }>;
  affected_pages_capped: boolean;
}

/** Frontmatter keys and string values, depth first, as the monitor scanned them. */
function frontmatterStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const child of value) frontmatterStrings(child, out);
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) { out.push(key); frontmatterStrings(child, out); }
  }
  return out;
}

export async function auditTranscriptSecrets(
  engine: BrainEngine,
  opts: { sourceId?: string; scope?: SecretAuditScope; now?: () => Date } = {},
): Promise<TranscriptSecretAuditResult> {
  const scope = opts.scope ?? 'transcripts';
  const conversations = scope === 'conversations';
  const startedAt = (opts.now?.() ?? new Date()).toISOString();
  const pages: TranscriptSecretAuditPage[] = [];
  const byPattern: Record<string, number> = {};
  let pagesScanned = 0;
  let cursor = 0;
  for (;;) {
    const params: unknown[] = [cursor, BATCH];
    if (opts.sourceId) params.push(opts.sourceId);
    const rows = await engine.executeRaw<{ id: number | string; slug: string; source_id: string; content_hash: string | null; title: string; compiled_truth: string; frontmatter?: unknown }>(
      `SELECT id, slug, source_id, content_hash, title, compiled_truth${conversations ? ', frontmatter' : ''} FROM pages
        WHERE ${conversations ? CONVERSATION_PAGE_PREDICATE : TRANSCRIPT_PAGE_PREDICATE} AND id > $1${opts.sourceId ? ' AND source_id = $3' : ''}
        ORDER BY id LIMIT $2`,
      params,
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      cursor = Number(row.id);
      pagesScanned++;
      const scan = { highEntropy: true, labeledCredentials: true };
      const frontmatter = conversations
        ? frontmatterStrings(typeof row.frontmatter === 'string' ? JSON.parse(row.frontmatter) : row.frontmatter)
        : [];
      const findings = [
        ...scanText(row.title ?? '', scan).map((f) => ({ ...f, line: 0 })),
        ...scanText(row.compiled_truth ?? '', scan),
        ...frontmatter.flatMap((text) => scanText(text, scan).map((f) => ({ ...f, line: 0 }))),
      ];
      if (findings.length === 0) continue;
      const hits: Record<string, number> = {};
      for (const f of findings) {
        hits[f.pattern] = (hits[f.pattern] ?? 0) + 1;
        byPattern[f.pattern] = (byPattern[f.pattern] ?? 0) + 1;
      }
      const lines = [...new Set(findings.map((f) => f.line).filter((l) => l > 0))].slice(0, LINES_PER_PAGE);
      pages.push({ id: Number(row.id), slug: row.slug, source_id: row.source_id, content_hash: row.content_hash ?? null, hits, lines });
    }
    if (rows.length < BATCH) break;
  }
  return {
    scope,
    detector_version: TRANSCRIPT_SECRET_AUDIT_VERSION,
    started_at: startedAt,
    scanned_at: (opts.now?.() ?? new Date()).toISOString(),
    source_id: opts.sourceId ?? null,
    pages_scanned: pagesScanned,
    pages_affected: pages.length,
    hits_total: Object.values(byPattern).reduce((n, v) => n + v, 0),
    by_pattern: byPattern,
    pages,
  };
}

/** The monitor record for a brain-wide conversations-scope result: ids and counts only. */
export function conversationSecretAuditRecord(result: TranscriptSecretAuditResult): ConversationSecretAuditRecord {
  if (result.scope !== 'conversations' || result.source_id !== null) {
    throw new Error('Only a brain-wide conversations-scope audit makes a monitor record.');
  }
  const { pages, ...summary } = result;
  return {
    schema_version: CONVERSATION_SECRET_AUDIT_SCHEMA,
    ...summary,
    scope: 'conversations',
    complete: true,
    affected_pages: pages.slice(0, AFFECTED_PAGES_STORED).map((p) => ({ id: p.id, source_id: p.source_id, content_hash: p.content_hash, hits: p.hits })),
    affected_pages_capped: pages.length > AFFECTED_PAGES_STORED,
  };
}

/**
 * Cache the result for its reader. Best effort.
 * `transcripts` scope: the doctor summary (no slugs, no values) in `transcripts.secret_audit`.
 * `conversations` scope: the monitor record (no slugs, no values) in `conversations.secret_audit`.
 */
export async function saveTranscriptSecretAudit(engine: BrainEngine, result: TranscriptSecretAuditResult): Promise<boolean> {
  try {
    if (result.scope === 'conversations') {
      await engine.setConfig(CONVERSATION_SECRET_AUDIT_KEY, JSON.stringify(conversationSecretAuditRecord(result)));
      return true;
    }
    const { pages: _pages, ...summary } = result;
    await engine.setConfig(TRANSCRIPT_SECRET_AUDIT_KEY, JSON.stringify(summary));
    return true;
  } catch {
    return false;
  }
}

export async function loadTranscriptSecretAudit(engine: BrainEngine): Promise<TranscriptSecretAuditSummary | null> {
  try {
    const raw = await engine.getConfig(TRANSCRIPT_SECRET_AUDIT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as TranscriptSecretAuditSummary;
    return typeof parsed.scanned_at === 'string' && typeof parsed.hits_total === 'number' ? parsed : null;
  } catch {
    return null;
  }
}
