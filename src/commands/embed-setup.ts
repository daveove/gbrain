import type { BrainEngine } from '../core/engine.ts';
import type { ResolvedColumn } from '../core/types.ts';
import { readProjectionSnapshot, type ProjectionSnapshot } from '../core/page-state/projections.ts';
import type { EmbedOpts, EmbedResult } from './embed.ts';
import { resolveRegisteredEmbeddingColumnFromEngine, getEmbeddingProvenanceColumns, quoteIdentifier,
  embeddingColumnSignature, independentPageProofContextSql } from '../core/search/embedding-column.ts';
import { assertIndependentColumnInitialized } from '../core/embedding-column-schema.ts';
import { wrapChunkTextsForStoredMode } from '../core/embedding-context.ts';
import { assertEmbeddingEnabled } from '../core/embedding-dim-check.ts';
import { loadConfig } from '../core/config.ts';
import { validateEmbeddingCreds } from '../core/embed-preflight.ts';
import { prepareEmbeddingProjections, countArchivedEmbeddingWork, reportBlockedProjections, listPendingProjectionPages } from '../core/embedding-readiness.ts';
import { probeEmbedder } from '../core/embed-stale.ts';
import { embedBatchWithBackoff, type EmbedBatchWithBackoffOpts } from '../core/embed-retry.ts';
import { isAborted } from '../core/abort-check.ts';
import { EMBED_SKIP_FILTER_FRAGMENT } from '../core/embed-skip.ts';
import { QUARANTINE_FILTER_FRAGMENT } from '../core/quarantine.ts';
import { currentTextProjectionFilter } from '../core/search/safe-chunks.ts';

/** A staging target that is unregistered, not independent or not initialized; nothing ran. */
export class EmbeddingStagingTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingStagingTargetError';
  }
}

export const STAGING_UNSEALED_MESSAGE = 'The page text projection is not sealed, so nothing was staged: staging never rebuilds chunks or drops existing vectors. Seal it through the normal sync or embed path, then rerun the staging command.';
export const STAGING_NO_CHUNKS_MESSAGE = 'The page has no chunks, so nothing was staged: staging never chunks pages. Chunk it through the normal sync or embed path, then rerun the staging command.';
export const STAGING_TARGET_CHANGED_MESSAGE = 'The staging column registration changed during this run, so nothing was installed for this page. Inspect gbrain config get embedding_columns, then rerun the staging command.';

/**
 * Resolve `--embedding-column <name>` from the brain's own DB-plane registry
 * (never the file plane or a caller-built descriptor). Only an initialized
 * independent column qualifies: a built-in or shared-provenance column would
 * overwrite or relabel the live space.
 */
export async function resolveEmbeddingStagingTarget(engine: BrainEngine, name: string): Promise<ResolvedColumn> {
  const column = await resolveRegisteredEmbeddingColumnFromEngine(engine, name);
  if (!column.provenance) {
    throw new EmbeddingStagingTargetError(`Embedding column "${name}" is not an independent model space, so nothing was embedded: --embedding-column only stages columns registered with provenance "independent". `
      + 'Plain gbrain embed already writes the live column.');
  }
  await assertIndependentColumnInitialized(engine, column);
  return column;
}

/** The guarded snapshot still names the run's target, model, width and document prefix. */
export function sameStagingTarget(prepared: ProjectionSnapshot, target: ResolvedColumn): boolean {
  const column = prepared.embeddingColumn;
  return column.name === target.name && column.embeddingModel === target.embeddingModel && column.dimensions === target.dimensions
    && (column.documentPrefix ?? '') === (target.documentPrefix ?? '') && prepared.embeddingModel === target.embeddingModel;
}

/**
 * Provider inputs under the page's stored wrapping. A staging target's
 * document prefix comes from the guarded snapshot, the same descriptor its
 * installation records in the input proof.
 */
export function documentInputs(prepared: ProjectionSnapshot, chunks: ReadonlyArray<{ chunk_text: string; chunk_source?: string | null }>,
  target: ResolvedColumn | undefined): string[] {
  const texts = wrapChunkTextsForStoredMode(prepared.snapshot.page, chunks);
  const prefix = target ? prepared.embeddingColumn.documentPrefix : undefined;
  return prefix ? texts.map(text => prefix + text) : texts;
}

/** A staging target's provider call names its own model and width; otherwise the configured model serves. */
export function embedCallOpts(prepared: ProjectionSnapshot, target: ResolvedColumn | undefined, signal: AbortSignal | undefined): EmbedBatchWithBackoffOpts {
  return {
    ...(signal && { abortSignal: signal }),
    ...(target && { embeddingModel: prepared.embeddingColumn.embeddingModel, dimensions: prepared.embeddingColumn.dimensions }),
  };
}

