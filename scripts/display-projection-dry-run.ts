#!/usr/bin/env bun

import { SQL, type TransactionSQL } from 'bun';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectPage, redactedPreview, referencedRecordIds, textFingerprint, type PageSnapshot, type ReferenceSnapshot } from './display-projection.ts';
import { loadHistoricalSource, verifyHistoricalSource, type SourceBundle } from './display-projection-source.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_ADDITIONAL = 500;
const MAX_RESOLUTION_DEPTH = 32;
const MAX_RESOLUTION_PAGES = 5_000;
const MAX_REFERENCE_IDS = 10_000;
const REFERENCE_BATCH_SIZE = 250;
const HTML_PATTERN = '<[[:space:]]*/?[[:space:]]*(a|b|blockquote|br|code|div|em|h[1-6]|head|hr|i|img|li|ol|p|pre|s|script|span|strong|style|table|tbody|td|th|thead|tr|u|ul)([[:space:]][^>]*|[[:space:]]*/?)>';
const JSON_PATTERN = '^[[:space:]]*[{][[:space:]]*"(children|id|props)"';
const TRANSFORM_RULES = {
  version: 2,
  caption_code_points: 120,
  caption: 'Derived context plus stable page identity; never replace the searchable title.',
  body: 'Preserve typed dates/timezone, inline node labels and tuple fields before HTML-to-text normalization.',
  tana: 'Source-scoped references; explicit Readwise exclusions; unknown, empty and bounded projections are held.',
  idempotency: 'Normalize the derived caption/body twice; retain original source and index fields unchanged.',
  selection: { html: HTML_PATTERN, json: JSON_PATTERN, all: 'Every active page in the selected Tana source.' },
  resolution: { depth: MAX_RESOLUTION_DEPTH, pages: MAX_RESOLUTION_PAGES, reference_ids: MAX_REFERENCE_IDS },
} as const;

const HELP = `Usage:
  bun scripts/display-projection-dry-run.ts [--dry-run] --example-slug SLUG
    [--limit 50] [--source SOURCE] [--receipt out/PATH.json]
  bun scripts/display-projection-dry-run.ts --all --source SOURCE
    [--example-slug SLUG] [--receipt out/PATH.json]
  Either mode accepts:
    [--source-records PATH --source-records-sha256 SHA256 --source SOURCE]

The sample requires the exact example slug, or GBRAIN_DISPLAY_PROJECTION_EXAMPLE_SLUG.
--all requires --source and selects every active page, without the sample limits.
--all and --limit cannot be combined. --limit defaults to 50 additional pages
and accepts 0 through ${MAX_ADDITIONAL}. Samples are deterministic, not representative.
GBRAIN_DATABASE_URL must use postgres:// or postgresql:// with a Supabase
.pooler.supabase.com host on port 6543. No database fallback is used.
Only Tana sources or pages marked frontmatter.source_system=tana are eligible.

Caption and display_body are DERIVED views. Canonical title, compiled_truth,
source, slug and all indexes remain untouched. No write or reindex is authorized.
Dry-run is the only mode. --apply is refused before connecting. No engine
initialization, migration, repair or database-write path exists.
One REPEATABLE READ READ ONLY transaction uses prepare:false and max:1,
with a 30-second local statement timeout. Exact full page snapshots are checked
inside that snapshot, which does not exclude writes by other sessions.

Without the dated export, references resolve only against active imported pages.
Sample resolution is bounded to ${MAX_RESOLUTION_DEPTH} levels, ${MAX_RESOLUTION_PAGES} fetched rows
and ${MAX_REFERENCE_IDS} IDs. Full-corpus mode indexes all active source pages.
--source-records accepts the original 40,731-node JSON array or {docs: [...]}.
Its exact bytes must match --source-records-sha256. Every selected imported node
must match its immutable source_hash. A later app cache is not a substitute.
Record-level Readwise markers are excluded under the original import screen.
The file hash is an operator pin, not independent proof of historical provenance.

Unknown, excluded, empty, malformed, cyclic and traversal-limited content is held.
Changed derived previews are NOT safe-to-apply counts. Held previews remain partial.
The receipt records caption collisions, original fingerprints and normalization.
This is display validation, not a semantic retrieval benchmark. Use
display-projection-retrieval-dry-run.ts with pinned original queries and native
before/after snapshots to check unchanged retrieval. It does not assign new grades.

Receipts are private 0600 files created exclusively under out/. Other slugs,
prose, URLs, attributes and record IDs are redacted. Only an explicitly selected
example slug is retained. Stdout contains paths/counts only; errors use fixed codes.
`;

