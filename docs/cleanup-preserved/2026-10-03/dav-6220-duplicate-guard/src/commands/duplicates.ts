import { readFileSync } from 'fs';
import type { BrainEngine } from '../core/engine.ts';
import type { DuplicateAuditHandoff, DuplicateEvidencePage } from '../core/duplicate-evidence.ts';
import { buildDuplicateEvidenceManifest, buildDuplicateEvidenceManifestAsync, validateDuplicateAuditHandoffAsync } from '../core/duplicate-evidence.ts';
import { ALL_SOURCES, resolveSourceIdEngineFree } from '../core/source-resolver.ts';

const PAGE_SIZE = 1_000;
const MAX_INPUT_BYTES = 512 * 1024 * 1024;
const MAX_INPUT_PAGES = 500_000;

export async function runDuplicatesWithSignals(engine: BrainEngine, args: string[]): Promise<void> {
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('Duplicate evidence cancelled'));
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  try { await runDuplicates(engine, args, controller.signal); }
  finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
}

export async function loadLivePages(engine: BrainEngine, sourceId?: string, signal?: AbortSignal): Promise<DuplicateEvidencePage[]> {
  return engine.transaction(async (tx) => {
    await tx.executeRaw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    if (sourceId) {
      const sources = await tx.executeRaw('SELECT id FROM sources WHERE id = $1', [sourceId], { signal });
      if (!sources.length) throw new Error(`Unknown source: ${sourceId}`);
    }
    const pages: DuplicateEvidencePage[] = [];
    let lastId = 0;
    let inputBytes = 0;
    for (;;) {
      signal?.throwIfAborted();
      const batch = await tx.executeRaw<DuplicateEvidencePage>(
        `SELECT id, source_id, slug, title, content_hash, compiled_truth, effective_date,
         jsonb_build_object('source_kind', source_kind, 'source_uri', source_uri, 'ingested_via', ingested_via, 'frontmatter', frontmatter) AS provenance
         FROM pages WHERE deleted_at IS NULL AND id > $1 ${sourceId ? 'AND source_id = $3' : ''} ORDER BY id LIMIT $2`,
        sourceId ? [lastId, PAGE_SIZE, sourceId] : [lastId, PAGE_SIZE], { signal },
      );
      signal?.throwIfAborted();
      for (const page of batch) inputBytes += Buffer.byteLength(JSON.stringify(page), 'utf8');
      if (inputBytes > MAX_INPUT_BYTES || pages.length + batch.length > MAX_INPUT_PAGES) throw new Error('Duplicate scan resource limit exceeded (512 MiB or 500000 pages); no complete manifest produced. Narrow the source scope.');
      pages.push(...batch);
      if (batch.length < PAGE_SIZE) break;
      lastId = batch[batch.length - 1].id;
    }
    const counts = await tx.executeRaw<{ source_id: string; count: string | number }>(`SELECT source_id, count(*) AS count FROM pages WHERE deleted_at IS NULL ${sourceId ? 'AND source_id = $1' : ''} GROUP BY source_id`, sourceId ? [sourceId] : [], { signal });
    const observed = new Map<string,number>();
    for (const page of pages) observed.set(page.source_id,(observed.get(page.source_id) ?? 0)+1);
    if (counts.length !== observed.size || counts.some((row) => observed.get(row.source_id) !== Number(row.count)) || new Set(pages.map((page) => page.id)).size !== pages.length) throw new Error('Snapshot per-source count reconciliation failed');
    return pages;
  });
}

function renderSummary(manifest: ReturnType<typeof buildDuplicateEvidenceManifest>): string {
  const rows = manifest.clusters.reduce((total, cluster) => total + cluster.pages.length, 0);
  return [
    `Scanned ${manifest.pages_scanned} active page(s).`,
    `Found ${manifest.clusters.length} duplicate cluster(s) covering ${rows} page(s).`,
    `Skipped similarity groups: ${manifest.skipped_similarity_groups.length}. Display recommendations do not establish safe disposal.`,
    `Input snapshot: ${manifest.input_snapshot_hash}`,
    `Manifest: ${manifest.manifest_hash}`,
  ].join('\n');
}

export async function runDuplicates(engine: BrainEngine, args: string[], signal?: AbortSignal): Promise<void> {
  const subcommand = args[0]?.startsWith('--') ? 'evidence' : args[0] ?? 'evidence';
  const rest = args[0]?.startsWith('--') ? args : args.slice(1);
  let json = false;
  let explicitSource: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--json') json = true;
    else if (arg === '--source' || arg.startsWith('--source=')) {
      explicitSource = arg === '--source' ? rest[++i] : arg.slice(9);
      if (!explicitSource || explicitSource.startsWith('--')) throw new Error('--source requires an ID');
    } else if (arg.startsWith('--')) throw new Error(`Unknown duplicates flag: ${arg}`);
    else positional.push(arg);
  }
  const resolvedSource = resolveSourceIdEngineFree(explicitSource);
  const sourceId = !resolvedSource || resolvedSource === ALL_SOURCES ? undefined : resolvedSource;
  if (subcommand === 'evidence') {
    if (positional.length) throw new Error('evidence takes no positional arguments');
    const manifest = await buildDuplicateEvidenceManifestAsync(await loadLivePages(engine, sourceId, signal), signal);
    console.log(json ? JSON.stringify(manifest, null, 2) : renderSummary(manifest));
    return;
  }
  if (subcommand === 'verify-audit') {
    const path = positional[0];
    if (!path || positional.length !== 1) throw new Error('Usage: gbrain duplicates verify-audit <audit.json> [--source ID] [--json]');
    let handoff: DuplicateAuditHandoff;
    try {
      handoff = JSON.parse(readFileSync(path, 'utf8')) as DuplicateAuditHandoff;
    } catch (error) {
      throw new Error(`Could not read audit manifest "${path}": ${(error as Error).message}`);
    }
    const result = await validateDuplicateAuditHandoffAsync(handoff, await loadLivePages(engine, sourceId, signal), signal);
    if (json) console.log(JSON.stringify(result, null, 2));
    else console.log(result.ok ? 'Audit handoff is internally consistent. Approval is self-asserted and unverified; no mutation is authorized.' : `Audit handoff rejected:\n- ${result.errors.join('\n- ')}`);
    if (!result.ok) throw new Error('Audit handoff rejected');
    return;
  }
  throw new Error('Usage: gbrain duplicates <evidence|verify-audit> [...]');
}