/** Preview units are chunks: use the live guarded input-proof classification before calling them restamps. */
export async function countIndependentRestampOnlyChunks(engine: BrainEngine, target: ResolvedColumn, sourceId?: string): Promise<number> {
  const proof = getEmbeddingProvenanceColumns(target);
  const signature = embeddingColumnSignature(target);
  const query = `SELECT p.id,p.slug,p.source_id FROM pages p JOIN sources s ON s.id=p.source_id
    WHERE p.id>$1 AND p.deleted_at IS NULL AND NOT s.archived
      AND ${currentTextProjectionFilter('p')} AND ${EMBED_SKIP_FILTER_FRAGMENT} AND ${QUARANTINE_FILTER_FRAGMENT}
      AND ($3::text IS NULL OR p.source_id=$3)
      AND p.${quoteIdentifier(proof.pageSignature)} IS DISTINCT FROM $2::text || ':' || ${independentPageProofContextSql('p', 's')}
      AND EXISTS(SELECT 1 FROM content_chunks cc WHERE cc.page_id=p.id AND cc.modality='text'
        AND cc.${quoteIdentifier(target.name)} IS NOT NULL)
    ORDER BY p.id LIMIT 100`;
  let afterPageId = 0;
  let count = 0;
  while (true) {
    const pages = await engine.executeRaw<{ id: number; slug: string; source_id: string }>(query, [afterPageId, signature, sourceId ?? null]);
    for (const page of pages) {
      const prepared = await readProjectionSnapshot(engine, page.slug, page.source_id, { requireLiveSource: true, embeddingColumn: target });
      if (!prepared || !sameStagingTarget(prepared, target)) continue;
      for (const chunk of prepared.chunks) {
        if (chunk.modality === 'text' && chunk.embedding_is_null === false) count++;
      }
    }
    if (pages.length < 100) return count;
    afterPageId = pages[pages.length - 1]!.id;
  }
}


/**
 * #6223 for a staging run: one failure sample naming the first unsealed pages
 * and the keys (`source_id::slug`) of those listed, so the guarded drain counts
 * their chunks without renaming them as pages that changed mid-run. Unlike the
 * live drain it never offers projection repair, which may drop live vectors.
 */
async function reportUnsealedForStaging(engine: BrainEngine, scope: { sourceId?: string; existingChunksOnly?: boolean; activeSourcesOnly?: boolean },
  blocked: number, samples: string[]): Promise<Set<string>> {
  const pages = await listPendingProjectionPages(engine, scope);
  const named = pages.slice(0, 5);
  const more = blocked > named.length ? ` and ${blocked - named.length} more` : '';
  samples.push(`${blocked} page(s) have an unsealed text projection, so nothing was staged for them (${named.map(page => `${page.source_id}:${page.slug}`).join(', ')}${more}); `
    + 'staging never rebuilds projections or drops existing vectors. Seal them through the normal sync or embed path, then rerun this staging command.');
  return new Set(pages.map(page => `${page.source_id}::${page.slug}`));
}

/**
 * Tagged error class thrown when the schema column dim disagrees with
 * the gateway's resolved dim. Caught by `runEmbed` (the CLI wrapper) to
 * emit a paste-ready recipe instead of raw Postgres errors page by page.
 *
 * v0.37 fix wave (Lane D.2 + CDX2-9). Pre-fix the worker pool ran the
 * whole queue past the first dim mismatch because per-page errors were
 * silently logged + skipped. Now `runEmbedCore` pre-flights at entry +
 * the worker pool catches per-page mismatches and surfaces them.
 */
export class EmbeddingDimMismatchError extends Error {
  readonly kind = 'embedding_dim_mismatch' as const;
  constructor(public readonly recipeMessage: string) {
    super(recipeMessage);
    this.name = 'EmbeddingDimMismatchError';
  }
}

/**
 * Pre-flight check: read the actual schema column dim and compare to the
 * gateway's resolved dim. Throws `EmbeddingDimMismatchError` on mismatch
 * so the entry-point catch surfaces the recipe. Catches the headline
 * fresh-install bug class at the very first invocation instead of letting
 * the worker pool hammer N pages with raw 22000 errors.
 */
async function preflightDimMismatch(engine: BrainEngine, dryRun: boolean): Promise<void> {
  if (dryRun) return; // dry-run never embeds, no risk
  const { readContentChunksEmbeddingDim, embeddingMismatchMessage } = await import('../core/embedding-dim-check.ts');
  const { getEmbeddingDimensions, getEmbeddingModel } = await import('../core/ai/gateway.ts');
  let existing;
  try {
    existing = await readContentChunksEmbeddingDim(engine);
  } catch {
    return; // probe failure shouldn't block embed; the worker pool will surface real errors
  }
  if (!existing.exists || existing.dims === null) return;
  let resolvedDims: number;
  let resolvedModel: string;
  try {
    resolvedDims = getEmbeddingDimensions();
    resolvedModel = getEmbeddingModel();
  } catch {
    return; // gateway unconfigured — worker pool will error informatively
  }
  if (existing.dims === resolvedDims) return;
  const savedConfig = '_savedConfig' in engine ? engine._savedConfig : undefined;
  const databasePath = savedConfig && typeof savedConfig === 'object' && 'database_path' in savedConfig
    && typeof savedConfig.database_path === 'string' ? savedConfig.database_path : undefined;
  const recipe = embeddingMismatchMessage({
    currentDims: existing.dims,
    requestedDims: resolvedDims,
    requestedModel: resolvedModel,
    source: 'embed',
    engineKind: engine.kind,
    databasePath,
  });
  throw new EmbeddingDimMismatchError(recipe);
}

