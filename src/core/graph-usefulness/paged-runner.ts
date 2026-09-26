/**
 * Keyset walks for `graph measure` and receipted relation apply.
 * Each page statement is `source_id = $1 AND id > $2 ORDER BY id LIMIT $3`.
 * Partial counts and a rolling identity digest live in the checkpoint so a
 * killed run resumes at the cursor without replaying earlier rows.
 */

import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import type { BrainEngine } from '../engine.ts';
import { classifyJunkSlugs } from './junk-classify.ts';
import type { GraphFingerprint, GraphMeasureResult, JunkSlugSample } from './types.ts';

export interface PagedScanOpts {
  sourceId: string;
  /** Last page id already finished. `0` starts at the beginning of the source. */
  cursor: number;
  /** Page ids per statement. */
  limit: number;
  checkpointPath: string;
}

/** Paged measure result plus the link ids counted in this walk. */
export interface PagedMeasureResult extends GraphMeasureResult {
  seen_link_ids: number[];
}

interface Checkpoint {
  source_id: string;
  cursor: number;
  done: boolean;
  active_pages: number;
  link_rows: number;
  valid_links: number;
  degree_sum: number;
  zero_degree_pages: number;
  degree_counts: Record<string, number>;
  junk: Record<string, { count: number; examples: string[] }>;
  seen_link_ids: number[];
  /**
   * Rolling sha256 hex of page and link identity lines seen so far.
   * Updated once per row. The checkpoint does not store the identity list.
   */
  identity_hash: string;
}

interface PageRow {
  id: number | string;
  slug: string;
  live: boolean;
  generation: number | string | null;
  content_hash: string | null;
  truth_md5: string | null;
}

interface LinkRow {
  id: number | string;
  from_page_id: number | string;
  to_page_id: number | string;
  live_edge: boolean;
  from_source_id: string;
  from_slug: string;
  to_source_id: string;
  to_slug: string;
  link_type: string;
  context: string | null;
  link_source: string | null;
}

interface ChunkRevRow {
  page_id: number | string;
  chunk_rev: string | null;
}

function intId(value: number | string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`page id is not an integer: ${String(value)}`);
  return n;
}

/** Prefix for one source. Later rows fold in with `rollHash`. */
export function initialIdentityHash(sourceId: string): string {
  return createHash('sha256').update('paged-measure-v2\n').update(sourceId).digest('hex');
}

/** Fold one identity line into the running digest. The hex is what we persist. */
export function rollHash(prev: string, line: string): string {
  return createHash('sha256').update(prev).update('\n').update(line).digest('hex');
}

function emptyCheckpoint(sourceId: string, cursor: number): Checkpoint {
  return {
    source_id: sourceId,
    cursor,
    done: false,
    active_pages: 0,
    link_rows: 0,
    valid_links: 0,
    degree_sum: 0,
    zero_degree_pages: 0,
    degree_counts: {},
    junk: {},
    seen_link_ids: [],
    identity_hash: initialIdentityHash(sourceId),
  };
}

function readCheckpoint(path: string, sourceId: string): Checkpoint | null {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Checkpoint>;
  if (parsed.source_id !== sourceId) {
    throw new Error(`Checkpoint ${path} is for source ${parsed.source_id}, not ${sourceId}`);
  }
  // A count-only checkpoint would keep a same-cardinality rewrite invisible.
  // Refuse it instead of hashing empty identity lists.
  if (typeof parsed.identity_hash !== 'string' || parsed.identity_hash.length === 0) {
    throw new Error(
      `Checkpoint ${path} has no identity_hash; delete it and rerun with --cursor 0`,
    );
  }
  const base = emptyCheckpoint(sourceId, parsed.cursor ?? 0);
  return {
    ...base,
    ...parsed,
    source_id: sourceId,
    identity_hash: parsed.identity_hash,
    seen_link_ids: Array.isArray(parsed.seen_link_ids) ? parsed.seen_link_ids : [],
    degree_counts: parsed.degree_counts ?? {},
    junk: parsed.junk ?? {},
  };
}

function writeCheckpoint(path: string, checkpoint: Checkpoint): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(checkpoint) + '\n');
  renameSync(tmp, path);
}

