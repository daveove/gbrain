import { createHash } from 'node:crypto';
import type { BrainEngine, LinkBatchInput } from './engine.ts';
import { buildBasenameIndex, queryBasenameIndex, normalizeBasename, LINK_EXTRACTOR_VERSION_TS, type LinkCandidate } from './link-extraction.ts';

const PREFIX = 'internal.pending-links.';
type PendingProbeOptions = { dryRun?: boolean; versionTs?: string; sourceId?: string;
  onReadyForeign?: (sourceId: string) => Promise<void>;
  onReadyOrigin?: (sourceId: string) => Promise<void>;
  onProcessed?: (key: string) => void };
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

function parseReference(value: string): PendingLinkReference | null {
  try {
    const ref = JSON.parse(value) as PendingLinkReference;
    if (!ref || !['slug', 'sourceId', 'revision', 'sourceIncarnation'].every(key =>
      typeof ref[key as keyof PendingLinkOrigin] === 'string' && ref[key as keyof PendingLinkOrigin].length)
      || !Array.isArray(ref.candidates) || !ref.candidates.every(candidate => candidate
        && typeof candidate.targetSlug === 'string' && candidate.targetSlug.length
        && (candidate.targetSourceId === undefined || typeof candidate.targetSourceId === 'string')
        && (candidate.fromSlug === undefined || typeof candidate.fromSlug === 'string'))) return null;
    return ref;
  } catch { return null; }
}

const PENDING_BATCH_SIZE = 100;

export type PendingLinkScanEnd = { incomplete: boolean; after: string };

/** Keyset batches filter origins or changed-source target endpoints before parsing. */
export async function* pendingLinkReferenceBatches(engine: Store, sourceId?: string,
  opts: { signal?: AbortSignal; deadline?: number; after?: string; onBatchComplete?: (key: string) => void } = {}): AsyncGenerator<PendingLinkRow[], PendingLinkScanEnd> {
  let after = opts.after ?? '';
  if (after && (typeof after !== 'string' || !after.startsWith(PREFIX))) throw new Error('Invalid pending link scan cursor');
  while (true) {
    opts.signal?.throwIfAborted();
    if (Date.now() >= (opts.deadline ?? Infinity)) return { incomplete: true, after };
    const rows = await engine.executeRaw<{ key: string; value: string }>(
      `SELECT key,value FROM config WHERE key LIKE $1 AND key > $3
        AND ($2::text IS NULL OR CASE WHEN key LIKE $1 AND pg_input_is_valid(value,'jsonb') THEN
          value::jsonb->>'sourceId'=$2 OR (value::jsonb->'candidates') @>
            jsonb_build_array(jsonb_build_object('targetSourceId',$2::text))
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(value::jsonb->'candidates')='array' THEN value::jsonb->'candidates' ELSE '[]'::jsonb END) candidate
            WHERE COALESCE(candidate->>'targetSourceId','')='' AND EXISTS (SELECT 1 FROM pages p
              WHERE p.deleted_at IS NULL AND p.source_id=$2 AND (
                p.slug=candidate->>'targetSlug'
                OR (strpos(candidate->>'targetSlug','/')=0
                  AND lower(regexp_replace(p.slug,'^.*/',''))=lower(candidate->>'targetSlug'))
              ))) END)
        ORDER BY key LIMIT $4`, [PREFIX + '%', sourceId ?? null, after, PENDING_BATCH_SIZE]);
    opts.signal?.throwIfAborted();
    if (!rows.length) return { incomplete: false, after };
    if (Date.now() >= (opts.deadline ?? Infinity)) return { incomplete: true, after };
    const parsed = rows.flatMap(row => {
      const reference = parseReference(row.value);
      return reference ? [{ ...row, reference }] : [];
    });
    if (parsed.length) yield parsed;
    after = rows.at(-1)!.key;
    opts.onBatchComplete?.(after);
    if (Date.now() >= (opts.deadline ?? Infinity)) return { incomplete: true, after };
    if (rows.length < PENDING_BATCH_SIZE) return { incomplete: false, after };
  }
}

