import { createHash } from 'node:crypto';
import type { BrainEngine, LinkBatchInput } from './engine.ts';
import { buildBasenameIndex, queryBasenameIndex, normalizeBasename, type LinkCandidate } from './link-extraction.ts';

const PREFIX = 'internal.pending-links.';
type Store = Pick<BrainEngine, 'executeRaw' | 'getConfig'>;
export interface PendingLinkOrigin {
  slug: string;
  sourceId: string;
  revision: string;
  sourceIncarnation: string;
}
export interface PendingLinkReference extends PendingLinkOrigin {
  candidates: Array<Pick<LinkCandidate, 'targetSlug' | 'targetSourceId' | 'fromSlug'>>;
}
export interface PendingLinkRow { key: string; value: string; reference: PendingLinkReference }

function keyFor(origin: PendingLinkOrigin): string {
  return PREFIX + createHash('sha256').update(JSON.stringify([origin.sourceId, origin.slug])).digest('hex');
}

/** Internal DB config rows survive process restarts and checkpoint GC. No page text is stored. */
export async function loadPendingLinkReferences(engine: Store, sourceId?: string): Promise<PendingLinkRow[]> {
  const rows = await engine.executeRaw<{ key: string; value: string }>(
    'SELECT key,value FROM config WHERE key LIKE $1 ORDER BY key', [PREFIX + '%']);
  return rows.map(row => ({ ...row, reference: JSON.parse(row.value) as PendingLinkReference }))
    .filter(row => !sourceId || row.reference.sourceId === sourceId);
}

export async function storePendingLinkReferences(engine: Store, origin: PendingLinkOrigin,
  candidates: LinkCandidate[], signal?: AbortSignal): Promise<void> {
  const key = keyFor(origin);
  const previous = await engine.getConfig(key);
  const reference: PendingLinkReference = { ...origin, candidates: candidates.map(candidate => ({
    targetSlug: candidate.targetSlug,
    ...(candidate.targetSourceId ? { targetSourceId: candidate.targetSourceId } : {}),
    ...(candidate.fromSlug ? { fromSlug: candidate.fromSlug } : {}),
  })) };
  signal?.throwIfAborted();
  if (!candidates.length) {
    if (previous !== null && previous !== undefined) {
      await engine.executeRaw(`DELETE FROM config WHERE key=$1 AND value=$2 AND EXISTS (
        SELECT 1 FROM pages p JOIN sources s ON s.id=p.source_id
        WHERE p.slug=$3 AND p.source_id=$4 AND p.knowledge_revision=$5
          AND p.deleted_at IS NULL AND s.incarnation=$6)`,
      [key, previous, origin.slug, origin.sourceId, origin.revision, origin.sourceIncarnation]);
    }
    return;
  }
  const written = await engine.executeRaw(`INSERT INTO config(key,value)
    SELECT $1,$2 WHERE EXISTS (SELECT 1 FROM pages p JOIN sources s ON s.id=p.source_id
      WHERE p.slug=$3 AND p.source_id=$4 AND p.knowledge_revision=$5
        AND p.deleted_at IS NULL AND s.incarnation=$6)
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value WHERE config.value=$7
    RETURNING key`, [key, JSON.stringify(reference), origin.slug, origin.sourceId,
    origin.revision, origin.sourceIncarnation, previous]);
  if (!written.length) throw new Error('Pending link registry origin or registry changed during extraction');
}