class RunnerError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

interface Options {
  exampleSlug?: string;
  source?: string;
  all: boolean;
  limit: number;
  receipt: string;
  sourceRecords?: string;
  sourceRecordsSha256?: string;
}

interface SnapshotRow {
  snapshot: string;
}

interface LoadedPage {
  page: PageSnapshot;
  snapshot: string;
  sourceSystem: string | null;
  sourceHash: string | null;
}

function parseOptions(args: string[]): Options | null {
  if (args.some((arg) => arg === '--apply' || arg.startsWith('--apply='))) {
    throw new RunnerError('APPLY_REFUSED');
  }
  if (args.includes('--help') || args.includes('-h')) return null;
  let exampleSlug = process.env.GBRAIN_DISPLAY_PROJECTION_EXAMPLE_SLUG;
  let source: string | undefined;
  let sourceRecords: string | undefined;
  let sourceRecordsSha256: string | undefined;
  let all = false;
  let limit = 50;
  let receipt = `out/dav6220-display-projection-${new Date().toISOString().replaceAll(':', '-')}.json`;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--dry-run') continue;
    if (flag === '--all') {
      if (all) throw new RunnerError('INVALID_ARGUMENT');
      all = true;
      continue;
    }
    if (!['--example-slug', '--source', '--limit', '--receipt', '--source-records', '--source-records-sha256'].includes(flag)) {
      throw new RunnerError('INVALID_ARGUMENT');
    }
    const value = args[++index];
    if (!value || value.startsWith('--') || seen.has(flag)) throw new RunnerError('INVALID_ARGUMENT');
    seen.add(flag);
    if (flag === '--example-slug') exampleSlug = value;
    if (flag === '--source') source = value;
    if (flag === '--receipt') receipt = value;
    if (flag === '--source-records') sourceRecords = value;
    if (flag === '--source-records-sha256') sourceRecordsSha256 = value;
    if (flag === '--limit') {
      if (!/^\d+$/.test(value)) throw new RunnerError('INVALID_LIMIT');
      limit = Number(value);
      if (!Number.isSafeInteger(limit) || limit > MAX_ADDITIONAL) throw new RunnerError('INVALID_LIMIT');
    }
  }
  if (all && (!source || seen.has('--limit'))) throw new RunnerError('INVALID_ALL_OPTIONS');
  if (!all && !exampleSlug?.trim()) throw new RunnerError('EXAMPLE_SLUG_REQUIRED');
  if (Boolean(sourceRecords) !== Boolean(sourceRecordsSha256) || (sourceRecords && !source)) {
    throw new RunnerError('INVALID_SOURCE_OPTIONS');
  }
  if (sourceRecordsSha256 && !/^[a-f0-9]{64}$/i.test(sourceRecordsSha256)) throw new RunnerError('INVALID_SOURCE_HASH');
  return { exampleSlug, source, all, limit, receipt, sourceRecords, sourceRecordsSha256 };
}

function databaseUrl(): URL {
  const value = process.env.GBRAIN_DATABASE_URL;
  if (!value) throw new RunnerError('DATABASE_URL_REQUIRED');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RunnerError('INVALID_DATABASE_TARGET');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || !url.hostname.toLowerCase().endsWith('.pooler.supabase.com') || url.port !== '6543') {
    throw new RunnerError('INVALID_DATABASE_TARGET');
  }
  return url;
}

