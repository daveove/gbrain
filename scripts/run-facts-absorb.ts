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
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';
import { BudgetTracker, loadPricingOverrides, type PricingOverrides } from '../src/core/budget/budget-tracker.ts';
import { reservationCostUsd } from '../src/core/budget/reservation-cost.ts';
import { configureGateway, withBudgetTracker } from '../src/core/ai/gateway.ts';
import { buildGatewayConfig } from '../src/core/ai/build-gateway-config.ts';
import {
  MAX_TURN_TEXT_CHARS,
  buildExtractorSystem,
  getFactsExtractionMaxTokens,
  getFactsExtractionModel,
  getFactsExtractionPromptAppendix,
} from '../src/core/facts/extract.ts';

export interface FactsAbsorbRun {
  stopped: 'queue_empty' | 'budget' | 'time' | 'unpriced' | 'signal' | 'failing';
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
  usd: (model: string) => number | null;
}> {
  const maxTokens = await getFactsExtractionMaxTokens(engine);
  const appendix = await getFactsExtractionPromptAppendix(engine);
  const systemBytes = Math.max(
    Buffer.byteLength(buildExtractorSystem(true)), Buffer.byteLength(buildExtractorSystem(false)),
  ) + Buffer.byteLength(appendix ?? '') + 2;
  const inputPerCall = systemBytes + 4 * MAX_TURN_TEXT_CHARS + 200;
  const outputTokens = maxTokens + 2 * (2 * maxTokens);
  const embedModel = await engine.getConfig('embedding_model');
  const embed = embedModel ? reservationCostUsd(embedModel, 'embed', 25 * 4 * 500, 0, overrides) : 0;
  return {
    defaultModel: await getFactsExtractionModel(engine),
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

/** Jobs whose attempt in this run ended in an error: now retrying or terminally failed. */
async function countErroredAttempts(engine: BrainEngine, since: Date): Promise<number> {
  const rows = await engine.executeRaw<{ n: number | string }>(
    `SELECT count(*) AS n FROM minion_jobs WHERE name='facts-absorb' AND queue='default'
       AND status IN ('delayed', 'failed', 'dead') AND updated_at >= $1::timestamptz`, [since.toISOString()]);
  return Number(rows[0]?.n ?? 0);
}

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
  const spent = () => Math.max(tracker.snapshot().cumulativeCostUsd, loggedUsd);
  // Worst case of every job now running, released when the job ends; its real
  // spend is in the tracker by then.
  let inFlightUsd = 0;
  const gated: MinionHandler = async job => {
    // Model and config are fresh per claim, as the handler re-resolves them per
    // job. Overrides stay the startup map the tracker debits with; a change
    // takes effect on the next run.
    const now = await factsJobWorstCase(engine, pricingOverrides);
    const model = typeof job.data.model === 'string' && job.data.model ? job.data.model : now.defaultModel;
    const cost = now.usd(model);
    // No await between this check and the reservation, so concurrent claims cannot both pass on the same headroom.
    if (stopped || cost === null || spent() + inFlightUsd + cost > opts.maxUsd) {
      stop(cost === null ? 'unpriced' : 'budget');
      // Lease-full requeue: back to the queue without using an attempt.
      throw new RateLeaseUnavailableError('facts-absorb-run-budget', 1, 1);
    }
    inFlightUsd += cost;
    const run = handler(job);
    running.add(run);
    started.push(job.id);
    try {
      return await run;
    } finally {
      inFlightUsd -= cost;
      running.delete(run);
    }
  };
  // Every job this run started; the worker writes its outcome after the handler returns.
  const started: number[] = [];
  const running = new Set<Promise<unknown>>();
  worker.register('facts-absorb', gated);
  const pollMs = opts.pollMs ?? 500;
  const monitor = setInterval(async () => {
    if (Date.now() > deadline) return stop('time');
    try {
      loggedUsd = await loggedFactsUsd(engine, startedAt);
      // A setup fault fails every job in seconds; stop before it reaches more of the queue.
      const errored = await countErroredAttempts(engine, startedAt);
      if (errored >= 3 && errored > await countJobs(engine, 'completed', startedAt)) return stop('failing');
      if (await countClaimableBy(engine, new Date(deadline)) === 0) stop('queue_empty');
    } catch { /* the next tick retries; the worker keeps its own health checks */ }
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
    if (run.stopped === 'unpriced' || run.stopped === 'failing') process.exitCode = 1;
  } finally {
    await engine.disconnect();
  }
}

if (import.meta.main) await main();