/** Only metadata and stored candidates are inspected. Dormant misses never read page bodies. */
export async function requeueReadyPendingLinks(engine: Store, rows: PendingLinkRow[],
  resolves: (candidate: LinkCandidate, origin: PendingLinkReference) => boolean,
  signal?: AbortSignal, deadline = Infinity): Promise<number> {
  const identities = rows.map(row => ({ slug: row.reference.slug, sourceId: row.reference.sourceId }));
  const origins = await engine.executeRaw<{ slug: string; source_id: string; knowledge_revision: string; incarnation: string }>(
    `SELECT p.slug,p.source_id,p.knowledge_revision,s.incarnation FROM pages p JOIN sources s ON s.id=p.source_id
      JOIN jsonb_to_recordset(($1::jsonb)->'rows') AS wanted(slug text,"sourceId" text)
        ON p.slug=wanted.slug AND p.source_id=wanted."sourceId" WHERE p.deleted_at IS NULL`, [{ rows: identities }]);
  const currentOrigins = new Map(origins.map(origin => [JSON.stringify([origin.source_id, origin.slug]), origin]));
  let requeued = 0;
  for (const row of rows) {
    signal?.throwIfAborted();
    const ref = row.reference;
    if (Date.now() >= deadline) break;
    const current = currentOrigins.get(JSON.stringify([ref.sourceId, ref.slug]));
    const obsolete = !current || current.knowledge_revision !== ref.revision
      || current.incarnation !== ref.sourceIncarnation;
    signal?.throwIfAborted();
    if (obsolete) {
      await engine.executeRaw('DELETE FROM config WHERE key=$1 AND value=$2', [row.key, row.value]);
    } else if (ref.candidates.some(candidate => resolves({ ...candidate, linkType: '', context: '' }, ref))) {
      // The config CAS and origin revision/incarnation check belong to the same statement.
      const changed = await engine.executeRaw(`WITH ready AS (
        UPDATE pages p SET links_extracted_at=NULL FROM sources s,config c
        WHERE p.slug=$1 AND p.source_id=$2 AND p.deleted_at IS NULL
          AND p.knowledge_revision=$3 AND s.id=p.source_id AND s.incarnation=$4
          AND c.key=$5 AND c.value=$6 RETURNING p.id)
        DELETE FROM config WHERE key=$5 AND value=$6 AND EXISTS(SELECT 1 FROM ready)
        RETURNING key`, [ref.slug, ref.sourceId, ref.revision, ref.sourceIncarnation, row.key, row.value]);
      requeued += changed.length;
    }
  }
  return requeued;
}

/** Probe stored names only; normal basename semantics remain source-local. */
export async function probePendingLinkReferences(engine: Store, rows: PendingLinkRow[],
  opts: { globalBasename: boolean; signal?: AbortSignal; deadline?: number },
  resolves: (candidate: LinkCandidate, origin: PendingLinkReference,
    slugs: Set<string>, sources: Map<string, string[]>) => boolean): Promise<number> {
  const slugs = [...new Set(rows.flatMap(row => [row.reference.slug,
    ...row.reference.candidates.flatMap(candidate => [candidate.targetSlug, candidate.fromSlug].filter((slug): slug is string => Boolean(slug)))]))];
  const bareNames = opts.globalBasename ? [...new Set(slugs.filter(slug => !slug.includes('/')).flatMap(slug =>
    [slug, slug.toLowerCase(), normalizeBasename(slug)]))] : [];
  opts.signal?.throwIfAborted();
  const refs = await engine.executeRaw<{ slug: string; source_id: string }>(
    `SELECT slug,source_id FROM pages WHERE deleted_at IS NULL AND
      (slug=ANY($1::text[]) OR lower(regexp_replace(slug,'^.*/',''))=ANY($2::text[]))`, [slugs, bareNames]);
  const allSlugs = new Set(refs.map(ref => ref.slug));
  const sources = new Map<string, string[]>();
  for (const ref of refs) sources.set(ref.slug, [...(sources.get(ref.slug) ?? []), ref.source_id]);
  const indexes = new Map<string, Map<string, string[]>>();
  for (const sourceId of new Set(rows.map(row => row.reference.sourceId)))
    indexes.set(sourceId, buildBasenameIndex(refs.filter(ref => ref.source_id === sourceId).map(ref => ref.slug)));
  return requeueReadyPendingLinks(engine, rows, (candidate, origin) => {
    if (resolves(candidate, origin, allSlugs, sources)) return true;
    if (!opts.globalBasename || candidate.targetSourceId || candidate.targetSlug.includes('/')) return false;
    return queryBasenameIndex(indexes.get(origin.sourceId)!, candidate.targetSlug).some(targetSlug =>
      resolves({ ...candidate, targetSlug }, origin, allSlugs, sources));
  }, opts.signal, opts.deadline);
}

/** A resolved basename edge satisfies its parser-generated bare direct candidate. */
export function pendingCandidates(candidates: LinkCandidate[], rows: LinkBatchInput[], globalBasename: boolean, originSlug: string, originSourceId: string): LinkCandidate[] {
  return candidates.filter(candidate => !globalBasename || candidate.targetSourceId || candidate.targetSlug.includes('/')
    || !rows.some(row => {
      if (row.link_source !== 'wikilink-resolved' || row.to_source_id !== originSourceId
        || row.from_source_id !== originSourceId || row.context !== candidate.context) return false;
      const target = row.link_type === 'attended' && row.origin_slug === originSlug
        && row.origin_source_id === originSourceId && row.to_slug === originSlug
        ? row.from_slug : row.from_slug === (candidate.fromSlug ?? originSlug) ? row.to_slug : undefined;
      return target !== undefined
        && normalizeBasename(target.split('/').at(-1)!) === normalizeBasename(candidate.targetSlug);
    }));
}