function decodeRow(row: SnapshotRow): LoadedPage {
  let value: unknown;
  try {
    value = JSON.parse(row.snapshot);
  } catch {
    throw new RunnerError('INVALID_PAGE_ROW');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new RunnerError('INVALID_PAGE_ROW');
  const data = value as Record<string, unknown>;
  if (!Number.isSafeInteger(data.id) || typeof data.source_id !== 'string' || typeof data.slug !== 'string'
    || typeof data.title !== 'string' || typeof data.compiled_truth !== 'string'
    || typeof data.frontmatter !== 'object' || data.frontmatter === null || Array.isArray(data.frontmatter)) {
    throw new RunnerError('INVALID_PAGE_ROW');
  }
  const frontmatter = data.frontmatter as Record<string, unknown>;
  return {
    page: {
      id: data.id as number,
      source_id: data.source_id,
      slug: data.slug,
      title: data.title,
      compiled_truth: data.compiled_truth,
      record_id: typeof frontmatter.source_record_id === 'string' ? frontmatter.source_record_id : null,
    },
    snapshot: row.snapshot,
    sourceSystem: typeof frontmatter.source_system === 'string' ? frontmatter.source_system : null,
    sourceHash: typeof frontmatter.source_hash === 'string' ? frontmatter.source_hash : null,
  };
}


function beforeReasons(page: PageSnapshot): string[] {
  const reasons: string[] = [];
  if (/[\r\n]|\\[nr]/.test(page.title)) reasons.push('multiline_title');
  const html = /<\s*\/?\s*(?:a|b|blockquote|br|code|div|em|h[1-6]|head|hr|i|img|li|ol|p|pre|s|script|span|strong|style|table|tbody|td|th|thead|tr|u|ul)(?:\s[^>]*|\s*\/?)>/i;
  if (html.test(page.title)) reasons.push('html_title');
  if (html.test(page.compiled_truth)) reasons.push('html_body');
  if (/^\s*\{/.test(page.compiled_truth) && /"(?:props|children)"/.test(page.compiled_truth)) reasons.push('raw_tana_json');
  return reasons;
}

async function resolveNodes(tx: TransactionSQL, source: string, roots: PageSnapshot[], completeSource: boolean) {
  const nodes = new Map<string, PageSnapshot>();
  const ambiguous = new Set<string>();
  function index(page: PageSnapshot) {
    if (!page.record_id || ambiguous.has(page.record_id)) return;
    const previous = nodes.get(page.record_id);
    if (previous && previous.id !== page.id) {
      ambiguous.add(page.record_id);
      nodes.delete(page.record_id);
    } else {
      nodes.set(page.record_id, page);
    }
  }
  roots.forEach(index);
  if (completeSource) {
    return { nodes, warnings: ambiguous.size ? [`ambiguous_reference:${ambiguous.size}`] : [], fetched: 0, batches: 0, depth: 0 };
  }
  const attempted = new Set<string>();
  const limitations: string[] = [];
  let frontier = new Set(roots.flatMap(referencedRecordIds));
  let fetched = 0;
  let batches = 0;
  let depth = 0;
  while (frontier.size > 0 && depth < MAX_RESOLUTION_DEPTH) {
    const pending = [...frontier].filter((id) => !attempted.has(id) && !ambiguous.has(id)).sort();
    if (pending.length === 0) break;
    if (attempted.size + pending.length > MAX_REFERENCE_IDS) {
      limitations.push('resolution_reference_limit:1');
      break;
    }
    const next = new Set<string>();
    for (let start = 0; start < pending.length; start += REFERENCE_BATCH_SIZE) {
      const ids = pending.slice(start, start + REFERENCE_BATCH_SIZE);
      ids.forEach((id) => attempted.add(id));
      const budget = MAX_RESOLUTION_PAGES - fetched;
      const rows = await tx<SnapshotRow[]>`
        SELECT to_jsonb(p)::text AS snapshot FROM pages p
        WHERE p.source_id = ${source} AND p.deleted_at IS NULL
          AND (p.source_id ~* '^tana(-|$)' OR lower(p.frontmatter->>'source_system') = 'tana')
          AND p.frontmatter->>'source_record_id' IN (
            SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::text::jsonb)
          )
        ORDER BY p.frontmatter->>'source_record_id', p.id
        LIMIT ${budget + 1}
      `;
      batches++;
      if (rows.length > budget) {
        limitations.push('resolution_page_limit:1');
        return { nodes, warnings: [...limitations, ...(ambiguous.size ? [`ambiguous_reference:${ambiguous.size}`] : [])], fetched, batches, depth };
      }
      fetched += rows.length;
      for (const row of rows) {
        const { page } = decodeRow(row);
        index(page);
        for (const id of referencedRecordIds(page)) if (!attempted.has(id) && !ambiguous.has(id)) next.add(id);
      }
    }
    frontier = next;
    depth++;
  }
  if ([...frontier].some((id) => !attempted.has(id)) && depth >= MAX_RESOLUTION_DEPTH) {
    limitations.push('resolution_depth_limit:1');
  }
  if (ambiguous.size) limitations.push(`ambiguous_reference:${ambiguous.size}`);
  return { nodes, warnings: limitations, fetched, batches, depth };
}

async function transformHash(): Promise<string> {
  const hash = createHash('sha256');
  for (const name of ['scripts/display-projection.ts', 'scripts/display-projection-source.ts', 'src/core/google/google-render.ts']) {
    const bytes = await readFile(join(REPO_ROOT, name));
    hash.update(JSON.stringify([name, bytes.length]));
    hash.update(bytes);
  }
  hash.update(JSON.stringify(TRANSFORM_RULES));
  return hash.digest('hex');
}

async function receiptPath(requested: string): Promise<string> {
  const root = await realpath(REPO_ROOT);
  const out = join(root, 'out');
  await mkdir(out, { mode: 0o700, recursive: true });
  if ((await lstat(out)).isSymbolicLink() || await realpath(out) !== out) throw new RunnerError('UNSAFE_RECEIPT_PATH');
  const target = isAbsolute(requested) ? resolve(requested) : resolve(root, requested);
  const inside = relative(out, target);
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside) || !target.endsWith('.json')) {
    throw new RunnerError('UNSAFE_RECEIPT_PATH');
  }
  let parent = out;
  for (const part of relative(out, dirname(target)).split(sep).filter(Boolean)) {
    parent = join(parent, part);
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(parent) !== parent) {
      throw new RunnerError('UNSAFE_RECEIPT_PATH');
    }
  }
  return target;
}

