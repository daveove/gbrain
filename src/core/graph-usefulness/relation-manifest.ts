import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { dirname } from 'path';
import type { BrainEngine } from '../engine.ts';
import { MANAGED_LINK_SOURCES } from '../ops/links.ts';
import {
  loadActivePackForWriteVocabulary,
  packDeclaresLinkType,
  undeclaredLinkTypeMessage,
  undeclaredLinkTypeSuggestion,
} from '../schema-pack/write-vocabulary.ts';
import { isValidSourceId, ALL_SOURCES } from '../source-id.ts';
import { resolveSourceId, SourceTargetError } from '../source-resolver.ts';
import { slugLooksReadwise } from './junk-classify.ts';
import { computeGraphFingerprint } from './fingerprint.ts';
import type {
  MutationReceipt,
  RelationApplyResult,
  RelationManifest,
  RelationManifestRow,
  RelationRowOutcome,
  RelationRowStatus,
} from './types.ts';
import { RELATION_MANIFEST_VERSION, type RelationRowGuards } from './types.ts';

/** Required guard keys. Each must be a real boolean; apply requires literal true. */
export const REQUIRED_RELATION_GUARDS = [
  'exact_endpoint_match',
  'source_relation_current',
  'no_incident_edge',
  'readwise_clear',
] as const;

export function guardsAllLiteralTrue(guards: RelationRowGuards): boolean {
  return REQUIRED_RELATION_GUARDS.every(key => guards[key] === true);
}

function assertLiteralBooleanGuards(row: RelationManifestRow): void {
  const guards = row.guards as unknown;
  if (!guards || typeof guards !== 'object' || Array.isArray(guards)) {
    throw new Error(`Row ${row.id}: guards block is required`);
  }
  const record = guards as Record<string, unknown>;
  for (const key of REQUIRED_RELATION_GUARDS) {
    if (typeof record[key] !== 'boolean') {
      throw new Error(
        `Row ${row.id}: guard ${key} must be a literal boolean (got ${JSON.stringify(record[key])})`,
      );
    }
  }
}

export function parseRelationManifest(raw: string): RelationManifest {
  const parsed = JSON.parse(raw) as RelationManifest;
  if (parsed.manifest_version !== RELATION_MANIFEST_VERSION) {
    throw new Error(`Unsupported manifest_version ${parsed.manifest_version}; expected ${RELATION_MANIFEST_VERSION}`);
  }
  if (!Array.isArray(parsed.rows) || parsed.rows.length === 0) {
    throw new Error('Relation manifest must include a non-empty rows array');
  }
  for (const row of parsed.rows) {
    if (!row.id || !row.from_slug || !row.to_slug || !row.link_type || !row.link_source) {
      throw new Error(`Row ${row.id ?? '(missing id)'} missing required slug/link fields`);
    }
    if (MANAGED_LINK_SOURCES.includes(row.link_source)) {
      throw new Error(`Row ${row.id}: link_source '${row.link_source}' is reconciliation-managed`);
    }
    if (!row.guards) throw new Error(`Row ${row.id}: guards block is required`);
    assertLiteralBooleanGuards(row);
  }
  return parsed;
}

