#!/usr/bin/env bun
/**
 * Run queued `facts-absorb` jobs under a hard spend cap, then exit.
 *
 * Usage: bun scripts/run-facts-absorb.ts --max-usd N [--concurrency C] [--max-minutes M]
 *
 * Only `facts-absorb` is registered, so no other job kind is claimed. The cap
 * is enforced at each claim, not by failing a call: the facts pipeline turns
 * a refused model call into an empty completed job, which would lose that
 * page's facts. Before a claimed job runs, its own model is priced at the
 * worst case; if spend plus every in-flight job's worst case plus this one
 * would pass the cap, the job goes back to the queue without using an
 * attempt and the run stops.
 */
import { loadConfig, toEngineConfig } from '../src/core/config.ts';
import { createEngine } from '../src/core/engine-factory.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { RateLeaseUnavailableError } from '../src/core/minions/rate-leases.ts';
import type { MinionHandler } from '../src/core/minions/types.ts';
import { refreshGatewayForJob, registerBuiltinHandlers } from '../src/commands/jobs.ts';
import { BudgetTracker, loadPricingOverrides, type PricingOverrides } from '../src/core/budget/budget-tracker.ts';
import { reservationCostUsd } from '../src/core/budget/reservation-cost.ts';
import { managedPersistenceEnabled } from '../src/core/persistence/ownership.ts';
import { resolveManagedFactsEmbedding } from '../src/core/persistence/facts-maintenance.ts';
import { configureGateway, getEmbeddingModel, isAvailable, withBudgetTracker } from '../src/core/ai/gateway.ts';
import { buildGatewayConfig } from '../src/core/ai/build-gateway-config.ts';
import { modelApiAllowed } from '../src/core/ai/billing-policy.ts';
import { assertCodexChatGptLogin } from '../src/core/ai/providers/codex-cli-language-model.ts';
import {
  MAX_TURN_TEXT_CHARS,
  buildExtractorSystem,
  getFactsExtractionMaxTokens,
  getFactsExtractionModel,
  getFactsExtractionPromptAppendix,
  type ExtractFailureReason,
} from '../src/core/facts/extract.ts';

export interface FactsAbsorbRun {
  stopped: 'queue_empty' | 'budget' | 'time' | 'unpriced' | 'unavailable' | 'signal' | 'failing';
  completed: number;
  failed: number;
  spentUsd: number;
  worstCaseJobUsd: number | null;
  /** Jobs still queued: waiting plus delayed retries. */
  remaining: number;
}

/**
 * Worst case of one claim, which is one attempt: the first extractor call plus
 * a truncation retry and a malformed-output retry at twice the output cap.
 * Input is bounded in bytes, a true ceiling because a BPE token covers at
 * least one byte: the system prompt and operator appendix, 4 bytes for each
 * of the 8,000 turn characters, and 200 tokens of message framing. Fact
 * embeddings are bounded the same way: at most 25 facts of at most 500
 * characters each, 4 bytes per character. Everything is
 * read fresh so a model or config change mid-run is priced as the handler
 * will see it. The pricer returns null for an unpriced model.
 */