async function collectReceipt(sql: SQL, options: Options, hash: string, historical?: SourceBundle) {
  return sql.begin('ISOLATION LEVEL REPEATABLE READ READ ONLY', async (tx) => {
    await tx`SET LOCAL statement_timeout = '30s'`;
    const readOnly = await tx<{ transaction_read_only: string }[]>`SHOW transaction_read_only`;
    const isolation = await tx<{ transaction_isolation: string }[]>`SHOW transaction_isolation`;
    if (readOnly[0]?.transaction_read_only !== 'on' || isolation[0]?.transaction_isolation !== 'repeatable read') {
      throw new RunnerError('READ_ONLY_TRANSACTION_REQUIRED');
    }
    let example: LoadedPage | undefined;
    if (options.exampleSlug !== undefined) {
      const examples = options.source === undefined
        ? await tx<SnapshotRow[]>`
            SELECT to_jsonb(p)::text AS snapshot FROM pages p
            WHERE p.slug = ${options.exampleSlug} AND p.deleted_at IS NULL
            ORDER BY p.source_id, p.id LIMIT 2
          `
        : await tx<SnapshotRow[]>`
            SELECT to_jsonb(p)::text AS snapshot FROM pages p
            WHERE p.slug = ${options.exampleSlug} AND p.source_id = ${options.source} AND p.deleted_at IS NULL
            ORDER BY p.id LIMIT 2
          `;
      if (examples.length === 0) throw new RunnerError('EXAMPLE_NOT_FOUND');
      if (examples.length !== 1) throw new RunnerError('AMBIGUOUS_EXAMPLE_SOURCE');
      example = decodeRow(examples[0]);
    }
    const source = options.source ?? example?.page.source_id;
    if (source === undefined) throw new RunnerError('SOURCE_REQUIRED');
    let selected: LoadedPage[];
    if (options.all) {
      const rows = await tx<SnapshotRow[]>`
        SELECT to_jsonb(p)::text AS snapshot FROM pages p
        WHERE p.source_id = ${source} AND p.deleted_at IS NULL
        ORDER BY p.id
      `;
      selected = rows.map(decodeRow);
      if (selected.length === 0) throw new RunnerError('SOURCE_EMPTY');
    } else {
      if (example === undefined) throw new RunnerError('EXAMPLE_SLUG_REQUIRED');
      const additional = await tx<SnapshotRow[]>`
        SELECT to_jsonb(p)::text AS snapshot FROM pages p
        WHERE p.source_id = ${source} AND p.deleted_at IS NULL AND p.id <> ${example.page.id}
          AND (p.source_id ~* '^tana(-|$)' OR lower(p.frontmatter->>'source_system') = 'tana')
          AND (
            strpos(p.title, chr(10)) > 0 OR strpos(p.title, chr(13)) > 0
            OR strpos(p.title, chr(92) || 'n') > 0 OR strpos(p.title, chr(92) || 'r') > 0
            OR p.title ~* ${HTML_PATTERN} OR p.compiled_truth ~* ${HTML_PATTERN}
            OR p.compiled_truth ~ ${JSON_PATTERN}
          )
        ORDER BY p.id LIMIT ${options.limit}
      `;
      selected = [example, ...additional.map(decodeRow)];
    }
    if (selected.some((row) => !/^tana(?:-|$)/i.test(row.page.source_id) && row.sourceSystem?.toLowerCase() !== 'tana')) {
      throw new RunnerError('SOURCE_NOT_TANA');
    }
    const verifiedSourceRecords = historical === undefined ? 0 : verifyHistoricalSource(historical, selected);
    const resolution = historical === undefined
      ? await resolveNodes(tx, source, selected.map(({ page }) => page), options.all)
      : { nodes: historical.records, warnings: [], fetched: 0, batches: 0, depth: 0 };
    const ids = selected.map(({ page }) => String(page.id));
    const chunksBefore = await tx<SnapshotRow[]>`
      SELECT to_jsonb(c)::text AS snapshot FROM content_chunks c
      JOIN pages p ON p.id = c.page_id
      WHERE p.source_id = ${source} AND p.id::text IN (
        SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::text::jsonb)
      )
      ORDER BY c.id
    `;
    const counts = {
      selected: selected.length, derived_changes: 0, complete: 0, held: 0,
      already_readable: 0, partial_changes: 0, idempotency_failures: 0,
    };
    const warningCounts = new Map<string, number>();
    const captionCounts = new Map<string, number>();
    const titleCounts = new Map<string, number>();
    const sourceFingerprint = createHash('sha256');
    const samples = selected.map(({ page, snapshot }) => {
      sourceFingerprint.update(snapshot).update('\0');
      Object.freeze(page);
      const projected = projectPage(page, resolution.nodes);
      const second = projectPage({ ...page, title: projected.caption, compiled_truth: projected.display_body }, resolution.nodes);
      const idempotent = second.caption === projected.caption && second.display_body === projected.display_body;
      const changed = page.title !== projected.caption || page.compiled_truth !== projected.display_body;
      const warnings = [...projected.warnings, ...resolution.warnings];
      if (!idempotent) {
        warnings.push('idempotency_failure:1');
        counts.idempotency_failures++;
      }
      for (const warning of warnings) {
        const [code, total] = warning.split(':');
        warningCounts.set(code, (warningCounts.get(code) ?? 0) + Number(total ?? 1));
      }
      const status = warnings.length > 0 || projected.status === 'held' ? 'held' : 'complete';
      counts[status]++;
      if (changed) counts.derived_changes++;
      else counts.already_readable++;
      if (status === 'held' && changed) counts.partial_changes++;
      const titleKey = page.title.trim().toLocaleLowerCase();
      const captionKey = projected.caption.trim().toLocaleLowerCase();
      titleCounts.set(titleKey, (titleCounts.get(titleKey) ?? 0) + 1);
      captionCounts.set(captionKey, (captionCounts.get(captionKey) ?? 0) + 1);
      const isExample = page.id === example?.page.id;
      return {
        example: isExample,
        page_id: page.id,
        source_id: page.source_id,
        slug: isExample ? options.exampleSlug : '[redacted]',
        identity_fingerprint: createHash('sha256').update(JSON.stringify([page.source_id, page.id, page.slug, page.record_id])).digest('hex'),
        status,
        projection_complete: status === 'complete',
        partial_change: status === 'held' && changed,
        derived_change: changed,
        before_reasons: beforeReasons(page),
        reasons: projected.reasons,
        warnings,
        idempotent,
        original: {
          title: redactedPreview(page.title),
          body: redactedPreview(page.compiled_truth),
          fingerprint: textFingerprint(page.title, page.compiled_truth),
        },
        derived: {
          caption: redactedPreview(projected.caption),
          display_body: redactedPreview(projected.display_body),
          fingerprint: textFingerprint(projected.caption, projected.display_body),
        },
      };
    });
    const finalRows = await tx<SnapshotRow[]>`
      SELECT to_jsonb(p)::text AS snapshot FROM pages p
      WHERE p.source_id = ${source} AND p.id::text IN (
        SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::text::jsonb)
      )
      ORDER BY p.id
    `;
    const finalById = new Map(finalRows.map((row) => [decodeRow(row).page.id, row.snapshot]));
    const unchanged = finalRows.length === selected.length
      && selected.every(({ page, snapshot }) => finalById.get(page.id) === snapshot);
    if (!unchanged) throw new RunnerError('SELECTED_SNAPSHOT_CHANGED');
    const chunksAfter = await tx<SnapshotRow[]>`
      SELECT to_jsonb(c)::text AS snapshot FROM content_chunks c
      JOIN pages p ON p.id = c.page_id
      WHERE p.source_id = ${source} AND p.id::text IN (
        SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::text::jsonb)
      )
      ORDER BY c.id
    `;
    if (chunksBefore.length !== chunksAfter.length
      || chunksBefore.some((row, index) => row.snapshot !== chunksAfter[index].snapshot)) {
      throw new RunnerError('SEARCH_INDEX_SNAPSHOT_CHANGED');
    }
    const chunkFingerprint = createHash('sha256');
    for (const row of chunksBefore) chunkFingerprint.update(row.snapshot).update('\0');
    return {
      issue: 'DAV-6220',
      schema_version: 2,
      mode: 'derived-display-dry-run',
      generated_at: new Date().toISOString(),
      private: true,
      privacy: 'Only an explicitly selected example slug is retained. Other slugs and text previews are redacted.',
      source,
      port: 6543,
      transform_hash: hash,
      transform_rules: TRANSFORM_RULES,
      counts,
      warnings: Object.fromEntries([...warningCounts].sort(([a], [b]) => a.localeCompare(b))),
      caption_collisions: {
        original_duplicate_groups: [...titleCounts.values()].filter((count) => count > 1).length,
        derived_duplicate_groups: [...captionCounts.values()].filter((count) => count > 1).length,
        derived_duplicate_pages: [...captionCounts.values()].filter((count) => count > 1).reduce((sum, count) => sum + count, 0),
      },
      selected: {
        total: selected.length, full_corpus: options.all, example: example === undefined ? 0 : 1,
        additional: selected.length - (example === undefined ? 0 : 1),
        additional_limit: options.all ? null : options.limit,
      },
      source_input: {
        provided: historical !== undefined,
        sha256: historical?.sha256 ?? null,
        records: historical?.records.size ?? 0,
        selected_original_hashes_verified: verifiedSourceRecords,
        readwise_marked_excluded: historical?.excludedReadwise ?? 0,
        limitation: historical === undefined
          ? 'Original metadata is unavailable. No later-cache values are substituted; unresolved content remains held.'
          : 'File bytes and original node hashes are pinned. Historical origin remains an operator evidence requirement.',
      },
      idempotency_failures: counts.idempotency_failures,
      statement_categories: ['BEGIN READ ONLY', 'SET LOCAL', 'SHOW', 'SELECT', 'COMMIT READ ONLY'],
      transaction: {
        isolation: isolation[0].transaction_isolation,
        read_only: readOnly[0].transaction_read_only,
        prepare: false,
        max_connections: 1,
        statement_timeout_ms: 30_000,
        pages_mutations: 0,
        selected_rows_unchanged: unchanged,
        selected_rows_sha256: sourceFingerprint.digest('hex'),
        search_chunks: chunksBefore.length,
        search_chunks_unchanged: true,
        search_chunks_sha256: chunkFingerprint.digest('hex'),
        comparison: 'Exact page and chunk snapshots compared in the same repeatable-read snapshot.',
        limitation: 'This runner cannot write; this does not rule out concurrent writes by other sessions.',
      },
      retrieval: {
        status: 'NOT_SCORED',
        reason: 'SEALED_REVIEWED_QUERY_GROUNDTRUTH_PACKET_ABSENT',
        searchable_content_unchanged: true,
        limitation: 'Derived display validation and index preservation do not establish semantic retrieval improvement.',
      },
      resolution: {
        fetched_rows: resolution.fetched,
        indexed_nodes: resolution.nodes.size,
        batches: resolution.batches,
        levels: resolution.depth,
        warnings: resolution.warnings,
        limitation: 'Loader limitations hold all samples. Unknown or excluded references never become invented prose.',
      },
      example: samples.find((sample) => sample.example) ?? null,
      samples,
    };
  });
}