export function manifestSha256(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

async function pageExists(
  engine: BrainEngine,
  slug: string,
  sourceId: string,
): Promise<boolean> {
  const page = await engine.getPage(slug, { sourceId });
  return !!page && !page.deleted_at;
}

async function hasIncidentEdge(
  engine: BrainEngine,
  from: string,
  to: string,
  fromSourceId: string,
  toSourceId: string,
): Promise<boolean> {
  const rows = await engine.executeRaw<{ n: string }>(
    `SELECT count(*)::text AS n FROM links l
      JOIN pages fp ON fp.id = l.from_page_id
      JOIN pages tp ON tp.id = l.to_page_id
     WHERE fp.slug = $1 AND tp.slug = $2
       AND fp.source_id = $3 AND tp.source_id = $4
       AND fp.deleted_at IS NULL AND tp.deleted_at IS NULL`,
    [from, to, fromSourceId, toSourceId],
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

async function evaluateRow(
  engine: BrainEngine,
  row: RelationManifestRow,
): Promise<RelationRowOutcome> {
  const g = row.guards;
  const fromSrc = row.from_source_id ?? 'default';
  const toSrc = row.to_source_id ?? 'default';

  if (!guardsAllLiteralTrue(g)) {
    return { id: row.id, status: 'skipped_guard', reason: 'manifest guard flag is not literal true' };
  }

  const fromOk = await pageExists(engine, row.from_slug, fromSrc);
  const toOk = await pageExists(engine, row.to_slug, toSrc);
  if (!fromOk || !toOk) {
    return { id: row.id, status: 'skipped_missing_endpoint', reason: 'endpoint page missing or deleted' };
  }

  if (slugLooksReadwise(row.from_slug, fromSrc) || slugLooksReadwise(row.to_slug, toSrc)) {
    return { id: row.id, status: 'skipped_readwise', reason: 'readwise lineage excluded' };
  }

  if (await hasIncidentEdge(engine, row.from_slug, row.to_slug, fromSrc, toSrc)) {
    return { id: row.id, status: 'skipped_already_linked', reason: 'forward edge already exists' };
  }

  return { id: row.id, status: 'ready' };
}

export interface ApplyRelationManifestOpts {
  apply: boolean;
  limit?: number;
  receiptPath?: string;
  operator?: string;
  /**
   * Default for a row that omits `from_source_id` or `to_source_id`.
   * An explicit id on the row wins. Omitted opts fall back to `default`.
   */
  defaultSourceId?: string;
}

function fallbackSourceId(defaultSourceId: string | undefined): string {
  return defaultSourceId && defaultSourceId.length > 0 ? defaultSourceId : 'default';
}

/** Fill omitted endpoint source ids. Explicit row values are kept. */
function resolveRowSources(row: RelationManifestRow, defaultSourceId: string | undefined): RelationManifestRow {
  const fallback = fallbackSourceId(defaultSourceId);
  const fromSrc = row.from_source_id ?? fallback;
  const toSrc = row.to_source_id ?? fallback;
  if (row.from_source_id === fromSrc && row.to_source_id === toSrc) return row;
  return { ...row, from_source_id: fromSrc, to_source_id: toSrc };
}

/**
 * Every distinct endpoint source must be an active concrete source.
 * Explicit row ids bypass the CLI resolver, and pageExists still sees
 * pages retained on an archived source. Reject those before any receipt
 * or addLink. `__all__` is not a concrete source.
 */
async function assertActiveConcreteRowSources(
  engine: BrainEngine,
  rows: RelationManifestRow[],
): Promise<void> {
  const ids = new Set<string>();
  for (const row of rows) {
    ids.add(row.from_source_id ?? 'default');
    ids.add(row.to_source_id ?? 'default');
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

/** Thrown when a receipt path already exists. The existing file is left untouched. */
export class MutationReceiptExistsError extends Error {
  constructor(path: string) {
    super(`Refusing to overwrite existing mutation receipt: ${path}`);
    this.name = 'MutationReceiptExistsError';
  }
}

function isEexist(err: unknown): boolean {
  return !!err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === 'EEXIST';
}

function refuseExistingReceipt(path: string): void {
  if (existsSync(path)) throw new MutationReceiptExistsError(path);
}

/**
 * Same active-pack rule as add_link: an explicit link_type must be declared
 * when a pack resolves. No resolvable pack means there is nothing to enforce.
 * Runs before any addLink so a manifest cannot insert an out-of-schema verb.
 */
async function assertActivePackLinkVocabulary(
  engine: BrainEngine,
  rows: RelationManifestRow[],
): Promise<void> {
  const packs = new Map<string, Awaited<ReturnType<typeof loadActivePackForWriteVocabulary>>>();
  for (const row of rows) {
    const linkType = typeof row.link_type === 'string' ? row.link_type : '';
    if (linkType.length === 0) continue;
    const sourceId = row.from_source_id ?? 'default';
    let pack = packs.get(sourceId);
    if (pack === undefined) {
      pack = await loadActivePackForWriteVocabulary({
        engine,
        remote: false,
        sourceId,
      });
      packs.set(sourceId, pack);
    }
    if (pack && !packDeclaresLinkType(pack, linkType)) {
      throw new Error(
        `${undeclaredLinkTypeMessage(linkType, pack, 'relations apply')} ${undeclaredLinkTypeSuggestion(pack)}`,
      );
    }
  }
}

/** @internal Fault injection for receipt-commit failure tests. */
let beforeReceiptCommitForTests: (() => void) | null = null;

export function _setBeforeReceiptCommitForTests(fn: (() => void) | null): void {
  beforeReceiptCommitForTests = fn;
}

/**
 * Exclusive-create the receipt path before any link mutation. A parent that
 * cannot be created, or a path that already exists, fails here.
 */
function reserveMutationReceipt(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, '', { flag: 'wx' });
  } catch (err) {
    if (isEexist(err)) throw new MutationReceiptExistsError(path);
    throw err;
  }
}

async function rollbackAppliedLinks(
  engine: BrainEngine,
  rows: RelationManifestRow[],
): Promise<void> {
  const failures: string[] = [];
  for (const row of [...rows].reverse()) {
    const fromSrc = row.from_source_id ?? 'default';
    const toSrc = row.to_source_id ?? 'default';
    try {
      const removed = await engine.removeLink(
        row.from_slug,
        row.to_slug,
        row.link_type,
        row.link_source,
        { fromSourceId: fromSrc, toSourceId: toSrc },
      );
      if (removed < 1) failures.push(`${row.id}: link not removed`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${row.id}: ${message}`);
    }
  }
  if (failures.length > 0) throw new Error(failures.join('; '));
}

/** Drop committed rows and the reserved receipt. Returns the undo clause. */
async function undoAppliedLinks(
  engine: BrainEngine,
  receiptPath: string,
  appliedRows: RelationManifestRow[],
): Promise<string> {
  let undo = `rolled back ${appliedRows.length} applied link(s)`;
  try {
    await rollbackAppliedLinks(engine, appliedRows);
    try { unlinkSync(receiptPath); } catch { /* reserved path may remain */ }
  } catch (undoErr) {
    const detail = undoErr instanceof Error ? undoErr.message : String(undoErr);
    undo = `rollback failed (${detail})`;
  }
  return undo;
}

async function commitReceiptOrUndo(
  engine: BrainEngine,
  path: string,
  appliedRows: RelationManifestRow[],
  write: () => void,
): Promise<void> {
  try {
    write();
  } catch (err) {
    const undo = await undoAppliedLinks(engine, path, appliedRows);
    const writeMessage = err instanceof Error ? err.message : String(err);
    throw new Error(`Receipt write failed; ${undo}: ${writeMessage}`);
  }
}

/**
 * Post-mutation fingerprint. When a receipt was reserved, a failed read
 * rolls committed rows back so they are not left applied beside an empty file.
 */
async function fingerprintAfterMutation(
  engine: BrainEngine,
  receiptPath: string | undefined,
  appliedRows: RelationManifestRow[],
): Promise<Awaited<ReturnType<typeof computeGraphFingerprint>>> {
  try {
    return await computeGraphFingerprint(engine);
  } catch (err) {
    const fpMessage = err instanceof Error ? err.message : String(err);
    if (!receiptPath) throw err;
    const undo = await undoAppliedLinks(engine, receiptPath, appliedRows);
    throw new Error(`Graph fingerprint failed; ${undo}: ${fpMessage}`);
  }
}

function writeMutationReceipt(
  path: string,
  manifest: RelationManifest,
  sha: string,
  opts: ApplyRelationManifestOpts,
  sliceLen: number,
  before: Awaited<ReturnType<typeof computeGraphFingerprint>>,
  after: Awaited<ReturnType<typeof computeGraphFingerprint>>,
  outcomes: RelationRowOutcome[],
  extra?: { partial_failure?: boolean; error?: string },
): void {
  const applied = outcomes.filter(o => o.status === 'applied').length;
  const skipped = outcomes.filter(o => o.status.startsWith('skipped')).length;
  const receipt: MutationReceipt = {
    issue: manifest.issue ?? 'DAV-6220',
    mode: opts.apply ? 'apply' : 'dry-run',
    created_at: new Date().toISOString(),
    manifest_sha256: sha,
    operator: opts.operator ?? 'gbrain',
    counts: {
      planned: sliceLen,
      applied,
      skipped,
    },
    before,
    after,
    outcomes,
    ...extra,
  };
  beforeReceiptCommitForTests?.();
  // The path was exclusive-created by reserveMutationReceipt. Fill that file.
  writeFileSync(path, JSON.stringify(receipt, null, 2) + '\n', { flag: 'w' });
}

export async function applyRelationManifest(
  engine: BrainEngine,
  manifest: RelationManifest,
  manifestRaw: string,
  opts: ApplyRelationManifestOpts,
): Promise<RelationApplyResult> {
  if (opts.receiptPath) refuseExistingReceipt(opts.receiptPath);
  const sha = manifestSha256(manifestRaw);
  const slice = (opts.limit ? manifest.rows.slice(0, opts.limit) : manifest.rows)
    .map(row => resolveRowSources(row, opts.defaultSourceId));
  await assertActiveConcreteRowSources(engine, slice);
  const before = await computeGraphFingerprint(engine);
  await assertActivePackLinkVocabulary(engine, slice);
  // Prove the receipt path can be created before the first addLink.
  if (opts.receiptPath) reserveMutationReceipt(opts.receiptPath);
  const outcomes: RelationRowOutcome[] = [];
  const appliedRows: RelationManifestRow[] = [];

  try {
    for (const row of slice) {
      const verdict = await evaluateRow(engine, row);
      if (verdict.status !== 'ready') {
        outcomes.push(verdict);
        continue;
      }
      if (!opts.apply) {
        outcomes.push({ id: row.id, status: 'dry_run' });
        continue;
      }

      const fromSrc = row.from_source_id ?? 'default';
      const toSrc = row.to_source_id ?? 'default';
      const linkOpts = {
        fromSourceId: fromSrc,
        toSourceId: toSrc,
        originSourceId: fromSrc,
      };
      await engine.addLink(
        row.from_slug,
        row.to_slug,
        row.context ?? 'DAV-6220 relation manifest',
        row.link_type,
        row.link_source,
        row.from_slug,
        undefined,
        linkOpts,
      ); // gbrain-allow-direct-insert: manifest-bound DAV-6220 graph reconnect — guarded apply, receipted
      appliedRows.push(row);
      outcomes.push({ id: row.id, status: 'applied' });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith('Receipt write failed;') || message.startsWith('Graph fingerprint failed;')) {
      throw err;
    }
    let after: Awaited<ReturnType<typeof computeGraphFingerprint>>;
    try {
      after = await fingerprintAfterMutation(engine, opts.receiptPath, appliedRows);
    } catch (fpErr) {
      const fpMessage = fpErr instanceof Error ? fpErr.message : String(fpErr);
      throw new Error(`${message} (${fpMessage})`);
    }
    if (opts.receiptPath) {
      try {
        await commitReceiptOrUndo(engine, opts.receiptPath, appliedRows, () => {
          writeMutationReceipt(
            opts.receiptPath!,
            manifest,
            sha,
            opts,
            slice.length,
            before,
            after,
            outcomes,
            { partial_failure: true, error: message },
          );
        });
      } catch (receiptErr) {
        const receiptMessage = receiptErr instanceof Error ? receiptErr.message : String(receiptErr);
        throw new Error(`${message} (${receiptMessage})`);
      }
    }
    throw err;
  }

  const after = await fingerprintAfterMutation(engine, opts.receiptPath, appliedRows);
  const applied = outcomes.filter(o => o.status === 'applied').length;
  const ready = outcomes.filter(o => o.status === 'dry_run' || o.status === 'applied').length;
  const skipped = outcomes.filter(o => o.status.startsWith('skipped')).length;

  const result: RelationApplyResult = {
    mode: opts.apply ? 'apply' : 'dry-run',
    manifest_sha256: sha,
    rows_total: slice.length,
    ready,
    applied,
    skipped,
    outcomes,
    before,
    after,
  };

  if (opts.receiptPath) {
    await commitReceiptOrUndo(engine, opts.receiptPath, appliedRows, () => {
      writeMutationReceipt(
        opts.receiptPath!,
        manifest,
        sha,
        opts,
        slice.length,
        before,
        after,
        outcomes,
      );
    });
    result.receipt_path = opts.receiptPath;
  }

  return result;
}

export function loadRelationManifestFile(path: string): { manifest: RelationManifest; raw: string } {
  const raw = readFileSync(path, 'utf8');
  return { manifest: parseRelationManifest(raw), raw };
}

export function summarizeRowStatuses(outcomes: RelationRowOutcome[]): Record<RelationRowStatus, number> {
  const counts: Record<string, number> = {};
  for (const o of outcomes) {
    counts[o.status] = (counts[o.status] ?? 0) + 1;
  }
  return counts as Record<RelationRowStatus, number>;
}