export async function preflightEmbeddingRun(engine: BrainEngine, opts: EmbedOpts): Promise<ResolvedColumn | undefined> {
  if (!opts.dryRun) assertEmbeddingEnabled(loadConfig());
  // Resolve in previews too: an absent or incompatible space cannot produce a valid plan.
  const target = opts.embeddingColumn !== undefined ? await resolveEmbeddingStagingTarget(engine, opts.embeddingColumn) : undefined;
  if (!opts.dryRun) validateEmbeddingCreds(target?.embeddingModel);
  if (!target) await preflightDimMismatch(engine, !!opts.dryRun);
  return target;
}

export function archivedEmbeddingReporter(engine: BrainEngine, dryRun: boolean, result: EmbedResult, sourceId: string | undefined,
  signature: string | undefined, includeNullSignature: boolean, target?: ResolvedColumn): () => Promise<void> {
  let reported = 0;
  return async () => {
    if (dryRun) return;
    const blocked = target ? await countArchivedEmbeddingWork(engine, { sourceId }, target)
      : await countArchivedEmbeddingWork(engine, { sourceId, signature, includeNullSignature });
    if (blocked <= reported) return;
    result.failures += blocked - reported;
    reported = blocked;
    result.failure_samples.push(`${blocked} archived page(s) have blocked embedding work; active pages can progress, but this run is incomplete. Use gbrain sources restore <id> deliberately before retrying archived work.`);
  };
}

export async function prepareStaleDrainProjections(engine: BrainEngine, options: NonNullable<Parameters<typeof prepareEmbeddingProjections>[1]>,
  dryRun: boolean, result: EmbedResult, noteBudgetStop: () => Promise<void>, signature: string | undefined,
  target: ResolvedColumn | undefined, assertOwned?: (tx?: BrainEngine) => Promise<void>): Promise<Set<string> | null> {
  let readiness = await prepareEmbeddingProjections(engine, options);
  if (isAborted(options.signal) || Date.now() >= (options.deadline ?? Infinity)) { await noteBudgetStop(); return null; }
  if (target) {
    // Independent staging reports unavailable projections without changing the live space.
    if (readiness.blocked && !dryRun) {
      result.failures += readiness.blocked;
      return reportUnsealedForStaging(engine, options, readiness.blocked, result.failure_samples);
    }
  } else if (readiness.blocked && !dryRun) {
    const probeOk = await probeEmbedder((texts, fnOpts) => embedBatchWithBackoff(texts, { abortSignal: fnOpts.abortSignal }), signature, options.signal);
    if (isAborted(options.signal) || Date.now() >= (options.deadline ?? Infinity)) { await noteBudgetStop(); return null; }
    if (!probeOk) {
      result.failures += readiness.blocked;
      result.failure_samples.push('Projection recovery requires a working embedding provider; existing projections were preserved.');
      return null;
    }
    readiness = await prepareEmbeddingProjections(engine, { ...options, repair: true, assertOwned });
    if (isAborted(options.signal) || Date.now() >= (options.deadline ?? Infinity)) { await noteBudgetStop(); return null; }
    if (readiness.blocked) return reportBlockedProjections(engine, options, readiness.blocked, result.failure_samples);
  }
  return new Set();
}

/** argv with `--embedding-column <name>` taken out, and the column it named. */
export interface EmbeddingColumnArg {
  embeddingColumn?: string;
  rest: string[];
}

/**
 * Split `--embedding-column <name>` out of argv so its value is never read as
 * a slug, and refuse flags a staging run cannot honor. Throws
 * EmbeddingStagingTargetError on a missing value, a repeat or a clash.
 */
export function parseEmbeddingColumnArg(args: string[]): EmbeddingColumnArg {
  const at = args.indexOf('--embedding-column');
  if (at < 0) return { rest: args };
  const name = args[at + 1];
  if (name === undefined || name.startsWith('--')) {
    throw new EmbeddingStagingTargetError('--embedding-column needs the name of a registered independent column, e.g. gbrain embed --stale --embedding-column <name> --dry-run.');
  }
  const rest = [...args.slice(0, at), ...args.slice(at + 2)];
  if (rest.includes('--embedding-column')) throw new EmbeddingStagingTargetError('Pass --embedding-column once: a staging run writes exactly one column.');
  const clash = ['--facts', '--images', '--include-null-signature'].find(flag => rest.includes(flag));
  if (clash) {
    throw new EmbeddingStagingTargetError(`${clash} cannot be combined with --embedding-column: staging embeds page chunks into one independent column, `
      + 'and that column never grandfathers missing provenance.');
  }
  return { embeddingColumn: name, rest };
}
