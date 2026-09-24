import { createHash } from 'crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'fs';
import { dirname } from 'path';
import type { BrainEngine } from '../engine.ts';
import { sanitizeForJsonb } from '../batch-rows.ts';
import { PageMissingError } from '../engine-errors.ts';
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

const REQUIRED_RELATION_STRINGS = ['id', 'from_slug', 'to_slug', 'link_type', 'link_source'] as const;
const OPTIONAL_RELATION_STRINGS = ['context', 'from_source_id', 'to_source_id'] as const;

/**
 * Hand-authored JSON can pass a truthy non-string (`link_type: 123`).
 * Reject those while parsing, before a receipt or any link write. Required
 * fields must be non-empty strings. Optional context and source ids, when
 * present, must be strings.
 */
function assertRelationFieldStrings(row: unknown, index: number): RelationManifestRow {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(`Row ${index}: must be an object`);
  }
  const record = row as Record<string, unknown>;
  const label = typeof record.id === 'string' && record.id.length > 0 ? record.id : String(index);
  for (const field of REQUIRED_RELATION_STRINGS) {
    const value = record[field];
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`Row ${label}: ${field} must be a non-empty string`);
    }
  }
  for (const field of OPTIONAL_RELATION_STRINGS) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) continue;
    const value = record[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') {
      throw new Error(`Row ${label}: ${field} must be a string`);
    }
  }
  return row as RelationManifestRow;
}

export function parseRelationManifest(raw: string): RelationManifest {
  const parsed = JSON.parse(raw) as RelationManifest;
  if (parsed.manifest_version !== RELATION_MANIFEST_VERSION) {
    throw new Error(`Unsupported manifest_version ${parsed.manifest_version}; expected ${RELATION_MANIFEST_VERSION}`);
  }
  if (!Array.isArray(parsed.rows) || parsed.rows.length === 0) {
    throw new Error('Relation manifest must include a non-empty rows array');
  }
  for (let i = 0; i < parsed.rows.length; i++) {
    const row = assertRelationFieldStrings(parsed.rows[i], i);
    parsed.rows[i] = row;
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

function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const child = record[key];
      if (child === undefined) continue;
      sorted[key] = sortJsonKeys(child);
    }
    return sorted;
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJsonKeys(value));
}