export async function factsJobWorstCase(engine: BrainEngine, overrides?: PricingOverrides): Promise<{
  defaultModel: string;
  /** Embedding share of the worst case (null when unpriced). */
  embedUsd: number | null;
  usd: (model: string) => number | null;
}> {
  const maxTokens = await getFactsExtractionMaxTokens(engine);
  const appendix = await getFactsExtractionPromptAppendix(engine);
  const systemBytes = Math.max(
    Buffer.byteLength(buildExtractorSystem(true)), Buffer.byteLength(buildExtractorSystem(false)),
  ) + Buffer.byteLength(appendix ?? '') + 2;
  const inputPerCall = systemBytes + 4 * MAX_TURN_TEXT_CHARS + 200;
  const outputTokens = maxTokens + 2 * (2 * maxTokens);
  // Price the model extraction embeds with: the gateway's, or under managed
  // persistence the brain's own policy (which may disable embedding). A model
  // that cannot be resolved counts as unpriced. A model ai_billing=subscription
  // refuses makes no request (facts land with a NULL vector for the stale
  // backfill), so it costs nothing.
  let embed: number | null;
  try {
    const model = await managedPersistenceEnabled(engine)
      ? (await resolveManagedFactsEmbedding(engine, loadConfig() ?? { engine: engine.kind }))?.model ?? null
      : getEmbeddingModel();
    embed = model && modelApiAllowed(model) ? reservationCostUsd(model, 'embed', 25 * 4 * 500, 0, overrides) : 0;
  } catch {
    embed = null;
  }
  return {
    defaultModel: await getFactsExtractionModel(engine),
    embedUsd: embed,
    usd: model => {
      const chat = reservationCostUsd(model, 'chat', 3 * inputPerCall, outputTokens, overrides);
      return chat === null || embed === null ? null : chat + embed;
    },
  };
}

async function countJobs(engine: BrainEngine, status: string, since?: Date): Promise<number> {
  const rows = await engine.executeRaw<{ n: number | string }>(
    `SELECT count(*) AS n FROM minion_jobs WHERE name='facts-absorb' AND queue='default' AND status=$1
       AND ($2::timestamptz IS NULL OR finished_at >= $2::timestamptz)`,
    [status, since?.toISOString() ?? null]);
  return Number(rows[0]?.n ?? 0);
}

/** Waiting and active jobs, plus delayed retries that come due before `dueBy`. */
async function countClaimableBy(engine: BrainEngine, dueBy: Date): Promise<number> {
  const rows = await engine.executeRaw<{ n: number | string }>(
    `SELECT count(*) AS n FROM minion_jobs WHERE name='facts-absorb' AND queue='default'
       AND (status IN ('waiting', 'active') OR (status='delayed' AND delay_until <= $1::timestamptz))`,
    [dueBy.toISOString()]);
  return Number(rows[0]?.n ?? 0);
}

/**
 * Bad and good outcomes since `since`. Bad: attempts now retrying or failed,
 * plus completions whose extraction failed (the pipeline completes those
 * with no facts, e.g. a model that keeps returning malformed output). Good:
 * every other completion, including deterministic skips like a missing page.
 */
async function countOutcomes(engine: BrainEngine, since: Date): Promise<{ bad: number; good: number }> {
  const [row] = await engine.executeRaw<{ bad: number | string; good: number | string }>(
    `SELECT count(*) FILTER (WHERE status IN ('delayed', 'failed', 'dead')
                              OR (status='completed' AND result->>'skipped_reason' = ANY($2::text[]))) AS bad,
            count(*) FILTER (WHERE status='completed'
                              AND (result->>'skipped_reason' IS NULL OR NOT result->>'skipped_reason' = ANY($2::text[]))) AS good
       FROM minion_jobs WHERE name='facts-absorb' AND queue='default' AND updated_at >= $1::timestamptz`,
    [since.toISOString(), EXTRACTION_FAILURES]);
  return { bad: Number(row?.bad ?? 0), good: Number(row?.good ?? 0) };
}

const EXTRACTION_FAILURES = [
  'chat_unavailable', 'provider_error', 'refusal', 'content_filter', 'non_terminal_stop', 'malformed_output', 'truncated_output',
] satisfies ExtractFailureReason[];

/** Chat spend recorded for facts-absorb jobs since `since`, from chat_usage_log. */
async function loggedFactsUsd(engine: BrainEngine, since: Date): Promise<number> {
  const rows = await engine.executeRaw<{ usd: number | string | null }>(
    `SELECT COALESCE(sum(cost_usd), 0) AS usd FROM chat_usage_log
      WHERE phase='job:facts-absorb' AND created_at >= $1::timestamptz`, [since.toISOString()]);
  return Number(rows[0]?.usd ?? 0);
}