/** Postgres `percentile_cont(0.5)` over a degree histogram. */
export function medianFromHistogram(counts: Record<string, number>): number {
  const pairs = Object.entries(counts)
    .map(([degree, n]) => [Number(degree), n] as const)
    .filter(([, n]) => n > 0)
    .sort((a, b) => a[0] - b[0]);
  const total = pairs.reduce((sum, [, n]) => sum + n, 0);
  if (total === 0) return 0;
  const rank = 1 + 0.5 * (total - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const at = (position: number): number => {
    let seen = 0;
    for (const [degree, n] of pairs) {
      seen += n;
      if (position <= seen) return degree;
    }
    return pairs[pairs.length - 1][0];
  };
  if (lower === upper) return at(lower);
  return at(lower) + (at(upper) - at(lower)) * (rank - lower);
}

function resultFromCheckpoint(checkpoint: Checkpoint): PagedMeasureResult {
  if (typeof checkpoint.identity_hash !== 'string' || checkpoint.identity_hash.length === 0) {
    throw new Error('Checkpoint has no identity_hash; delete it and rerun with --cursor 0');
  }
  const avg = checkpoint.active_pages === 0 ? 0 : checkpoint.degree_sum / checkpoint.active_pages;
  const median = medianFromHistogram(checkpoint.degree_counts);
  const junk_slug_samples: JunkSlugSample[] = Object.entries(checkpoint.junk)
    .filter(([, row]) => row.count > 0)
    .map(([pattern, row]) => ({
      pattern,
      count: row.count,
      examples: [...row.examples].sort().slice(0, 3),
    }))
    .sort((a, b) => a.pattern.localeCompare(b.pattern));
  const counts = {
    active_pages: checkpoint.active_pages,
    link_rows: checkpoint.link_rows,
    valid_links: checkpoint.valid_links,
    zero_degree_pages: checkpoint.zero_degree_pages,
  };
  const sha256 = createHash('sha256')
    .update('paged-measure-v2\n')
    .update(JSON.stringify({
      source_id: checkpoint.source_id,
      ...counts,
      degree_sum: checkpoint.degree_sum,
      median_degree: median,
    }))
    .update('\n')
    .update(checkpoint.identity_hash)
    .update('\n')
    .digest('hex');
  const fingerprint: GraphFingerprint = { ...counts, sha256 };
  return {
    ...counts,
    avg_degree: avg,
    median_degree: median,
    junk_slug_samples,
    fingerprint,
    seen_link_ids: [...checkpoint.seen_link_ids],
  };
}

function mergeJunk(checkpoint: Checkpoint, slugs: string[]): void {
  if (slugs.length === 0) return;
  const samples = classifyJunkSlugs(slugs, slugs.length);
  for (const sample of samples) {
    const row = checkpoint.junk[sample.pattern] ?? { count: 0, examples: [] };
    row.count += sample.count;
    row.examples = [...row.examples, ...sample.examples].sort().slice(0, 3);
    checkpoint.junk[sample.pattern] = row;
  }
}

function pageLine(sourceId: string, page: PageRow, chunkRev: string): string {
  return JSON.stringify([
    'page',
    sourceId,
    page.slug,
    String(page.generation ?? ''),
    page.content_hash ?? '',
    page.truth_md5 ?? '',
    chunkRev,
  ]);
}

function linkLine(link: LinkRow): string {
  return JSON.stringify([
    'link',
    link.from_source_id,
    link.from_slug,
    link.to_source_id,
    link.to_slug,
    link.link_type,
    link.context ?? '',
    link.link_source ?? '',
  ]);
}

/**
 * Walk one source from the checkpoint cursor, or from `opts.cursor` when
 * the checkpoint is absent. A nonzero initial cursor without a checkpoint
 * is rejected so aggregates cannot silently omit earlier pages. A finished
 * checkpoint is returned as-is. Live edges require both endpoint pages
 * undeleted and both endpoint sources not archived.
 *
 * The fingerprint rolls a sha256 once per live page and once per newly seen
 * live link. Page and chunk revisions are read for the current id batch
 * only, so a source is never loaded in one statement.
 */
export async function runPagedMeasure(
  engine: BrainEngine,
  opts: PagedScanOpts,
): Promise<PagedMeasureResult> {
  if (!Number.isSafeInteger(opts.cursor) || opts.cursor < 0) {
    throw new Error('--cursor requires a non-negative integer');
  }
  if (!Number.isSafeInteger(opts.limit) || opts.limit < 1) {
    throw new Error('--limit requires a positive integer');
  }
  const existing = readCheckpoint(opts.checkpointPath, opts.sourceId);
  if (existing?.done) return resultFromCheckpoint(existing);
  // A nonzero --cursor with no checkpoint would zero every aggregate and
  // silently omit earlier pages. Resume only from a compatible checkpoint.
  if (!existing && opts.cursor !== 0) {
    throw new Error(
      `--cursor ${opts.cursor} requires an existing checkpoint with accumulated counts; ` +
      `use --cursor 0 to start, or pass --checkpoint naming a prior partial run`,
    );
  }
  const checkpoint = existing ?? emptyCheckpoint(opts.sourceId, opts.cursor);
  if (existing && existing.cursor < opts.cursor) {
    throw new Error(
      `Checkpoint cursor ${existing.cursor} is behind --cursor ${opts.cursor}; refusing to skip a gap`,
    );
  }
  const seen = new Set(checkpoint.seen_link_ids);

  for (;;) {
    const pages = await engine.executeRaw<PageRow>(
      `SELECT id, slug, (deleted_at IS NULL) AS live,
              generation, content_hash,
              md5(COALESCE(compiled_truth, '')) AS truth_md5
         FROM pages
        WHERE source_id = $1 AND id > $2
        ORDER BY id
        LIMIT $3`,
      [opts.sourceId, checkpoint.cursor, opts.limit],
    );
    if (pages.length === 0) {
      checkpoint.done = true;
      writeCheckpoint(opts.checkpointPath, checkpoint);
      return resultFromCheckpoint(checkpoint);
    }

    const live = pages.filter(page => page.live);
    const liveIds = live.map(page => intId(page.id));
    checkpoint.active_pages += live.length;
    mergeJunk(checkpoint, live.map(page => page.slug));

    const chunkByPage = new Map<number, string>();
    const links: LinkRow[] = [];
    if (liveIds.length > 0) {
      const chunkRows = await engine.executeRaw<ChunkRevRow>(
        `SELECT c.page_id,
                md5(string_agg(
                  c.chunk_index::text || E'\\n' ||
                  md5(c.chunk_text) || E'\\n' ||
                  COALESCE(c.chunk_source, '') || E'\\n' ||
                  COALESCE(c.embedded_text_hash, '') || E'\\n' ||
                  COALESCE(md5(c.embedding::text), '')
                , E'\\n' ORDER BY c.chunk_index, c.id)) AS chunk_rev
           FROM content_chunks c
          WHERE c.page_id = ANY($1::int[])
          GROUP BY c.page_id`,
        [liveIds],
      );
      for (const row of chunkRows) {
        chunkByPage.set(intId(row.page_id), row.chunk_rev ?? '');
      }
      const linkRows = await engine.executeRaw<LinkRow>(
        `SELECT l.id, l.from_page_id, l.to_page_id,
                fp.source_id AS from_source_id, fp.slug AS from_slug,
                tp.source_id AS to_source_id, tp.slug AS to_slug,
                l.link_type, l.context, l.link_source,
                (fp.deleted_at IS NULL AND tp.deleted_at IS NULL
                 AND NOT fs.archived AND NOT ts.archived) AS live_edge
           FROM links l
           JOIN pages fp ON fp.id = l.from_page_id
           JOIN pages tp ON tp.id = l.to_page_id
           JOIN sources fs ON fs.id = fp.source_id
           JOIN sources ts ON ts.id = tp.source_id
          WHERE l.from_page_id = ANY($1::int[]) OR l.to_page_id = ANY($1::int[])`,
        [liveIds],
      );
      links.push(...linkRows);
    }

    const degree = new Map<number, number>();
    for (const id of liveIds) degree.set(id, 0);
    const firstSeen = new Map<number, LinkRow[]>();
    for (const id of liveIds) firstSeen.set(id, []);

    for (const link of links) {
      if (!link.live_edge) continue;
      const fromId = intId(link.from_page_id);
      const toId = intId(link.to_page_id);
      // Self-links are one incident row; count them once like measure SQL.
      if (fromId === toId) {
        if (degree.has(fromId)) degree.set(fromId, (degree.get(fromId) ?? 0) + 1);
      } else {
        if (degree.has(fromId)) degree.set(fromId, (degree.get(fromId) ?? 0) + 1);
        if (degree.has(toId)) degree.set(toId, (degree.get(toId) ?? 0) + 1);
      }
      const linkId = intId(link.id);
      if (seen.has(linkId)) continue;
      const owners = liveIds.filter(id => id === fromId || id === toId);
      if (owners.length === 0) continue;
      const owner = Math.min(...owners);
      firstSeen.get(owner)?.push(link);
    }

    for (const page of live) {
      const pageId = intId(page.id);
      checkpoint.identity_hash = rollHash(
        checkpoint.identity_hash,
        pageLine(opts.sourceId, page, chunkByPage.get(pageId) ?? ''),
      );
      const fresh = (firstSeen.get(pageId) ?? [])
        .sort((a, b) => intId(a.id) - intId(b.id));
      for (const link of fresh) {
        const linkId = intId(link.id);
        if (seen.has(linkId)) continue;
        seen.add(linkId);
        checkpoint.link_rows += 1;
        checkpoint.valid_links += 1;
        checkpoint.identity_hash = rollHash(checkpoint.identity_hash, linkLine(link));
      }
    }

    for (const deg of degree.values()) {
      checkpoint.degree_sum += deg;
      if (deg === 0) checkpoint.zero_degree_pages += 1;
      const key = String(deg);
      checkpoint.degree_counts[key] = (checkpoint.degree_counts[key] ?? 0) + 1;
    }

    checkpoint.cursor = intId(pages[pages.length - 1].id);
    checkpoint.seen_link_ids = [...seen];
    writeCheckpoint(opts.checkpointPath, checkpoint);
  }
}