function sanitizedError(error: unknown): string {
  if (error instanceof RunnerError) return error.code;
  if (error instanceof SQL.PostgresError) {
    const state = [error.errno, error.code].find((value) => typeof value === 'string' && /^[A-Z0-9]{5}$/.test(value));
    return state ? `SQLSTATE_${state}` : 'SQL_FAILED';
  }
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    if (['EEXIST', 'EACCES', 'ENOENT', 'ENOTDIR', 'ELOOP', 'ENOSPC'].includes(error.code)) return error.code;
  }
  if (error instanceof Error && [
    'INVALID_SOURCE_HASH', 'INVALID_SOURCE_FILE', 'SOURCE_FILE_CHANGED', 'SOURCE_HASH_MISMATCH',
    'INVALID_SOURCE_JSON', 'INVALID_ORIGINAL_EXPORT', 'INVALID_SOURCE_RECORD', 'DUPLICATE_SOURCE_RECORD',
    'SOURCE_REVISION_MISMATCH', 'INVALID_STORED_SOURCE', 'STORED_SOURCE_HASH_MISMATCH',
  ].includes(error.message)) return error.message;
  return 'RUN_FAILED';
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options === null) {
    console.log(HELP);
    return;
  }
  const url = databaseUrl();
  const target = await receiptPath(options.receipt);
  const hash = await transformHash();
  const historical = options.sourceRecords && options.sourceRecordsSha256 && options.source
    ? await loadHistoricalSource(options.sourceRecords, options.sourceRecordsSha256, options.source)
    : undefined;
  const sql = new SQL(url.toString(), { max: 1, prepare: false });
  const receipt = await collectReceipt(sql, options, hash, historical).finally(() => sql.close());
  if (await realpath(dirname(target)) !== dirname(target)) throw new RunnerError('UNSAFE_RECEIPT_PATH');
  const file = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await file.chmod(0o600);
    await file.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
  console.log(JSON.stringify({ receipt: relative(REPO_ROOT, target), counts: receipt.counts }));
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(sanitizedError(error));
    process.exitCode = 1;
  });
}
