#!/usr/bin/env bun
/**
 * Run queued `facts-absorb` jobs under a hard spend cap, then exit.
 *
 * Usage: bun scripts/run-facts-absorb.ts --max-usd N [--concurrency C] [--max-minutes M]
 *
 * Only `facts-absorb` is registered, so no other job kind is claimed. The cap
 * is enforced before work starts, not by failing a call: the facts pipeline
 * turns a refused model call into an empty completed job, which would lose
 * that page's facts. The runner stops claiming once the spend so far plus a
 * worst-case cost for every job that could still start would pass the cap.
 */
import { loadConfig, toEngineConfig } from '../src/core/config.ts';
import { createEngine } from '../src/core/engine-factory.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
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
 * One claim is one attempt: the first extractor call plus a truncation retry
 * and a malformed-output retry at twice the output cap. Input is counted at
 * one token per two characters (real tokenizers average about four), with the
 * operator prompt appendix and a fixed allowance for the wrapper and entity
 * hints. Every model a queued job names is priced (a job's `data.model` wins
 * over the brain default), plus up to 25 fact embeddings. Any unpriced model
 * makes the run unbounded: null.
 */
export async function worstCaseFactsJobUsd(engine: BrainEngine, overrides?: PricingOverrides): Promise<number | null> {
  const maxTokens = await getFactsExtractionMaxTokens(engine);
  const appendix = await getFactsExtractionPromptAppendix(engine);
  const systemChars = Math.max(buildExtractorSystem(true).length, buildExtractorSystem(false).length) + (appendix?.length ?? 0) + 2;
  const inputPerCall = Math.ceil((systemChars + MAX_TURN_TEXT_CHARS) / 2) + 1_000;
  const queued = await engine.executeRaw<{ model: string | null }>(
    `SELECT DISTINCT data->>'model' AS model FROM minion_jobs
      WHERE name='facts-absorb' AND queue='default' AND status IN ('waiting', 'delayed')`);
  const models = new Set([await getFactsExtractionModel(engine), ...queued.flatMap(row => row.model ? [row.model] : [])]);
  let chat = 0;
  for (const model of models) {
    const cost = reservationCostUsd(model, 'chat', 3 * inputPerCall, 5 * maxTokens, overrides);
    if (cost === null) return null;
    chat = Math.max(chat, cost);
  }
  const embedModel = await engine.getConfig('embedding_model');
  const embed = embedModel ? reservationCostUsd(embedModel, 'embed', 25 * 500, 0, overrides) : 0;
  return embed === null ? null : chat + embed;
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
  const worstCaseJobUsd = await worstCaseFactsJobUsd(engine, pricingOverrides);
  const result = async (stopped: FactsAbsorbRun['stopped'], spentUsd: number): Promise<FactsAbsorbRun> => ({
    stopped,
    completed: await countJobs(engine, 'completed', startedAt),
    failed: await countJobs(engine, 'failed', startedAt) + await countJobs(engine, 'dead', startedAt),
    spentUsd,
    worstCaseJobUsd,
    remaining: await countJobs(engine, 'waiting') + await countJobs(engine, 'delayed'),
  });
  if (opts.signal?.aborted) return result('signal', 0);
  if (worstCaseJobUsd === null) return result('unpriced', 0);
  // Between two polls up to `concurrency` jobs can finish and as many start.
  const reserve = 2 * concurrency * worstCaseJobUsd;
  if (opts.maxUsd < reserve) return result('budget', 0);

  const tracker = new BudgetTracker({ label: 'facts:run-facts-absorb', maxCostUsd: opts.maxUsd, pricingOverrides });
  const builtins = new MinionWorker(engine);
  await registerBuiltinHandlers(builtins, engine, { quiet: true });
  const handler = builtins.getHandler('facts-absorb');
  if (!handler) throw new Error('facts-absorb handler is not registered');
  const worker = new MinionWorker(engine, {
    queue: 'default', concurrency, pollInterval: 1_000, healthCheckInterval: 0,
  });
  worker.register('facts-absorb', handler);

  let stopped: FactsAbsorbRun['stopped'] | null = null;
  const stop = (why: FactsAbsorbRun['stopped']) => { if (!stopped) { stopped = why; worker.stop(); } };
  opts.signal?.addEventListener('abort', () => stop('signal'), { once: true });
  const pollMs = opts.pollMs ?? 500;
  // The tracker and chat_usage_log price the same calls slightly differently
  // (about 4% apart on production); the cap uses whichever is higher.
  let loggedUsd = 0;
  const spent = () => Math.max(tracker.snapshot().cumulativeCostUsd, loggedUsd);
  const monitor = setInterval(async () => {
    if (spent() + reserve > opts.maxUsd) return stop('budget');
    if (Date.now() > deadline) return stop('time');
    try {
      loggedUsd = await loggedFactsUsd(engine, startedAt);
      if (spent() + reserve > opts.maxUsd) return stop('budget');
      // A setup fault fails every job in seconds; stop before it reaches more of the queue.
      const errored = await countErroredAttempts(engine, startedAt);
      if (errored >= 3 && errored > await countJobs(engine, 'completed', startedAt)) return stop('failing');
      if (await countClaimableBy(engine, new Date(deadline)) === 0) stop('queue_empty');
    } catch { /* the next tick retries; the worker keeps its own health checks */ }
  }, pollMs);
  try {
    await withBudgetTracker(tracker, () => worker.start());
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