function parseManifestRaw(manifestRaw: string): unknown {
  try {
    return JSON.parse(manifestRaw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Relation manifestRaw is not valid JSON: ${message}`);
  }
}

/**
 * The receipt hashes `manifestRaw`. Apply that parsed document, and refuse
 * a caller-supplied object that is not the same JSON value, before any
 * receipt or link write.
 */
function manifestBoundToRaw(manifest: RelationManifest, manifestRaw: string): RelationManifest {
  const parsed = parseManifestRaw(manifestRaw);
  if (canonicalJson(manifest) !== canonicalJson(parsed)) {
    throw new Error('Relation manifest object does not match manifestRaw');
  }
  return parsed as RelationManifest;
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
    `WITH endpoints AS (
       SELECT p.id FROM pages p
        WHERE p.deleted_at IS NULL
          AND ((p.slug = $1 AND p.source_id = $2) OR (p.slug = $3 AND p.source_id = $4))
     )
     SELECT count(*)::text AS n FROM links l
      WHERE l.from_page_id IN (SELECT id FROM endpoints)
         OR l.to_page_id IN (SELECT id FROM endpoints)`,
    [from, fromSourceId, to, toSourceId],
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
    return { id: row.id, status: 'skipped_already_linked', reason: 'incident edge already exists' };
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

/**
 * Runs inside the locked apply transaction, after the endpoint pages are
 * locked and before the no-edge recheck. Tests inject a concurrent edge
 * or a write failure. Production leaves this null.
 */
let beforeGuardedLinkInsertForTests: ((
  tx: BrainEngine,
  row: RelationManifestRow,
) => Promise<void>) | null = null;

/** @internal */
export function _setBeforeGuardedLinkInsertForTests(
  fn: ((tx: BrainEngine, row: RelationManifestRow) => Promise<void>) | null,
): void {
  beforeGuardedLinkInsertForTests = fn;
}

/** @internal Fault injection for receipt-commit failure tests. */
let beforeReceiptCommitForTests: (() => void | Promise<void>) | null = null;

export function _setBeforeReceiptCommitForTests(fn: (() => void | Promise<void>) | null): void {
  beforeReceiptCommitForTests = fn;
}

function fsyncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? (err as { code?: string }).code : undefined;
    if (code !== 'EINVAL' && code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EBADF') throw err;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Replace `path` with a complete JSON body. A crash keeps the previous file. */
function replaceDurableFile(path: string, body: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* the rename error is the one that matters */ }
    throw err;
  }
  fsyncDir(dirname(path));
}

/**
 * Exclusive-create the receipt as durable JSON before any link mutation.
 * An empty file is never the reserved state: a crash mid-loop must leave a
 * receipt that names the rows, not a blocker with no record.
 */
function reserveMutationReceipt(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  let fd: number | undefined;
  try {
    fd = openSync(path, 'wx');
  } catch (err) {
    if (isEexist(err)) throw new MutationReceiptExistsError(path);
    throw err;
  }
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } catch (err) {
    try { unlinkSync(path); } catch { /* exclusive path may remain */ }
    throw err;
  } finally {
    closeSync(fd);
  }
  fsyncDir(dirname(path));
}

/** Columns this manifest inserted. A later addLink can update the same id. */
interface ManifestOwnedLink {
  fromPageId: number;
  toPageId: number;
  linkType: string;
  linkSource: string;
  originPageId: number;
  context: string;
}

interface AppliedManifestLink {
  row: RelationManifestRow;
  linkId: number;
  owned: ManifestOwnedLink;
}

/**
 * Delete a row only while it is still the version this manifest inserted.
 * addLink's ON CONFLICT DO UPDATE can change context and origin_field on
 * that same id after the insert commits. Deleting by id alone would remove
 * the other writer's committed update. A row that no longer matches is left
 * in place. A row that is already gone counts as rolled back.
 * Returns how many rows were left because another writer owns them.
 */
async function rollbackAppliedLinks(
  engine: BrainEngine,
  applied: AppliedManifestLink[],
): Promise<number> {
  const failures: string[] = [];
  let preserved = 0;
  for (const item of [...applied].reverse()) {
    try {
      const removed = await engine.executeRaw<{ id: number }>(
        `DELETE FROM links
          WHERE id = $1
            AND from_page_id = $2
            AND to_page_id = $3
            AND link_type = $4
            AND link_source IS NOT DISTINCT FROM $5
            AND origin_page_id IS NOT DISTINCT FROM $6
            AND context IS NOT DISTINCT FROM $7
            AND origin_field IS NULL
            AND link_kind IS NULL
            AND resolution_type IS NULL
          RETURNING id`,
        [
          item.linkId,
          item.owned.fromPageId,
          item.owned.toPageId,
          item.owned.linkType,
          item.owned.linkSource,
          item.owned.originPageId,
          item.owned.context,
        ],
      );
      if (removed.length === 1) continue;
      const still = await engine.executeRaw<{ id: number }>(
        `SELECT id FROM links WHERE id = $1`,
        [item.linkId],
      );
      if (still.length === 1) preserved += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${item.row.id}: ${message}`);
    }
  }
  if (failures.length > 0) throw new Error(failures.join('; '));
  return preserved;
}

