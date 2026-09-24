import { createHash } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import type { BrainEngine } from '../engine.ts';
import { MANAGED_LINK_SOURCES } from '../ops/links.ts';
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
import { RELATION_MANIFEST_VERSION } from './types.ts';

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

  if (!g.exact_endpoint_match || !g.source_relation_current || !g.no_incident_edge || !g.readwise_clear) {
    return { id: row.id, status: 'skipped_guard', reason: 'manifest guard flag false' };
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
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(receipt, null, 2) + '\n');
}

export async function applyRelationManifest(
  engine: BrainEngine,
  manifest: RelationManifest,
  manifestRaw: string,
  opts: ApplyRelationManifestOpts,
): Promise<RelationApplyResult> {
  const before = await computeGraphFingerprint(engine);
  const sha = manifestSha256(manifestRaw);
  const slice = opts.limit ? manifest.rows.slice(0, opts.limit) : manifest.rows;
  const outcomes: RelationRowOutcome[] = [];

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
      outcomes.push({ id: row.id, status: 'applied' });
    }
  } catch (err) {
    const after = await computeGraphFingerprint(engine);
    const message = err instanceof Error ? err.message : String(err);
    if (opts.receiptPath) {
      writeMutationReceipt(
        opts.receiptPath,
        manifest,
        sha,
        opts,
        slice.length,
        before,
        after,
        outcomes,
        { partial_failure: true, error: message },
      );
    }
    throw err;
  }

  const after = await computeGraphFingerprint(engine);
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
    writeMutationReceipt(
      opts.receiptPath,
      manifest,
      sha,
      opts,
      slice.length,
      before,
      after,
      outcomes,
    );
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
