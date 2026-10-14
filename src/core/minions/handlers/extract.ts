/**
 * `extract` and stale-only import recovery (registered by registerBuiltinHandlers).
 */
import type { BrainEngine } from '../../engine.ts';
import type { MinionHandler } from '../types.ts';
import { MinionQueue } from '../queue.ts';
import { IMPORT_STALE_EXTRACT_JOB } from '../../deferred-stale-extract.ts';

export function makeExtractHandler(engine: BrainEngine): MinionHandler {
  return async (job) => {
    const { runExtractCore, extractStaleFromDB, STALE_TIME_BUDGET_MS } = await import('../../../commands/extract.ts');
    // #2849: stale mode — the durable follow-up for extraction deferred by
    // performSync's size gate (totalChanges > 100). Runs the same DB-source
    // watermark sweep as `gbrain extract --stale`, scoped to the source the
    // sync that deferred it was scoped to (job.data.sourceId; absent =
    // unscoped, matching what the CLI hint tells a default-brain operator
    // to run). The sweep is checkout-less + idempotent, so retries and
    // overlapping submissions converge.
    if (job.data.stale === true || job.name === IMPORT_STALE_EXTRACT_JOB) {
      const sourceIdFilter = typeof job.data.sourceId === 'string' ? job.data.sourceId : undefined;
      if (sourceIdFilter === 'dream' && job.data.reason === 'daily_memory_write') {
        const { extractOneShotDailyMemory } = await import('../../cycle/daily-memory-extract.ts');
        await extractOneShotDailyMemory(engine, { written: false, needs_extract: true }, { signal: job.signal });
        return { stale: true, source_id: sourceIdFilter, generated_daily_indexes_only: true };
      }
      const r = await extractStaleFromDB(engine, {
        dryRun: !!job.data.dryRun,
        jsonMode: false,
        sourceIdFilter,
        catchUp: false,
        signal: job.signal,
      });
      // Internal 30-min budget hit with work remaining → chain a
      // continuation job so a very large deferred backlog converges without
      // waiting for the next sync. Forward-progress guard (pagesProcessed >
      // 0) prevents an infinite chain if the sweep can't advance.
      if (!job.data.dryRun && r.staleRemaining > 0 && (r.pagesProcessed > 0 || (r.mentions?.pages ?? 0) > 0)) {
        {
          const queue = new MinionQueue(engine);
          // NO maxWaiting: with an unscoped (NULL-sourceId) payload the
          // coalesce filter matches ANY waiting 'extract' job and would
          // swallow the continuation. Each completed sweep chains at most
          // one continuation and the sweep is an idempotent watermark scan,
          // so there is no pile-up to guard against.
          await queue.add(
            job.name === IMPORT_STALE_EXTRACT_JOB ? IMPORT_STALE_EXTRACT_JOB : 'extract',
            { ...job.data, stale: true, continuation_of: job.id },
            { timeout_ms: STALE_TIME_BUDGET_MS + 5 * 60 * 1000 },
          );
        }
      }
      return { stale: true, source_id: sourceIdFilter ?? null, ...r };
    }
    const mode = (typeof job.data.mode === 'string' && ['links', 'timeline', 'all'].includes(job.data.mode))
      ? (job.data.mode as 'links' | 'timeline' | 'all')
      : 'all';
    const dir = typeof job.data.dir === 'string'
      ? job.data.dir
      : (await engine.getConfig('sync.repo_path')) ?? '.';
    // #3957: thread the job's source id into the fs-walk extractors. Without
    // it the batch rows default to source_id='default' and the pages JOIN
    // drops every row on a non-'default' brain (silent "created 0"), and the
    // full-walk watermark stamp targets the wrong source.
    const sourceId = typeof job.data.sourceId === 'string' ? job.data.sourceId : undefined;
    const result = await runExtractCore(engine, { mode, dir, dryRun: !!job.data.dryRun, sourceId });
    // #5904: refused timeline writes fail the job instead of completing over rows that were never written.
    if (result.timeline_refused) throw new Error(`extract: ${result.timeline_refused} timeline write(s) refused; nothing written for them. Run gbrain extract --stale.`);
    return result;
  };
}