/** Drop committed rows and the reserved receipt. Returns the undo clause. */
async function undoAppliedLinks(
  engine: BrainEngine,
  receiptPath: string,
  appliedRows: AppliedManifestLink[],
): Promise<string> {
  let undo = `rolled back ${appliedRows.length} applied link(s)`;
  try {
    const preserved = await rollbackAppliedLinks(engine, appliedRows);
    if (preserved > 0) {
      const removed = appliedRows.length - preserved;
      undo = `rolled back ${removed} applied link(s); left ${preserved} concurrently updated link(s)`;
    }
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
  appliedRows: AppliedManifestLink[],
  write: () => void | Promise<void>,
): Promise<void> {
  try {
    await write();
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
  appliedRows: AppliedManifestLink[],
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

type GuardedInsertResult =
  | { status: 'inserted'; linkId: number; owned: ManifestOwnedLink }
  | { status: 'already_linked' }
  | { status: 'conflict' };

function readInsertedLinkId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) return Number(value);
  return null;
}

/**
 * Recheck `no_incident_edge` and insert in one transaction.
 *
 * The endpoint pages are locked FOR UPDATE first, so another session cannot
 * commit a link that references them until this transaction ends. The
 * following statement then sees every edge that committed before the lock
 * and inserts only when neither endpoint has any incident edge, in either
 * direction, including an edge to a third page. ON CONFLICT DO NOTHING does
 * not overwrite an identical row, and a zero-row insert is a conflict rather
 * than a new applied link.
 */
async function insertNoIncidentEdge(
  engine: BrainEngine,
  row: RelationManifestRow,
): Promise<GuardedInsertResult> {
  const fromSrc = row.from_source_id ?? 'default';
  const toSrc = row.to_source_id ?? 'default';
  const context = sanitizeForJsonb(row.context ?? 'DAV-6220 relation manifest');
  const linkType = row.link_type || '';
  const linkSource = row.link_source;

  return engine.transaction(async (tx) => {
    const locked = await tx.executeRaw<{ id: number; slug: string; source_id: string }>(
      `SELECT id, slug, source_id FROM pages
        WHERE deleted_at IS NULL
          AND (
            (slug = $1 AND source_id = $2)
            OR (slug = $3 AND source_id = $4)
          )
        ORDER BY id
        FOR UPDATE`,
      [row.from_slug, fromSrc, row.to_slug, toSrc],
    );
    const from = locked.find(p => p.slug === row.from_slug && p.source_id === fromSrc);
    const to = locked.find(p => p.slug === row.to_slug && p.source_id === toSrc);
    if (!from) throw new PageMissingError('addLink', 'from', row.from_slug, fromSrc);
    if (!to) throw new PageMissingError('addLink', 'to', row.to_slug, toSrc);
    // Hold the source rows across the insert. An archive that commits after
    // the preflight blocks here until this transaction ends, and one that
    // already committed is visible to the re-read below.
    await tx.executeRaw(
      `SELECT id FROM sources WHERE id = $1 OR id = $2 ORDER BY id FOR UPDATE`,
      [fromSrc, toSrc],
    );
    // Pages and sources stay locked. A competing edge or archive inserted
    // here is visible to the recheck below.
    await beforeGuardedLinkInsertForTests?.(tx, row);
    const sourceIds = fromSrc === toSrc ? [fromSrc] : [fromSrc, toSrc];
    for (const id of sourceIds) {
      await resolveSourceId(tx, id);
    }

    const rows = await tx.executeRaw<{
      incident_n: string;
      inserted_n: string;
      inserted_id: string | number | null;
    }>(
      `WITH incident AS (
         SELECT 1 FROM links l
         WHERE l.from_page_id IN ($1, $2) OR l.to_page_id IN ($1, $2)
       ),
       inserted AS (
         INSERT INTO links (from_page_id, to_page_id, link_type, context, link_source, origin_page_id)
         SELECT $1, $2, $3, $4, $5, $1
         WHERE NOT EXISTS (SELECT 1 FROM incident)
         ON CONFLICT ON CONSTRAINT links_from_to_type_source_origin_unique DO NOTHING
         RETURNING id
       )
       SELECT
         (SELECT count(*)::text FROM incident) AS incident_n,
         (SELECT count(*)::text FROM inserted) AS inserted_n,
         (SELECT id::text FROM inserted) AS inserted_id`,
      [from.id, to.id, linkType, context, linkSource],
    );
    const incidentN = Number(rows[0]?.incident_n ?? 0);
    const insertedN = Number(rows[0]?.inserted_n ?? 0);
    if (incidentN > 0) return { status: 'already_linked' };
    if (insertedN === 0) return { status: 'conflict' };
    const linkId = readInsertedLinkId(rows[0]?.inserted_id);
    // Still inside the insert transaction. A missing id aborts that insert
    // instead of recording a row this run cannot later delete by id.
    if (linkId === null) throw new Error(`manifest row ${row.id}: inserted link id missing`);
    return {
      status: 'inserted',
      linkId,
      owned: {
        fromPageId: from.id,
        toPageId: to.id,
        linkType,
        linkSource,
        originPageId: from.id,
        context,
      },
    };
  });
}

async function writeMutationReceipt(
  path: string,
  manifest: RelationManifest,
  sha: string,
  opts: ApplyRelationManifestOpts,
  sliceLen: number,
  before: Awaited<ReturnType<typeof computeGraphFingerprint>>,
  after: Awaited<ReturnType<typeof computeGraphFingerprint>>,
  outcomes: RelationRowOutcome[],
  extra?: { partial_failure?: boolean; error?: string },
): Promise<void> {
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
  await beforeReceiptCommitForTests?.();
  // The path was exclusive-created by reserveMutationReceipt. Replace that
  // in-progress file with the final receipt. rename keeps a crash from
  // leaving it empty.
  replaceDurableFile(path, JSON.stringify(receipt, null, 2) + '\n');
}

export async function applyRelationManifest(
  engine: BrainEngine,
  manifest: RelationManifest,
  manifestRaw: string,
  opts: ApplyRelationManifestOpts,
): Promise<RelationApplyResult> {
  // Receipt hashes manifestRaw. Apply that document so a second object
  // cannot name different endpoints under the same hash.
  manifest = manifestBoundToRaw(manifest, manifestRaw);
  // Same string checks as parse. A caller that skips the parser still
  // fails before the receipt is reserved or any row is written.
  if (!Array.isArray(manifest.rows)) {
    throw new Error('Relation manifest must include a non-empty rows array');
  }
  for (let i = 0; i < manifest.rows.length; i++) {
    assertRelationFieldStrings(manifest.rows[i], i);
  }
  if (opts.receiptPath) refuseExistingReceipt(opts.receiptPath);
  const sha = manifestSha256(manifestRaw);
  const slice = (opts.limit ? manifest.rows.slice(0, opts.limit) : manifest.rows)
    .map(row => resolveRowSources(row, opts.defaultSourceId));
  await assertActiveConcreteRowSources(engine, slice);
  const before = await computeGraphFingerprint(engine);
  await assertActivePackLinkVocabulary(engine, slice);
  const createdAt = new Date().toISOString();
  const outcomes: RelationRowOutcome[] = [];
  const appliedLinks: AppliedManifestLink[] = [];

  const checkpointBody = (pendingId?: string): string => {
    const listed = pendingId
      ? [...outcomes, { id: pendingId, status: 'pending_commit' as const }]
      : outcomes;
    return JSON.stringify({
      issue: manifest.issue ?? 'DAV-6220',
      mode: opts.apply ? 'apply' : 'dry-run',
      created_at: createdAt,
      manifest_sha256: sha,
      operator: opts.operator ?? 'gbrain',
      phase: 'in_progress',
      counts: {
        planned: slice.length,
        applied: listed.filter(o => o.status === 'applied').length,
        skipped: listed.filter(o => o.status.startsWith('skipped')).length,
      },
      before,
      outcomes: listed,
    }, null, 2) + '\n';
  };
  const checkpoint = (pendingId?: string): void => {
    if (!opts.receiptPath) return;
    replaceDurableFile(opts.receiptPath, checkpointBody(pendingId));
  };
  // Durable JSON from the first exclusive create. Never an empty file.
  if (opts.receiptPath) reserveMutationReceipt(opts.receiptPath, checkpointBody());

  try {
    for (const row of slice) {
      const verdict = await evaluateRow(engine, row);
      if (verdict.status !== 'ready') {
        outcomes.push(verdict);
        checkpoint();
        continue;
      }
      if (!opts.apply) {
        outcomes.push({ id: row.id, status: 'dry_run' });
        checkpoint();
        continue;
      }

      // Record the row before the link transaction commits. A crash in the
      // insert leaves this pending_commit entry instead of an empty receipt.
      checkpoint(row.id);
      const inserted = await insertNoIncidentEdge(engine, row);
      if (inserted.status !== 'inserted') {
        outcomes.push({
          id: row.id,
          status: 'skipped_already_linked',
          reason: inserted.status === 'conflict'
            ? 'identical edge conflict; not overwritten'
            : 'incident edge already exists',
        });
        checkpoint();
        continue;
      }
      appliedLinks.push({ row, linkId: inserted.linkId, owned: inserted.owned });
      outcomes.push({ id: row.id, status: 'applied' });
      checkpoint();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith('Receipt write failed;') || message.startsWith('Graph fingerprint failed;')) {
      throw err;
    }
    let after: Awaited<ReturnType<typeof computeGraphFingerprint>>;
    try {
      after = await fingerprintAfterMutation(engine, opts.receiptPath, appliedLinks);
    } catch (fpErr) {
      const fpMessage = fpErr instanceof Error ? fpErr.message : String(fpErr);
      throw new Error(`${message} (${fpMessage})`);
    }
    if (opts.receiptPath) {
      try {
        await commitReceiptOrUndo(engine, opts.receiptPath, appliedLinks, async () => {
          await writeMutationReceipt(
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

  const after = await fingerprintAfterMutation(engine, opts.receiptPath, appliedLinks);
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
    await commitReceiptOrUndo(engine, opts.receiptPath, appliedLinks, async () => {
      await writeMutationReceipt(
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