/** Internal DB config rows survive process restarts and checkpoint GC. No page text is stored. */
export async function loadPendingLinkReferences(engine: Store, sourceId?: string): Promise<PendingLinkRow[]> {
  const rows: PendingLinkRow[] = [];
  for await (const batch of pendingLinkReferenceBatches(engine, sourceId)) rows.push(...batch);
  return rows;
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
  signal?: AbortSignal, deadline = Infinity,
  opts: PendingProbeOptions = {}): Promise<number> {
  signal?.throwIfAborted();
  if (!rows.length || Date.now() >= deadline) return 0;
  const identities = rows.map(row => ({ key: row.key, value: row.value,
    slug: row.reference.slug, sourceId: row.reference.sourceId }));
  const origins = await engine.executeRaw<{ slug: string; source_id: string; knowledge_revision: string; incarnation: string; already_stale: boolean }>(
    `SELECT p.slug,p.source_id,p.knowledge_revision,s.incarnation,
      (p.links_extracted_at IS NULL OR p.links_extracted_at < $2::timestamptz
        OR p.updated_at > p.links_extracted_at) AS already_stale
      FROM pages p JOIN sources s ON s.id=p.source_id
      JOIN jsonb_to_recordset(($1::jsonb)->'rows') AS wanted(key text,value text,slug text,"sourceId" text)
        ON p.slug=wanted.slug AND p.source_id=wanted."sourceId"
      JOIN config c ON c.key=wanted.key AND c.value=wanted.value
      WHERE p.deleted_at IS NULL`, [{ rows: identities }, opts.versionTs ?? LINK_EXTRACTOR_VERSION_TS]);
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
      if (!opts.dryRun) await engine.executeRaw('DELETE FROM config WHERE key=$1 AND value=$2', [row.key, row.value]);
    } else if (ref.candidates.some(candidate => resolves({ ...candidate, linkType: '', context: '' }, ref))) {
      if (opts.dryRun) {
        // Local already-stale origins are in the normal preflight count.
        // Foreign origins are not, so count every ready foreign handoff.
        const foreign = Boolean(opts.sourceId && ref.sourceId !== opts.sourceId);
        if (current && (foreign || !current.already_stale)) requeued++;
        opts.onProcessed?.(row.key);
        continue;
      }
      const foreign = Boolean(opts.sourceId && ref.sourceId !== opts.sourceId);
      const handoff = opts.onReadyOrigin ?? (foreign ? opts.onReadyForeign : undefined);
      if (foreign || handoff) {
        if (!handoff) throw new Error('Pending origin extraction handoff is unavailable');
        const changed = await engine.executeRaw(`UPDATE pages p SET links_extracted_at=NULL FROM sources s,config c
          WHERE p.slug=$1 AND p.source_id=$2 AND p.deleted_at IS NULL
            AND p.knowledge_revision=$3 AND s.id=p.source_id AND s.incarnation=$4
            AND c.key=$5 AND c.value=$6 RETURNING p.id`,
          [ref.slug, ref.sourceId, ref.revision, ref.sourceIncarnation, row.key, row.value]);
        if (changed.length) {
          signal?.throwIfAborted();
          await handoff(ref.sourceId);
          await engine.executeRaw(`DELETE FROM config WHERE key=$1 AND value=$2 AND EXISTS (
            SELECT 1 FROM pages p JOIN sources s ON s.id=p.source_id WHERE p.slug=$3 AND p.source_id=$4
              AND p.knowledge_revision=$5 AND p.deleted_at IS NULL AND s.incarnation=$6)`,
            [row.key, row.value, ref.slug, ref.sourceId, ref.revision, ref.sourceIncarnation]);
          requeued += changed.length;
        }
        opts.onProcessed?.(row.key);
        continue;
      }
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
    opts.onProcessed?.(row.key);
  }
  return requeued;
}