export async function runFactsAbsorb(engine: BrainEngine, opts: {
  maxUsd: number;
  concurrency?: number;
  maxMinutes?: number;
  pollMs?: number;
  signal?: AbortSignal;
}): Promise<FactsAbsorbRun> {
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 1));
  const startedAt = new Date();
  const deadline = Date.now() + (opts.maxMinutes ?? 60) * 60_000;
  const pricingOverrides = await loadPricingOverrides(engine);
  const pricing = await factsJobWorstCase(engine, pricingOverrides);
  const worstCaseJobUsd = pricing.usd(pricing.defaultModel);
  const result = async (stopped: FactsAbsorbRun['stopped'], spentUsd: number): Promise<FactsAbsorbRun> => ({
    stopped,
    completed: await countJobs(engine, 'completed', startedAt),
    failed: await countJobs(engine, 'failed', startedAt) + await countJobs(engine, 'dead', startedAt),
    spentUsd,
    worstCaseJobUsd,
    remaining: await countJobs(engine, 'waiting') + await countJobs(engine, 'delayed'),
  });
  if (opts.signal?.aborted) return result('signal', 0);

  const tracker = new BudgetTracker({ label: 'facts:run-facts-absorb', maxCostUsd: opts.maxUsd, pricingOverrides });
  const builtins = new MinionWorker(engine);
  await registerBuiltinHandlers(builtins, engine, { quiet: true });
  const handler = builtins.getHandler('facts-absorb');
  if (!handler) throw new Error('facts-absorb handler is not registered');
  const worker = new MinionWorker(engine, {
    queue: 'default', concurrency, pollInterval: 1_000, healthCheckInterval: 0,
  });

  let stopped: FactsAbsorbRun['stopped'] | null = null;
  const stop = (why: FactsAbsorbRun['stopped']) => { if (!stopped) { stopped = why; worker.stop(); } };
  opts.signal?.addEventListener('abort', () => stop('signal'), { once: true });
  // The tracker and chat_usage_log price the same calls slightly differently
  // (about 4% apart on production); spend is whichever is higher.
  let loggedUsd = 0;
  // Embeddings are missing from chat_usage_log and the tracker prices them by a
  // characters-per-token guess, so each finished job keeps its embedding ceiling
  // as spent. This overstates spend slightly; it can never understate it.
  let embedCeilingUsd = 0;
  const spent = () => Math.max(tracker.snapshot().cumulativeCostUsd, loggedUsd) + embedCeilingUsd;
  // Worst case of every job now running, released when the job ends; its real
  // spend is in the tracker by then.
  let inFlightUsd = 0;
  const gated: MinionHandler = async job => {
    // Recorded before admission: a rejected claim's requeue is an outcome write too.
    started.push(job.id);
    // Model and config are fresh per claim, as the handler re-resolves them per
    // job. Overrides stay the startup map the tracker debits with; a change
    // takes effect on the next run.
    // The handler refreshes provider config before it runs; price and check the same state it will see.
    await refreshGatewayForJob(engine);
    const now = await factsJobWorstCase(engine, pricingOverrides);
    const model = typeof job.data.model === 'string' && job.data.model ? job.data.model : now.defaultModel;
    const cost = now.usd(model);
    // A codex-cli model needs a live ChatGPT login (cached check, no API
    // fallback); without one the job goes back unspent instead of failing.
    const loggedIn = !model.startsWith('codex-cli:') || await assertCodexChatGptLogin().then(() => true, () => false);
    // No await between this check and the reservation, so concurrent claims cannot both pass on the same headroom.
    // The handler completes a job as a calm skip when no chat model is servable
    // (keyless installs), which would consume the queue without facts.
    const servable = loggedIn && cost !== null && isAvailable('chat', model);
    // A signal or the deadline can pass during setup, before the monitor's first tick.
    const halt: FactsAbsorbRun['stopped'] | null = opts.signal?.aborted ? 'signal'
      : Date.now() > deadline ? 'time'
      : cost === null ? 'unpriced'
      : !servable ? 'unavailable'
      : spent() + inFlightUsd + cost > opts.maxUsd ? 'budget'
      : null;
    if (stopped || halt || cost === null) {
      stop(halt ?? 'budget');
      // Lease-full requeue: back to the queue without using an attempt.
      throw new RateLeaseUnavailableError('facts-absorb-run-budget', 1, 1);
    }
    inFlightUsd += cost;
    const run = handler(job);
    running.add(run);
    try {
      return await run;
    } finally {
      inFlightUsd -= cost;
      embedCeilingUsd += now.embedUsd ?? 0;
      running.delete(run);
    }
  };
  // Every job this run claimed; the worker writes its outcome after the handler returns or throws.
  const started: number[] = [];
  const running = new Set<Promise<unknown>>();
  worker.register('facts-absorb', gated);
  const pollMs = opts.pollMs ?? 500;
  let ticking = false;
  const monitor = setInterval(async () => {
    if (Date.now() > deadline) return stop('time');
    // A slow database must not stack overlapping passes on the small pool.
    if (ticking) return;
    ticking = true;
    try {
      loggedUsd = await loggedFactsUsd(engine, startedAt);
      // A systematic fault fails (or empties) every job in seconds; stop before it reaches more of the queue.
      const { bad, good } = await countOutcomes(engine, startedAt);
      if (bad >= 3 && bad > good) return stop('failing');
      if (await countClaimableBy(engine, new Date(deadline)) === 0) stop('queue_empty');
    } catch { /* the next tick retries; the worker keeps its own health checks */ } finally {
      ticking = false;
    }
  }, pollMs);
  try {
    await withBudgetTracker(tracker, () => worker.start());
    // start() returns 30 s after stop even if a job is mid-request. Wait for
    // every handler, then for the worker to write each job's outcome, before
    // reporting, so the caller never disconnects under a paid call.
    await Promise.allSettled([...running]);
    for (let i = 0; started.length && i < 120; i++) {
      const [row] = await engine.executeRaw<{ n: number | string }>(
        `SELECT count(*) AS n FROM minion_jobs WHERE id = ANY($1::bigint[]) AND status='active'`, [started]);
      if (Number(row?.n ?? 0) === 0) break;
      await Bun.sleep(500);
    }
  } finally {
    clearInterval(monitor);
  }
  loggedUsd = await loggedFactsUsd(engine, startedAt).catch(() => loggedUsd);
  return result(stopped ?? 'queue_empty', spent());
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const maxUsd = Number(flag('--max-usd'));
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) throw new Error('--max-usd must be a positive number');
  const concurrency = Number(flag('--concurrency') ?? 1);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error('--concurrency must be an integer from 1 to 16');
  const maxMinutes = Number(flag('--max-minutes') ?? 60);
  if (!Number.isFinite(maxMinutes) || maxMinutes <= 0) throw new Error('--max-minutes must be a positive number');
  const config = loadConfig();
  if (!config) throw new Error('no gbrain config');
  configureGateway(buildGatewayConfig(config));
  const engineConfig = toEngineConfig(config);
  const engine = await createEngine(engineConfig);
  const abort = new AbortController();
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => abort.abort());
  try {
    await engine.connect(engineConfig);
    const run = await runFactsAbsorb(engine, { maxUsd, concurrency, maxMinutes, signal: abort.signal });
    console.log(JSON.stringify({ action: 'facts_absorb_run', ...run }));
    if (run.stopped === 'unpriced' || run.stopped === 'unavailable' || run.stopped === 'failing') process.exitCode = 1;
  } finally {
    await engine.disconnect();
  }
}

if (import.meta.main) await main();