/** Mark-before-queue callers retain the registry until this durable handoff succeeds. */
export async function queuePendingOriginExtraction(engine: BrainEngine, sourceId: string, targetSourceId: string): Promise<void> {
  const { queueDeferredStaleSweep } = await import('./deferred-stale-extract.ts');
  const accepted = await queueDeferredStaleSweep(engine, { sourceId, commit: `pending-target:${targetSourceId}`,
    reason: 'pending_cross_source_target' });
  if (accepted === null) throw new Error('Pending foreign origin extraction handoff was not accepted');
}

/** Probe stored names only; normal basename semantics remain source-local. */
export async function probePendingLinkReferences(engine: Store, rows: PendingLinkRow[],
  opts: PendingProbeOptions & { globalBasename: boolean; signal?: AbortSignal; deadline?: number },
  resolves: (candidate: LinkCandidate, origin: PendingLinkReference,
    slugs: Set<string>, sources: Map<string, string[]>) => boolean): Promise<number> {
  let ready = 0;
  for (let offset = 0; offset < rows.length; offset += PENDING_BATCH_SIZE) {
    opts.signal?.throwIfAborted();
    if (Date.now() >= (opts.deadline ?? Infinity)) break;
    ready += await probePendingLinkReferenceBatch(engine, rows.slice(offset, offset + PENDING_BATCH_SIZE), opts, resolves);
  }
  return ready;
}

async function probePendingLinkReferenceBatch(engine: Store, rows: PendingLinkRow[],
  opts: PendingProbeOptions & { globalBasename: boolean; signal?: AbortSignal; deadline?: number },
  resolves: (candidate: LinkCandidate, origin: PendingLinkReference,
    slugs: Set<string>, sources: Map<string, string[]>) => boolean): Promise<number> {
  const slugs = [...new Set(rows.flatMap(row => [row.reference.slug,
    ...row.reference.candidates.flatMap(candidate => [candidate.targetSlug, candidate.fromSlug].filter((slug): slug is string => Boolean(slug)))]))];
  const bareNames = opts.globalBasename ? [...new Set(slugs.filter(slug => !slug.includes('/')).flatMap(slug =>
    [slug, slug.toLowerCase(), normalizeBasename(slug)]))] : [];
  opts.signal?.throwIfAborted();
  const refs = await engine.executeRaw<{ slug: string; source_id: string }>(
    `SELECT slug,source_id FROM pages WHERE deleted_at IS NULL AND
      (slug=ANY($1::text[]) OR (source_id=ANY($3::text[])
        AND lower(regexp_replace(slug,'^.*/',''))=ANY($2::text[])))`,
    [slugs, bareNames, [...new Set(rows.map(row => row.reference.sourceId))]]);
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
  }, opts.signal, opts.deadline, opts);
}

/** Continue after successfully probed rows, including a partially consumed final batch. */
export async function scanPendingLinkReferences(engine: Store,
  opts: Parameters<typeof probePendingLinkReferences>[2] & { after?: string },
  resolves: Parameters<typeof probePendingLinkReferences>[3]) {
  let afterKey = opts.after ?? '', ready = 0;
  const batches = pendingLinkReferenceBatches(engine, opts.sourceId, {
    signal: opts.signal, deadline: opts.deadline, after: afterKey,
    onBatchComplete: key => { afterKey = key; },
  });
  for (;;) {
    const step = await batches.next();
    if (step.done) return { ready, pendingScanIncomplete: step.value.incomplete, pendingScanAfter: afterKey };
    let processed = 0;
    ready += await probePendingLinkReferences(engine, step.value, { ...opts,
      onProcessed: key => { afterKey = key; processed++; opts.onProcessed?.(key); },
    }, resolves);
    if (processed < step.value.length) {
      await batches.return({ incomplete: true, after: afterKey });
      return { ready, pendingScanIncomplete: true, pendingScanAfter: afterKey };
    }
  }
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
