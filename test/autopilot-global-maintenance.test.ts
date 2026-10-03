/**
 * #2194 fix #3 / #2227 bug #3 — the cycle split.
 *
 * Per-source autopilot cycles run ONLY source-scoped phases; mixed + global
 * phases run ONCE in a separate autopilot-global-maintenance
 * job. This replaces the rejected skip-and-stamp-fresh design (codex #1/#2): the
 * split makes single-flight structural (one global job, not N concurrent embeds)
 * and never marks a source "fresh" for global work it didn't do. These tests pin
 * the phase partition, the dispatch gate, the per-source phase set, and the
 * global handler stamping autopilot.last_global_at.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, spyOn } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { appendCompleted } from '../src/core/op-checkpoint.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { pinDailyMemoryJob, queueFanoutDailyMemory, finishFanoutDailyMemory, refreshDailyMemoryAfterSourceSync, dailyMemoryDaysForSlugs, queueStandaloneSyncDailyMemory, runDailyMemoryJob } from '../src/core/cycle/daily-memory-followup.ts';
import { DAILY_MEMORY_SOURCE_ID } from '../src/core/cycle/daily-memory.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';
import {
  ALL_PHASES,
  SOURCE_PHASES,
  SOURCE_FRESHNESS_PHASES,
  SOURCE_BACKGROUND_PHASES,
  MIXED_PHASES,
  GLOBAL_PHASES,
  MAINTENANCE_PHASES,
  PHASE_SCOPE,
  resolveCyclePhases,
  deriveStatus,
  runCycle,
  LAST_GLOBAL_AT_KEY,
} from '../src/core/cycle.ts';
import {
  dispatchGlobalMaintenance,
  isGlobalMaintenanceStale,
  dispatchPerSource,
} from '../src/commands/autopilot-fanout.ts';
import type { BrainEngine } from '../src/core/engine.ts';

describe('cycle phase partition (#2194 fix #3)', () => {
  test('SOURCE ∪ MIXED ∪ GLOBAL == ALL_PHASES, no overlap', () => {
    const union = new Set([...SOURCE_PHASES, ...MIXED_PHASES, ...GLOBAL_PHASES]);
    expect(union.size).toBe(ALL_PHASES.length);
    for (const p of ALL_PHASES) expect(union.has(p)).toBe(true);
    expect(SOURCE_PHASES.filter((p) => MIXED_PHASES.includes(p) || GLOBAL_PHASES.includes(p))).toEqual([]);
    expect(MIXED_PHASES.filter((p) => GLOBAL_PHASES.includes(p))).toEqual([]);
  });

  test('every GLOBAL phase is PHASE_SCOPE==="global"; embed is global, lint is not', () => {
    for (const p of GLOBAL_PHASES) expect(PHASE_SCOPE[p]).toBe('global');
    expect(GLOBAL_PHASES).toContain('embed');
    expect(GLOBAL_PHASES).toContain('orphans');
    expect(GLOBAL_PHASES).toContain('purge');
    expect(SOURCE_PHASES).toContain('lint');
    expect(SOURCE_PHASES).toContain('sync');
    expect(SOURCE_PHASES).not.toContain('embed');
    expect(MIXED_PHASES).toEqual([
      'synthesize',
      'patterns',
      'consolidate',
      'conversation_facts_backfill',
      'enrich_thin',
    ]);
    expect(MAINTENANCE_PHASES).toContain('synthesize');
    expect(MAINTENANCE_PHASES).toContain('patterns');
    expect(MAINTENANCE_PHASES).toContain('consolidate');
    expect(MAINTENANCE_PHASES).toContain('conversation_facts_backfill');
    expect(MAINTENANCE_PHASES).toContain('enrich_thin');
    expect(MAINTENANCE_PHASES).toContain('embed');
    // Once per day, not once per source.
    expect(SOURCE_FRESHNESS_PHASES).not.toContain('consolidate');
    expect(SOURCE_FRESHNESS_PHASES).not.toContain('conversation_facts_backfill');
    expect(SOURCE_FRESHNESS_PHASES).not.toContain('enrich_thin');
  });

  test('source freshness excludes LLM-backed/background source work', () => {
    expect(new Set([...SOURCE_FRESHNESS_PHASES, ...SOURCE_BACKGROUND_PHASES])).toEqual(new Set(SOURCE_PHASES));
    expect(SOURCE_FRESHNESS_PHASES).toContain('sync');
    expect(SOURCE_FRESHNESS_PHASES).toContain('extract_facts');
    expect(SOURCE_BACKGROUND_PHASES).toContain('extract_atoms');
    expect(SOURCE_BACKGROUND_PHASES).toContain('propose_takes');
    expect(SOURCE_BACKGROUND_PHASES).toContain('schema-suggest');
    expect(SOURCE_BACKGROUND_PHASES).not.toContain('consolidate');
    expect(SOURCE_BACKGROUND_PHASES).not.toContain('enrich_thin');
    expect(SOURCE_FRESHNESS_PHASES).not.toContain('extract_atoms');
  });

  test('implicit source cycles are freshness-only; explicit phase lists are honored verbatim', () => {
    // `dream --source X` with no phase flag is the freshness path and must
    // finish independently of brain-wide maintenance. An EXPLICIT phase list
    // is deliberate operator intent and is honored verbatim (#4250 regression
    // pin: `dream --source X --phase synthesize`, and `--input <file>` which
    // implies synthesize, must actually run — queue payloads are normalized
    // at the autopilot-cycle handler instead, see the handler tests below).
    expect(resolveCyclePhases(undefined, 'repo-a')).toEqual(SOURCE_FRESHNESS_PHASES);
    expect(resolveCyclePhases(['synthesize'], 'repo-a')).toEqual(['synthesize']);
    expect(resolveCyclePhases(['sync', 'synthesize', 'patterns', 'embed'], 'repo-a'))
      .toEqual(['sync', 'synthesize', 'patterns', 'embed']);
    expect(resolveCyclePhases(undefined, 'default')).toEqual(ALL_PHASES);
    expect(resolveCyclePhases(undefined, undefined)).toEqual(ALL_PHASES);
    expect(resolveCyclePhases(['synthesize'], undefined)).toEqual(['synthesize']);
  });

  test('default-like source opt-in runs a full implicit cycle without changing explicit phases (#4700)', () => {
    expect(resolveCyclePhases(undefined, 'repo-a', true)).toEqual(ALL_PHASES);
    expect(resolveCyclePhases(['sync'], 'repo-a', true)).toEqual(['sync']);
  });

  test('exclusion skip-records never dilute failure status into a stampable partial (#4250 ship-stage P1)', () => {
    // Pre-fix: six failed freshness phases + seventeen synthetic exclusion
    // skips made deriveStatus see "not every entry failed" → 'partial' →
    // the stamp gate marked a totally-failed source fresh forever.
    const fail = (phase: string) => ({ phase, status: 'fail', duration_ms: 0, summary: '', details: {} });
    const exclusion = (phase: string) => ({
      phase, status: 'skipped', duration_ms: 0, summary: '',
      details: { reason: 'excluded_from_implicit_source_cycle' },
    });
    const realSkip = (phase: string) => ({
      phase, status: 'skipped', duration_ms: 0, summary: '', details: { reason: 'no_brain_dir' },
    });
    const zeroTotals = {} as never;
    // All attempted phases failed + exclusion bookkeeping → 'failed', never 'partial'.
    expect(deriveStatus(
      [fail('sync'), fail('lint'), exclusion('synthesize'), exclusion('patterns'), exclusion('embed')] as never,
      zeroTotals,
    )).toBe('failed');
    // A genuinely mixed run (one fail, one real skip) stays 'partial'.
    expect(deriveStatus([fail('sync'), realSkip('lint')] as never, zeroTotals)).toBe('partial');
  });

  test('implicit source cycle reports excluded non-freshness phases instead of silently omitting them', async () => {
    const report = await runCycle(null, {
      brainDir: null,
      sourceId: 'repo-a',
      dryRun: true,
    });
    const byPhase = new Map(report.phases.map((p) => [p.phase, p]));
    // Every non-freshness phase is present as an explicit exclusion record.
    for (const phase of ALL_PHASES) {
      if (SOURCE_FRESHNESS_PHASES.includes(phase)) continue;
      const rec = byPhase.get(phase);
      expect(rec?.status).toBe('skipped');
      expect(rec?.details.reason).toBe('excluded_from_implicit_source_cycle');
      expect(rec?.details.source_id).toBe('repo-a');
    }
    // The freshness phases themselves are attempted (not exclusion records).
    for (const phase of SOURCE_FRESHNESS_PHASES) {
      const rec = byPhase.get(phase);
      expect(rec).toBeTruthy();
      expect(rec?.details?.reason).not.toBe('excluded_from_implicit_source_cycle');
    }
  });

});

describe('isGlobalMaintenanceStale', () => {
  const now = Date.UTC(2026, 5, 16, 12, 0, 0);
  test('null/unparseable → stale (must run)', () => {
    expect(isGlobalMaintenanceStale(null, now)).toBe(true);
    expect(isGlobalMaintenanceStale('not-a-date', now)).toBe(true);
  });
  test('older than floor → stale; within floor → fresh', () => {
    expect(isGlobalMaintenanceStale(new Date(now - 61 * 60_000).toISOString(), now, 60)).toBe(true);
    expect(isGlobalMaintenanceStale(new Date(now - 10 * 60_000).toISOString(), now, 60)).toBe(false);
  });
});

describe('dispatchGlobalMaintenance — single-flight gate', () => {
  function stubs(lastGlobalAt: string | null) {
    const added: Array<{ name: string; data: any; opts: any }> = [];
    const engine = {
      kind: 'postgres' as const,
      getConfig: async (k: string) => (k === LAST_GLOBAL_AT_KEY ? lastGlobalAt : null),
    } as unknown as BrainEngine;
    const queue = {
      add: async (name: string, data: unknown, opts: Record<string, unknown>) => {
        added.push({ name, data, opts }); return { id: 1 };
      },
    } as any;
    return { engine, queue, added };
  }

  test('stale (never run) → dispatches one global job with single-flight opts', async () => {
    const { engine, queue, added } = stubs(null);
    const r = await dispatchGlobalMaintenance(engine, queue, { repoPath: '/tmp', slot: 's1', timeoutMs: 1, jsonMode: true, emit: () => {} });
    expect(r.dispatched).toBe(true);
    expect(added.length).toBe(1);
    expect(added[0].name).toBe('autopilot-global-maintenance');
    expect(added[0].opts.idempotency_key).toBe('autopilot-global:s1');
    // Structural single-flight: maxPending (waiting + live-lock active),
    // NOT maxWaiting — an in-flight active run must suppress re-dispatch
    // across slot rotation (upstream issue #2).
    expect(added[0].opts.maxPending).toBe(1);
    expect(added[0].opts.maxWaiting).toBeUndefined();
    expect(added[0].data.phases).toEqual(MAINTENANCE_PHASES);
  });

  test('a coalesced global cycle still gets an independent exact-sibling daily barrier', async () => {
    const { engine } = stubs(null);
    const added: Array<{ name: string; data: Record<string, unknown>; opts: any }> = [];
    const queue = { add: async (name: string, data: Record<string, unknown>, opts: any) => {
      added.push({ name, data, opts });
      return { id: name === 'autopilot-global-maintenance' ? 10 : 11, status: 'waiting', data,
        coalesced: name === 'autopilot-global-maintenance' };
    } } as never;
    await dispatchGlobalMaintenance(engine, queue, { repoPath: '/tmp', slot: 'slot-fixture', timeoutMs: 1,
      jsonMode: true, emit: () => {}, dailyMemoryDate: '2026-09-30', dailyMemoryTimezone: 'Asia/Manila', sourceJobIds: [4,3] });
    expect(added.map(job => job.name)).toEqual(['autopilot-global-maintenance', 'autopilot-daily-memory', 'autopilot-daily-memory']);
    expect(added[0].data.daily_memory_date).toBe('2026-09-30');
    expect(added[0].data.daily_memory_timezone).toBe('Asia/Manila');
    expect(added[1].data.source_cycle_job_ids).toEqual([3,4,10]);
    expect(added[1].data.daily_memory_date).toBe('2026-09-30');
    expect(added[1].data.daily_memory_timezone).toBe('Asia/Manila');
    expect(added[2].data.daily_memory_date).toBe('2026-09-29');
    expect(added[2].data.daily_memory_timezone).toBe('Asia/Manila');
    expect(added[1].opts.maxPending).toBeUndefined();
    expect(added[0].data.daily_memory_deferred).toBeUndefined();
  });

  test('barrier enqueue failure leaves accepted maintenance with its pinned-day backup', async () => {
    const updates: Array<{ sql: string; params: unknown[] }> = [];
    const engine = {
      kind: 'postgres' as const,
      getConfig: async () => null,
      executeRaw: async (sql: string, params: unknown[] = []) => { updates.push({ sql, params }); return []; },
    } as unknown as BrainEngine;
    let accepted: Record<string, unknown> | undefined;
    const queue = { add: async (name: string, data: Record<string, unknown>) => {
      if (name === 'autopilot-daily-memory') throw new Error('Synthetic barrier enqueue failure');
      accepted = data;
      return { id: 44, status: 'waiting', data, coalesced: false };
    } } as never;
    await expect(dispatchGlobalMaintenance(engine, queue, {
      repoPath: '/tmp', slot: 'barrier-fail', timeoutMs: 1, jsonMode: true, emit: () => {},
      dailyMemoryDate: '2026-09-30', dailyMemoryTimezone: 'Asia/Manila', sourceJobIds: [3],
    })).rejects.toThrow('Synthetic barrier enqueue failure');
    expect(accepted?.daily_memory_date).toBe('2026-09-30');
    expect(accepted?.daily_memory_timezone).toBe('Asia/Manila');
    expect(accepted?.daily_memory_deferred).toBeUndefined();
    expect(updates).toHaveLength(0);
  });

  test('fresh global maintenance does not suppress a source fanout daily barrier', async () => {
    const { engine } = stubs(new Date().toISOString());
    const added: Array<{ name: string; data: Record<string, unknown> }> = [];
    const queue = { add: async (name: string, data: Record<string, unknown>) => {
      added.push({ name, data }); return { id: 12, status: 'waiting', data };
    } } as never;
    await dispatchGlobalMaintenance(engine, queue, { repoPath: '/tmp', slot: 'fresh-slot', timeoutMs: 1,
      jsonMode: true, emit: () => {}, dailyMemoryDate: '2026-09-30', sourceJobIds: [3] });
    expect(added.map(job => job.name)).toEqual(['autopilot-daily-memory', 'autopilot-daily-memory']);
    expect(added[0].data.source_cycle_job_ids).toEqual([3]);
    expect(added[0].data.daily_memory_date).toBe('2026-09-30');
    expect(added[1].data.daily_memory_date).toBe('2026-09-29');
  });

  test('fresh → does NOT dispatch', async () => {
    const { engine, queue, added } = stubs(new Date().toISOString());
    const r = await dispatchGlobalMaintenance(engine, queue, { repoPath: '/tmp', slot: 's1', timeoutMs: 1, jsonMode: true, emit: () => {} });
    expect(r.dispatched).toBe(false);
    expect(added.length).toBe(0);
  });

  test('coalesced submission → coalesced-aware return + dispatch_coalesced event (never claims a dispatch that did not insert)', async () => {
    const events: string[] = [];
    const engine = {
      kind: 'postgres' as const,
      getConfig: async (k: string) => (k === LAST_GLOBAL_AT_KEY ? null : null),
    } as unknown as BrainEngine;
    const queue = {
      add: async () => ({ id: 7, coalesced: true }),
    } as any;
    const r = await dispatchGlobalMaintenance(engine, queue, {
      repoPath: '/tmp', slot: 's1', timeoutMs: 1, jsonMode: true, emit: (l: string) => events.push(l),
    });
    // Honest-dispatch contract: nothing was inserted, so dispatched is false;
    // coalesced says the work is already in flight.
    expect(r.dispatched).toBe(false);
    expect(r.coalesced).toBe(true);
    const kinds = events.map(e => JSON.parse(e).event);
    expect(kinds).toContain('dispatch_coalesced');
    expect(kinds).not.toContain('dispatched');
  });
});

describe('dispatchPerSource — per-source jobs carry SOURCE phases only', () => {
  test('each per-source job excludes mixed and global phases', async () => {
    const sources = [{ id: 'repo-a', name: 'a', config: {} }, { id: 'repo-b', name: 'b', config: {} }];
    const added: any[] = [];
    const engine = {
      kind: 'postgres' as const,
      listAllSources: async () => sources,
      getConfig: async () => null,
      executeRaw: async () => [],
    } as unknown as BrainEngine;
    const queue = { add: async (name: string, data: unknown, opts: unknown) => { added.push({ name, data, opts }); return { id: added.length }; } } as any;
    await dispatchPerSource(engine, queue, { repoPath: '/tmp', slot: 's', timeoutMs: 1, fanoutMax: 4, jsonMode: true, emit: () => {}, log: () => {} });
    expect(added.length).toBe(2);
    for (const j of added) {
      expect(j.data.phases).toEqual(SOURCE_FRESHNESS_PHASES);
      expect(j.data.phases).not.toContain('synthesize');
      expect(j.data.phases).not.toContain('patterns');
      expect(j.data.phases).not.toContain('embed');
    }
  });
});

describe('autopilot-global-maintenance handler stamps last_global_at (PGLite)', () => {
  let engine: PGLiteEngine;
  let schemaVersion: string | null;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); schemaVersion = await engine.getConfig('version'); }, 30000);
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => { await resetPgliteState(engine); if (schemaVersion) await engine.setConfig('version', schemaVersion); });

  async function captureHandlers() {
    const handlers = new Map<string, (job: any) => Promise<any>>();
    const fakeWorker = { register(name: string, fn: (job: any) => Promise<any>) { handlers.set(name, fn); } };
    await registerBuiltinHandlers(fakeWorker as never, engine);
    return handlers;
  }

  test('daily barrier releases a single worker until every sibling is terminal and keeps its original day', async () => {
    const queue = new MinionQueue(engine);
    const dailyHandler = (await captureHandlers()).get('autopilot-daily-memory');
    expect(dailyHandler).toBeTruthy();
    const siblings = [await queue.add('autopilot-cycle', { source_id: 'fixture-a' }),
      await queue.add('autopilot-cycle', { source_id: 'fixture-b' })];
    const day = '2026-09-30';
    const id = await queueFanoutDailyMemory(queue, { day, ids: siblings.map(job => job.id), key: 'fixture-slot' });
    const barrier = (await engine.executeRaw<{ data: Record<string, unknown> }>('SELECT data FROM minion_jobs WHERE id=$1', [id]))[0];
    const pending = await dailyHandler!({ id, data: barrier.data });
    expect(pending.daily_memory_pending).toBe(true);
    expect(await engine.getPage(`daily-memory/${day}`, { sourceId: DAILY_MEMORY_SOURCE_ID })).toBeNull();
    const successor = (await engine.executeRaw<{ id: number; status: string; data: Record<string, unknown> }>(
      "SELECT id,status,data FROM minion_jobs WHERE name='autopilot-daily-memory' AND id<>$1", [id]))[0];
    expect(successor.status).toBe('delayed');
    expect(successor.data.daily_memory_date).toBe(day);
    // Source jobs are still claimable: the barrier never occupies this worker while waiting.
    const first = await queue.claim('fixture-lock-a', 60_000, 'default', ['autopilot-cycle']);
    expect(first).not.toBeNull();
    await queue.completeJob(first!.id, 'fixture-lock-a', {});
    expect((await finishFanoutDailyMemory(engine, { id: successor.id, data: successor.data })).daily_memory_pending).toBe(true);
    const last = await queue.claim('fixture-lock-b', 60_000, 'default', ['autopilot-cycle']);
    expect(last).not.toBeNull();
    await engine.putPage('notes/fanout-last', { type: 'note', title: 'Late sibling fixture', compiled_truth: 'Synthetic fixture', frontmatter: { date: day } });
    await engine.executeRaw("UPDATE pages SET effective_date=$1::date::timestamptz,effective_date_source='date' WHERE slug='notes/fanout-last'", [day]);
    await queue.failJob(last!.id, 'fixture-lock-b', 'Synthetic terminal failure', 'dead');
    // The original payload stays pinned even though its continuation is admitted after midnight.
    const pinned = await pinDailyMemoryJob(engine, { id: successor.id, data: successor.data });
    const done = await dailyHandler!(pinned);
    expect(done.daily_memory_pending).toBe(false);
    expect(done.day).toBe(day);
    expect(done.dependency_failures).toEqual([{ id: last!.id, status: 'dead' }]);
    expect((await engine.getPage(`daily-memory/${day}`, { sourceId: DAILY_MEMORY_SOURCE_ID }))!.compiled_truth).toContain('[[default:notes/fanout-last]]');
    expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE name='extract' AND status='waiting'")).toHaveLength(1);
    expect(await engine.getConfig(LAST_GLOBAL_AT_KEY)).toBeNull();
  });

  test('delayed daily barrier keeps pinned timezone after cycle.timezone changes', async () => {
    await engine.setConfig('cycle.timezone', 'Asia/Manila');
    const queue = new MinionQueue(engine);
    const sibling = await queue.add('autopilot-cycle', {});
    const day = '2026-09-30';
    const id = await queueFanoutDailyMemory(queue, {
      day, ids: [sibling.id], key: 'tz-pin-slot', timezone: 'Asia/Manila',
    });
    const barrier = (await engine.executeRaw<{ data: Record<string, unknown> }>(
      'SELECT data FROM minion_jobs WHERE id=$1', [id]))[0];
    expect(barrier.data.daily_memory_timezone).toBe('Asia/Manila');
    const pending = await finishFanoutDailyMemory(engine, { id, data: barrier.data });
    expect(pending.daily_memory_pending).toBe(true);
    const successor = (await engine.executeRaw<{ id: number; data: Record<string, unknown> }>(
      "SELECT id,data FROM minion_jobs WHERE name='autopilot-daily-memory' AND id<>$1", [id]))[0];
    expect(successor.data.daily_memory_timezone).toBe('Asia/Manila');
    await engine.setConfig('cycle.timezone', 'America/Los_Angeles');
    // Instant is 2026-09-30 in Manila and 2026-09-29 in Los Angeles.
    await engine.putPage('notes/tz-pin', {
      type: 'note', title: 'Timezone pin fixture', compiled_truth: 'Synthetic fixture', frontmatter: {},
    });
    await engine.executeRaw(
      "UPDATE pages SET effective_date=NULL, effective_date_source=NULL, updated_at='2026-09-30T02:00:00Z' WHERE slug='notes/tz-pin'");
    const claimed = await queue.claim('tz-pin-lock', 60_000, 'default', ['autopilot-cycle']);
    expect(claimed!.id).toBe(sibling.id);
    await queue.completeJob(sibling.id, 'tz-pin-lock', {});
    const pinned = await pinDailyMemoryJob(engine, { id: successor.id, data: successor.data });
    expect(pinned.data.daily_memory_timezone).toBe('Asia/Manila');
    const done = await finishFanoutDailyMemory(engine, pinned);
    expect(done.daily_memory_pending).toBe(false);
    expect(done.day).toBe(day);
    expect((await engine.getPage(`daily-memory/${day}`, { sourceId: DAILY_MEMORY_SOURCE_ID }))!.compiled_truth)
      .toContain('[[default:notes/tz-pin]]');
  });

  test('standalone date batch retains dispatch timezone through child fanout', async () => {
    await engine.setConfig('cycle.timezone', 'Asia/Manila');
    const batchId = await queueStandaloneSyncDailyMemory(engine, {
      sourceId: 'default', commit: 'synthetic-zone-batch', days: ['2026-09-29', '2026-09-30'],
    });
    const batch = (await engine.executeRaw<{ id: number; data: Record<string, unknown> }>(
      'SELECT id,data FROM minion_jobs WHERE id=$1', [batchId]))[0];
    expect(batch.data.daily_memory_timezone).toBe('Asia/Manila');
    await engine.setConfig('cycle.timezone', 'America/Los_Angeles');
    await runDailyMemoryJob(engine, batch);
    const child = (await engine.executeRaw<{ id: number; data: Record<string, unknown> }>(
      "SELECT id,data FROM minion_jobs WHERE name='autopilot-daily-memory' AND data->>'daily_memory_date'='2026-09-30' AND NOT(data ? 'daily_memory_dates')"))[0];
    expect(child.data.daily_memory_timezone).toBe('Asia/Manila');
    await engine.putPage('notes/batch-zone', { type: 'note', title: 'Synthetic zone', compiled_truth: 'Synthetic fixture' });
    await engine.executeRaw("UPDATE pages SET effective_date=NULL,effective_date_source=NULL,updated_at='2026-09-30T02:00:00Z' WHERE slug='notes/batch-zone'");
    await runDailyMemoryJob(engine, child);
    expect((await engine.getPage('daily-memory/2026-09-30', { sourceId: DAILY_MEMORY_SOURCE_ID }))!.compiled_truth)
      .toContain('[[default:notes/batch-zone]]');
  });

  test('legacy active daily handler persists its first timezone across an old-payload retry', async () => {
    await engine.setConfig('cycle.timezone', 'Asia/Manila');
    const queue = new MinionQueue(engine);
    const sibling = await queue.add('autopilot-cycle', {});
    const barrier = await queue.add('autopilot-daily-memory', {
      daily_memory_only: true, daily_memory_date: '2026-09-30', source_cycle_job_ids: [sibling.id],
    });
    const claimed = await queue.claim('synthetic-zone-owner', 60_000, 'default', ['autopilot-daily-memory']);
    expect(claimed!.id).toBe(barrier.id);
    const handler = (await captureHandlers()).get('autopilot-daily-memory')!;
    await handler(claimed);
    const saved = (await engine.executeRaw<{ data: Record<string, unknown> }>('SELECT data FROM minion_jobs WHERE id=$1', [barrier.id]))[0];
    expect(saved.data.daily_memory_timezone).toBe('Asia/Manila');
    await engine.setConfig('cycle.timezone', 'America/Los_Angeles');
    await handler(claimed);
    const successors = await engine.executeRaw<{ data: Record<string, unknown> }>(
      "SELECT data FROM minion_jobs WHERE name='autopilot-daily-memory' AND id<>$1", [barrier.id]);
    expect(successors.length).toBeGreaterThan(0);
    expect(successors.every(row => row.data.daily_memory_timezone === 'Asia/Manila')).toBe(true);
  });

  test('legacy pin helper leaves an unrelated active extract job unchanged', async () => {
    const queue = new MinionQueue(engine);
    const job = await queue.add('extract', { stale: true, sourceId: 'default' });
    const claimed = await queue.claim('synthetic-unrelated-owner', 60_000, 'default', ['extract']);
    expect(claimed!.id).toBe(job.id);
    const before = (await engine.executeRaw<{ data: Record<string, unknown> }>('SELECT data FROM minion_jobs WHERE id=$1', [job.id]))[0].data;
    await pinDailyMemoryJob(engine, { id: job.id, data: { daily_memory_date: '2026-09-30' } });
    expect((await engine.executeRaw<{ data: Record<string, unknown> }>('SELECT data FROM minion_jobs WHERE id=$1', [job.id]))[0].data).toEqual(before);
  });

  test('same-day barriers for distinct zones do not collide and explicit invalid zones fail', async () => {
    const queue = new MinionQueue(engine), opts = { day: '2026-09-30', ids: [], key: 'zone-identity' };
    const a = await queueFanoutDailyMemory(queue, { ...opts, timezone: 'Asia/Manila' });
    const b = await queueFanoutDailyMemory(queue, { ...opts, timezone: 'America/Los_Angeles' });
    expect(a).not.toBe(b);
    for (const zone of ['', 'Invalid/Zone', 3, null]) {
      await expect(runDailyMemoryJob(engine, { id: 987654, data: {
        daily_memory_date: opts.day, daily_memory_timezone: zone,
      } })).rejects.toThrow('Invalid daily memory timezone');
    }
    expect(await engine.getPage(`daily-memory/${opts.day}`, { sourceId: DAILY_MEMORY_SOURCE_ID })).toBeNull();
  });
  test('affected-day and standalone batches pin timezone at handoff', async () => {
    await engine.setConfig('cycle.timezone', 'Asia/Manila');
    const sourceId = 'tz-affected-source';
    const day = '2026-09-30';
    const slug = 'notes/tz-affected';
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    await engine.putPage(slug, {
      type: 'note', title: 'Timezone affected fixture', compiled_truth: 'Synthetic fixture',
      frontmatter: { date: day },
    }, { sourceId });
    await engine.executeRaw(
      "UPDATE pages SET effective_date=$1::date::timestamptz,effective_date_source='date' WHERE source_id=$2 AND slug=$3",
      [day, sourceId, slug]);
    const queue = new MinionQueue(engine);
    const source = await queue.add('autopilot-cycle', { source_id: sourceId });
    const claimed = (await queue.claim('tz-affected-lock', 60_000, 'default', ['autopilot-cycle']))!;
    await refreshDailyMemoryAfterSourceSync(engine, claimed, sourceId, {
      status: 'ok', phases: [{ phase: 'sync', pagesAffected: [slug] }],
    });
    const batch = (await engine.executeRaw<{ data: Record<string, unknown> }>(
      "SELECT data FROM minion_jobs WHERE name='autopilot-daily-memory' AND data ? 'daily_memory_dates' ORDER BY id DESC LIMIT 1"))[0];
    expect(batch.data.daily_memory_timezone).toBe('Asia/Manila');
    expect(batch.data.daily_memory_dates).toEqual([day]);
    await engine.setConfig('cycle.timezone', 'America/Los_Angeles');
    // Batch already accepted with Manila; a later cycle.timezone flip must not rewrite it.
    const batchAfterFlip = (await engine.executeRaw<{ data: Record<string, unknown> }>(
      "SELECT data FROM minion_jobs WHERE name='autopilot-daily-memory' AND data ? 'daily_memory_dates' ORDER BY id DESC LIMIT 1"))[0];
    expect(batchAfterFlip.data.daily_memory_timezone).toBe('Asia/Manila');
    const standaloneId = await queueStandaloneSyncDailyMemory(engine, {
      sourceId, commit: 'tz-standalone', days: [day],
    });
    expect(standaloneId).not.toBeNull();
    const standalone = (await engine.executeRaw<{ data: Record<string, unknown> }>(
      'SELECT data FROM minion_jobs WHERE id=$1', [standaloneId!]))[0];
    expect(standalone.data.daily_memory_timezone).toBe('America/Los_Angeles');
    const pinnedStandalone = await queueStandaloneSyncDailyMemory(engine, {
      sourceId, commit: 'tz-standalone-pin', days: [day], timezone: 'Asia/Manila',
    });
    const pinned = (await engine.executeRaw<{ data: Record<string, unknown> }>(
      'SELECT data FROM minion_jobs WHERE id=$1', [pinnedStandalone!]))[0];
    expect(pinned.data.daily_memory_timezone).toBe('Asia/Manila');
    await queue.completeJob(source.id, 'tz-affected-lock', {});
  });


  test('source-sync discovery and batch share one resolved timezone', async () => {
    await engine.setConfig('cycle.timezone', 'Asia/Manila');
    const sourceId = 'tz-once-source';
    const day = '2026-09-30';
    const slug = 'notes/tz-once';
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    await engine.putPage(slug, {
      type: 'note', title: 'Timezone once fixture', compiled_truth: 'Synthetic fixture', frontmatter: {},
    }, { sourceId });
    // Instant is 2026-09-30 in Manila and 2026-09-29 in Los Angeles.
    await engine.executeRaw(
      "UPDATE pages SET effective_date=NULL, effective_date_source=NULL, updated_at='2026-09-30T02:00:00Z' WHERE source_id=$1 AND slug=$2",
      [sourceId, slug]);
    const zones: string[] = [];
    const original = engine.getConfig.bind(engine);
    engine.getConfig = async (key: string) => {
      if (key === 'cycle.timezone') zones.push('read');
      return original(key);
    };
    try {
      const queue = new MinionQueue(engine);
      const source = await queue.add('autopilot-cycle', { source_id: sourceId });
      const claimed = (await queue.claim('tz-once-lock', 60_000, 'default', ['autopilot-cycle']))!;
      await refreshDailyMemoryAfterSourceSync(engine, claimed, sourceId, {
        status: 'ok', phases: [{ phase: 'sync', pagesAffected: [slug] }],
      });
      const batch = (await engine.executeRaw<{ data: Record<string, unknown> }>(
        "SELECT data FROM minion_jobs WHERE name='autopilot-daily-memory' AND data ? 'daily_memory_dates' ORDER BY id DESC LIMIT 1"))[0];
      expect(batch.data.daily_memory_timezone).toBe('Asia/Manila');
      expect(batch.data.daily_memory_dates).toEqual([day]);
      // One resolve for discovery+batch (not a second resolve after discovery).
      expect(zones.filter(z => z === 'read').length).toBe(1);
      await queue.completeJob(source.id, 'tz-once-lock', {});
    } finally {
      engine.getConfig = original;
    }
  });


  test('completed identical daily barriers are idempotent but changed dependency sets get a new job', async () => {
    const queue = new MinionQueue(engine), day = '2026-09-30';
    const id = await queueFanoutDailyMemory(queue, { day, ids: [], key: 'same-slot' });
    const claimed = await queue.claim('daily-complete-lock', 60_000, 'default', ['autopilot-daily-memory']);
    expect(claimed!.id).toBe(id);
    await queue.completeJob(id, 'daily-complete-lock', {});
    expect(await queueFanoutDailyMemory(queue, { day, ids: [], key: 'same-slot' })).toBe(id);
    expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE name='autopilot-daily-memory'")).toHaveLength(1);
    const sibling = await queue.add('autopilot-cycle', {});
    expect(await queueFanoutDailyMemory(queue, { day, ids: [sibling.id], key: 'same-slot' })).not.toBe(id);
  });

  test('replaying a parent after its completed child handed off does not duplicate or fail the live chain', async () => {
    const queue = new MinionQueue(engine), sibling = await queue.add('autopilot-cycle', {});
    const parentId = await queueFanoutDailyMemory(queue, { day: '2026-09-30', ids: [sibling.id], key: 'replay-slot' });
    const parent = await queue.claim('parent-lock', 60_000, 'default', ['autopilot-daily-memory']);
    expect(parent!.id).toBe(parentId);
    const parentResult = await finishFanoutDailyMemory(engine, parent!);
    await queue.completeJob(parentId, 'parent-lock', parentResult);
    await engine.executeRaw("UPDATE minion_jobs SET delay_until=now()-interval '1 second' WHERE name='autopilot-daily-memory' AND status='delayed'");
    await queue.promoteDelayed();
    const child = await queue.claim('child-lock', 60_000, 'default', ['autopilot-daily-memory']);
    const childResult = await finishFanoutDailyMemory(engine, child!);
    expect(childResult.daily_memory_pending).toBe(true);
    await queue.completeJob(child!.id, 'child-lock', childResult);
    const before = await engine.executeRaw("SELECT id,status FROM minion_jobs WHERE name='autopilot-daily-memory' ORDER BY id");
    expect((await finishFanoutDailyMemory(engine, parent!)).daily_memory_job_id).toBe(child!.id);
    expect(await engine.executeRaw("SELECT id,status FROM minion_jobs WHERE name='autopilot-daily-memory' ORDER BY id")).toEqual(before);
  });

  test('daily barrier refuses missing dependencies and rejected durable successors', async () => {
    const missing = { id: 77, data: { daily_memory_date: '2026-09-30', source_cycle_job_ids: [999999] } };
    await expect(finishFanoutDailyMemory(engine, missing)).rejects.toThrow('missing or unknown');
    const queue = new MinionQueue(engine), sibling = await queue.add('autopilot-cycle', {});
    const add = spyOn(MinionQueue.prototype, 'add').mockImplementation(async () => null as never);
    try { await expect(finishFanoutDailyMemory(engine, { id: 78, data: { daily_memory_date: '2026-09-30', source_cycle_job_ids: [sibling.id] } })).rejects.toThrow('was not accepted'); }
    finally { add.mockRestore(); }
    expect(await engine.getPage('daily-memory/2026-09-30', { sourceId: DAILY_MEMORY_SOURCE_ID })).toBeNull();
  });

  test('source-sync refresh clears debt when hard-deleted slugs resolve to no dates', async () => {
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES('gone-source','Gone fixture')");
    const slug = 'notes/gone-hard';
    await engine.putPage(slug, { type: 'note', title: 'Gone', compiled_truth: 'Synthetic fixture', frontmatter: { date: '2026-08-01' } }, { sourceId: 'gone-source' });
    const [page] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2', ['gone-source', slug]);
    await engine.executeRaw('DELETE FROM page_versions WHERE page_id=$1', [page.id]);
    await engine.executeRaw('DELETE FROM pages WHERE id=$1', [page.id]);
    const queue = new MinionQueue(engine);
    const first = await queue.add('autopilot-cycle', { source_id: 'gone-source' });
    const claimed = (await queue.claim('gone-lock', 60_000, 'default', ['autopilot-cycle']))!;
    expect(claimed.id).toBe(first.id);
    await refreshDailyMemoryAfterSourceSync(engine, claimed, 'gone-source', {
      status: 'ok', phases: [{ phase: 'sync', pagesAffected: [slug] }],
    });
    expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE name='autopilot-daily-memory'")).toHaveLength(0);
    expect(await engine.executeRaw("SELECT path FROM op_checkpoint_paths WHERE op='autopilot-sync-daily-memory'")).toHaveLength(0);
  });

  test('source-sync refresh cross-job checkpoint survives a terminal cycle row', async () => {
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES('checkpoint-source','Checkpoint fixture')");
    const day = '2026-09-18', slug = 'notes/checkpoint';
    await engine.putPage(slug, { type: 'note', title: 'Checkpoint', compiled_truth: 'Body', frontmatter: { date: day } }, { sourceId: 'checkpoint-source' });
    await engine.executeRaw("UPDATE pages SET effective_date=$1::date::timestamptz,effective_date_source='date' WHERE source_id='checkpoint-source'", [day]);
    const queue = new MinionQueue(engine);
    const first = await queue.add('autopilot-cycle', { source_id: 'checkpoint-source' });
    const claimed = (await queue.claim('cp-lock', 60_000, 'default', ['autopilot-cycle']))!;
    expect(claimed.id).toBe(first.id);
    const reject = spyOn(MinionQueue.prototype, 'add').mockImplementation(async () => { throw new Error('Synthetic checkpoint rejection'); });
    try {
      await expect(refreshDailyMemoryAfterSourceSync(engine, claimed, 'checkpoint-source', {
        status: 'ok', phases: [{ phase: 'sync', pagesAffected: [slug] }],
      })).rejects.toThrow('Synthetic checkpoint rejection');
    } finally { reject.mockRestore(); }
    await queue.failJob(first.id, 'cp-lock', 'terminal', 'failed', 0);
    // Brand-new cycle job with no saved dates and no pagesAffected must still refresh.
    const second = await queue.add('autopilot-cycle', { source_id: 'checkpoint-source' });
    const next = (await queue.claim('cp-next-lock', 60_000, 'default', ['autopilot-cycle']))!;
    expect(next.id).toBe(second.id);
    await refreshDailyMemoryAfterSourceSync(engine, next, 'checkpoint-source', {
      status: 'ok', phases: [{ phase: 'sync', pagesAffected: [] }],
    });
    const jobs = await engine.executeRaw<{ data: Record<string, unknown> }>(
      "SELECT data FROM minion_jobs WHERE name='autopilot-daily-memory'",
    );
    expect(jobs.some(j => j.data.daily_memory_date === day)).toBe(true);
  });

  test('source-sync refresh recovers terminal-job debt from a fresh no-op job and clears tombstones', async () => {
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES('affected-source','Affected fixture')");
    const slugs: string[] = [], days: string[] = [];
    for (let i = 0; i < 9; i++) {
      const day = `2026-09-${10+i}`, slug = `notes/affected-${i}`;
      days.push(day); slugs.push(slug);
      await engine.putPage(slug, { type: 'note', title: 'Affected fixture', compiled_truth: 'Synthetic fixture', frontmatter: { date: day } }, { sourceId: 'affected-source' });
      await engine.executeRaw("UPDATE pages SET effective_date=$1::date::timestamptz,effective_date_source='date' WHERE source_id=$2 AND slug=$3", [day,'affected-source',slug]);
    }
    const { ensureDailyMemorySource } = await import('../src/core/cycle/daily-memory.ts');
    await ensureDailyMemorySource(engine);
    await engine.putPage(`daily-memory/${days[0]}`, { type: 'note', title: 'Old generated day', compiled_truth: '[[affected-source:notes/affected-0]]', frontmatter: { dream_generated: true } }, { sourceId: DAILY_MEMORY_SOURCE_ID });
    await engine.softDeletePage(slugs[0], { sourceId: 'affected-source' });
    const queue = new MinionQueue(engine), source = await queue.add('autopilot-cycle', { source_id: 'affected-source' });
    const claimed = (await queue.claim('affected-lock', 60_000, 'default', ['autopilot-cycle']))!;
    expect(claimed.id).toBe(source.id);
    const execute = engine.executeRaw;
    const discovery = spyOn(engine, 'executeRaw').mockImplementation(async function<T>(this: PGLiteEngine, sql: string, params?: unknown[]): Promise<T[]> {
      if (sql.includes('SELECT source_id, slug, title, effective_date')) throw new Error('Synthetic affected-day discovery failure');
      return execute.call(this, sql, params) as Promise<T[]>;
    });
    try { await expect(refreshDailyMemoryAfterSourceSync(engine, claimed, 'affected-source', { status: 'ok', phases: [{ phase: 'sync', pagesAffected: slugs }] })).rejects.toThrow('Synthetic affected-day discovery failure'); }
    finally { discovery.mockRestore(); }
    expect(await engine.executeRaw("SELECT path FROM op_checkpoint_paths WHERE op='autopilot-sync-daily-memory' AND path::jsonb ? 'slug'")).toHaveLength(slugs.length);
    const reject = spyOn(MinionQueue.prototype, 'add').mockImplementation(async () => { throw new Error('Synthetic affected-day rejection'); });
    try { await expect(refreshDailyMemoryAfterSourceSync(engine, claimed, 'affected-source', { status: 'ok', phases: [{ phase: 'sync', pagesAffected: slugs }] })).rejects.toThrow('Synthetic affected-day rejection'); }
    finally { reject.mockRestore(); }
    const [saved] = await engine.executeRaw<{ data: Record<string, unknown> }>('SELECT data FROM minion_jobs WHERE id=$1', [source.id]);
    expect(saved.data.daily_memory_affected_dates).toEqual(days);
    expect(await engine.executeRaw("SELECT path FROM op_checkpoint_paths WHERE op='autopilot-sync-daily-memory' AND path::jsonb ? 'day'")).toHaveLength(days.length);
    await queue.failJob(source.id, 'affected-lock', 'Synthetic terminal handoff failure', 'dead');
    const fresh = await queue.add('autopilot-cycle', { source_id: 'affected-source' });
    const retried = (await queue.claim('affected-retry-lock', 60_000, 'default', ['autopilot-cycle']))!;
    expect(retried.id).toBe(fresh.id);
    expect(retried.data.daily_memory_affected_dates).toBeUndefined();
    await refreshDailyMemoryAfterSourceSync(engine, retried, 'affected-source', { status: 'ok', phases: [{ phase: 'sync', pagesAffected: [] }] });
    expect(await engine.executeRaw("SELECT path FROM op_checkpoint_paths WHERE op='autopilot-sync-daily-memory'")).toHaveLength(0);
    await queue.completeJob(fresh.id, 'affected-retry-lock', {});
    const handler = (await captureHandlers()).get('autopilot-daily-memory')!;
    const batchSizes: number[] = [];
    for (let i = 0; i < 80; i++) {
      await queue.promoteDelayed();
      const daily = await queue.claim('affected-daily-lock', 60_000, 'default', ['autopilot-daily-memory']);
      if (!daily) break;
      const result = await handler(daily);
      if (Array.isArray(result.daily_memory_days_queued) && !result.daily_memory_pending) {
        batchSizes.push(result.daily_memory_days_queued.length);
      } else if (Array.isArray(result.daily_memory_days_queued) && result.daily_memory_continuation_id) {
        batchSizes.push(result.daily_memory_days_queued.length);
      }
      await queue.completeJob(daily.id, 'affected-daily-lock', result);
    }
    expect(batchSizes[0]).toBe(8);
    for (const day of days) expect(await engine.getPage(`daily-memory/${day}`, { sourceId: DAILY_MEMORY_SOURCE_ID })).not.toBeNull();
    expect((await engine.getPage(`daily-memory/${days[0]}`, { sourceId: DAILY_MEMORY_SOURCE_ID }))!.compiled_truth).not.toContain('[[affected-source:notes/affected-0]]');
  });

  test('source-sync refresh mints a fresh batch after a completed handoff for the same days', async () => {
    const sourceId = 'retry-batch-source';
    const day = '2026-09-22';
    const slug = 'notes/retry-batch';
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    await engine.putPage(slug, { type: 'note', title: 'Retry batch v1', compiled_truth: 'First body', frontmatter: { date: day } }, { sourceId });
    await engine.executeRaw("UPDATE pages SET effective_date=$1::date::timestamptz,effective_date_source='date' WHERE source_id=$2 AND slug=$3", [day, sourceId, slug]);
    const { ensureDailyMemorySource } = await import('../src/core/cycle/daily-memory.ts');
    await ensureDailyMemorySource(engine);
    const queue = new MinionQueue(engine);
    const source = await queue.add('autopilot-cycle', { source_id: sourceId });
    const claimed = (await queue.claim('retry-batch-lock', 60_000, 'default', ['autopilot-cycle']))!;
    expect(claimed.id).toBe(source.id);
    await refreshDailyMemoryAfterSourceSync(engine, claimed, sourceId, {
      status: 'ok', phases: [{ phase: 'sync', pagesAffected: [slug] }],
    });
    const handler = (await captureHandlers()).get('autopilot-daily-memory')!;
    const firstBatchIds: number[] = [];
    for (let i = 0; i < 40; i++) {
      await engine.executeRaw("UPDATE minion_jobs SET delay_until=now()-interval '1 second' WHERE name='autopilot-daily-memory' AND status='delayed'");
      await queue.promoteDelayed();
      const daily = await queue.claim('retry-batch-daily', 60_000, 'default', ['autopilot-daily-memory']);
      if (!daily) break;
      firstBatchIds.push(daily.id);
      const result = await handler(daily);
      await queue.completeJob(daily.id, 'retry-batch-daily', result);
    }
    expect(firstBatchIds.length).toBeGreaterThan(0);
    expect(await engine.getPage(`daily-memory/${day}`, { sourceId: DAILY_MEMORY_SOURCE_ID })).not.toBeNull();
    expect((await engine.getPage(`daily-memory/${day}`, { sourceId: DAILY_MEMORY_SOURCE_ID }))!.compiled_truth).toContain('Retry batch v1');
    await engine.putPage(slug, { type: 'note', title: 'Retry batch v2', compiled_truth: 'Second body after retry', frontmatter: { date: day } }, { sourceId });
    await engine.executeRaw(
      "UPDATE pages SET title='Retry batch v2', effective_date=$1::date::timestamptz, effective_date_source='date' WHERE source_id=$2 AND slug=$3",
      [day, sourceId, slug],
    );
    await refreshDailyMemoryAfterSourceSync(engine, claimed, sourceId, {
      status: 'ok', phases: [{ phase: 'sync', pagesAffected: [slug] }],
    });
    const secondBatch = await engine.executeRaw<{ id: number; status: string }>(
      `SELECT id,status FROM minion_jobs WHERE name='autopilot-daily-memory' AND id<>ALL($1::bigint[]) ORDER BY id`,
      [firstBatchIds],
    );
    expect(secondBatch.length).toBeGreaterThan(0);
    expect(secondBatch.every(row => ['waiting', 'delayed', 'active'].includes(row.status))).toBe(true);
    const firstKeys = await engine.executeRaw<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM minion_jobs WHERE id=ANY($1::bigint[])`, [firstBatchIds]);
    const secondKeys = await engine.executeRaw<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM minion_jobs WHERE id=ANY($1::bigint[])`, [secondBatch.map(row => row.id)]);
    expect(secondKeys.every(row => !firstKeys.some(prev => prev.idempotency_key === row.idempotency_key))).toBe(true);
  });

  test('successful empty source discovery retires only captured debt and preserves a concurrent origin bank', async () => {
    const sourceId = 'empty-debt-source';
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    const queue = new MinionQueue(engine), source = await queue.add('autopilot-cycle', { source_id: sourceId });
    const other = await queue.add('autopilot-cycle', { source_id: sourceId });
    const claimed = (await queue.claim('empty-debt-owner', 60_000, 'default', ['autopilot-cycle']))!;
    expect(claimed.id).toBe(source.id);
    const key = { op: 'autopilot-sync-daily-memory', fingerprint: createHash('sha256').update(sourceId).digest('hex').slice(0,16) };
    const original = JSON.stringify({ jobId: source.id, slug: 'notes/never-existed' });
    const concurrent = JSON.stringify({ jobId: other.id, slug: 'notes/concurrent-missing' });
    let injected = false;
    const execute = engine.executeRaw;
    const spy = spyOn(engine, 'executeRaw').mockImplementation(async function<T>(this: PGLiteEngine, sql: string, params?: unknown[]): Promise<T[]> {
      if (!injected && sql.includes('SELECT source_id, slug, title, effective_date')) {
        injected = true; await appendCompleted(this, key, [concurrent]);
      }
      return execute.call(this, sql, params) as Promise<T[]>;
    });
    try { await refreshDailyMemoryAfterSourceSync(engine, claimed, sourceId, { status: 'ok', phases: [{ phase: 'sync', pagesAffected: ['notes/never-existed'] }] }); }
    finally { spy.mockRestore(); }
    expect(injected).toBe(true);
    const debt = await engine.executeRaw<{ path: string }>('SELECT path FROM op_checkpoint_paths WHERE op=$1 AND fingerprint=$2', [key.op,key.fingerprint]);
    expect(debt.map(row => row.path)).toEqual([concurrent]);
    expect(debt.some(row => row.path === original)).toBe(false);
    expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE name='autopilot-daily-memory'")).toHaveLength(0);
    await queue.completeJob(source.id, 'empty-debt-owner', {});
    const next = (await queue.claim('empty-debt-next', 60_000, 'default', ['autopilot-cycle']))!;
    await refreshDailyMemoryAfterSourceSync(engine, next, sourceId, { status: 'ok', phases: [{ phase: 'sync', pagesAffected: [] }] });
    expect(await engine.executeRaw('SELECT path FROM op_checkpoint_paths WHERE op=$1 AND fingerprint=$2', [key.op,key.fingerprint])).toHaveLength(0);
  });

  for (const sourceId of ['default','moved-date-source']) test(`date moves refresh ${sourceId} old index before graph extraction`, async () => {
    const slug = 'notes/moved-date';
    if (sourceId !== 'default') await engine.executeRaw("INSERT INTO sources(id,name) VALUES($1,'Moved date fixture')", [sourceId]);
    const { writeDailyMemoryFromSources } = await import('../src/core/cycle/daily-memory.ts');
    await engine.putPage(slug, { type: 'note', title: 'Moved date fixture', compiled_truth: 'Synthetic fixture', frontmatter: { date: '2026-09-20' } }, { sourceId });
    await engine.executeRaw("UPDATE pages SET effective_date='2026-09-20'::date::timestamptz,effective_date_source='date' WHERE source_id=$1 AND slug=$2", [sourceId, slug]);
    expect((await writeDailyMemoryFromSources(engine, { date: '2026-09-20' })).written).toBe(true);
    const old = (await engine.getPage('daily-memory/2026-09-20', { sourceId: DAILY_MEMORY_SOURCE_ID }))!;
    if (sourceId === 'default') await engine.putPage(old.slug, {
      type: old.type, title: old.title, frontmatter: old.frontmatter,
      compiled_truth: old.compiled_truth.replaceAll('[[default:', '[['),
    }, { sourceId: DAILY_MEMORY_SOURCE_ID });
    const target = sourceId === 'default' ? slug : `${sourceId}:${slug}`;
    expect((await engine.getPage(old.slug, { sourceId: DAILY_MEMORY_SOURCE_ID }))!.compiled_truth).toContain(`[[${target}]]`);
    expect(await engine.executeRaw('SELECT id FROM links WHERE from_page_id=$1', [old.id])).toHaveLength(0);
    await engine.putPage(slug, { type: 'note', title: 'Moved date fixture', compiled_truth: 'Synthetic fixture', frontmatter: { date: '2026-09-21' } }, { sourceId });
    await engine.executeRaw("UPDATE pages SET effective_date='2026-09-21'::date::timestamptz,effective_date_source='date' WHERE source_id=$1 AND slug=$2", [sourceId, slug]);
    expect(await dailyMemoryDaysForSlugs(engine, sourceId, [slug])).toEqual(['2026-09-20', '2026-09-21']);
    const queue = new MinionQueue(engine), source = await queue.add('autopilot-cycle', { source_id: sourceId });
    const claimed = (await queue.claim('moved-source-lock', 60_000, 'default', ['autopilot-cycle']))!;
    await refreshDailyMemoryAfterSourceSync(engine, claimed, sourceId, { status: 'ok', phases: [{ phase: 'sync', pagesAffected: [slug] }] });
    await queue.completeJob(source.id, 'moved-source-lock', {});
    const handler = (await captureHandlers()).get('autopilot-daily-memory')!;
    for (let i = 0; i < 4; i++) {
      const daily = await queue.claim('moved-daily-lock', 60_000, 'default', ['autopilot-daily-memory']);
      if (!daily) break;
      const result = await handler(daily);
      await queue.completeJob(daily.id, 'moved-daily-lock', result);
    }
    expect((await engine.getPage('daily-memory/2026-09-20', { sourceId: DAILY_MEMORY_SOURCE_ID }))!.compiled_truth).not.toContain(`[[${target}]]`);
    expect((await engine.getPage('daily-memory/2026-09-21', { sourceId: DAILY_MEMORY_SOURCE_ID }))!.compiled_truth).toContain(`[[${sourceId}:${slug}]]`);
  });

  test('autopilot-cycle handler normalizes a legacy per-source payload down to freshness phases', async () => {
    // Pre-v0.46.20 fanout payloads carried NON_GLOBAL_PHASES (mixed +
    // background). A legacy job draining after upgrade must not re-run that
    // work once per source: the handler intersects the queued list with
    // SOURCE_FRESHNESS_PHASES and surfaces what it rejected.
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path) VALUES ($1, $2, NULL)`,
      ['repo-a', 'repo-a'],
    );
    const handlers = await captureHandlers();
    const handler = handlers.get('autopilot-cycle');
    expect(handler).toBeTruthy();

    const legacyPhases = ['sync', 'synthesize', 'extract', 'patterns', 'extract_atoms', 'consolidate'];
    const result = await handler!({
      data: { source_id: 'repo-a', phases: legacyPhases, pull: false },
      signal: undefined,
    });
    expect(result.phases_rejected_by_normalization)
      .toEqual(['synthesize', 'patterns', 'extract_atoms', 'consolidate']);
    // Only the freshness subset reached runCycle.
    expect(result.report.phases.map((p: any) => p.phase)).toEqual(['sync', 'extract']);
  });

  test('an all-rejected queued payload is an explicit no-op, not an implicit freshness run', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path) VALUES ($1, $2, NULL)`,
      ['repo-b', 'repo-b'],
    );
    const handlers = await captureHandlers();
    const handler = handlers.get('autopilot-cycle');

    const result = await handler!({
      data: { source_id: 'repo-b', phases: ['synthesize', 'patterns'], pull: false },
      signal: undefined,
    });
    expect(result.status).toBe('skipped');
    expect(result.report.reason).toBe('all_phases_rejected_by_normalization');
    expect(result.report.phases_rejected_by_normalization).toEqual(['synthesize', 'patterns']);
    // No cycle ran → no freshness stamp.
    const source = (await engine.listAllSources()).find((row) => row.id === 'repo-b');
    expect(source?.config.last_source_cycle_at).toBeUndefined();
    expect(source?.config.last_full_cycle_at).toBeUndefined();

    // A payload that ARRIVES empty is the same explicit no-op, with an
    // honest reason (nothing was rejected — the list was empty).
    const empty = await handler!({
      data: { source_id: 'repo-b', phases: [], pull: false },
      signal: undefined,
    });
    expect(empty.status).toBe('skipped');
    expect(empty.report.reason).toBe('empty_phase_list');
    expect(empty.report.phases_rejected_by_normalization).toEqual([]);
  });

  test('an explicit empty phase list with a sourceId runs nothing and never stamps freshness', async () => {
    // Direct-caller edge of the PR-added `phases.length > 0` stamp guard:
    // queue callers are already protected by handler normalization, but a
    // direct runCycle caller passing [] must not get a freshness stamp for
    // work that never ran.
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path) VALUES ($1, $2, NULL)`,
      ['repo-empty', 'repo-empty'],
    );
    const report = await runCycle(engine, { brainDir: null, sourceId: 'repo-empty', phases: [] });
    expect(report.phases).toEqual([]);
    const source = (await engine.listAllSources()).find((row) => row.id === 'repo-empty');
    expect(source?.config.last_source_cycle_at).toBeUndefined();
    expect(source?.config.last_full_cycle_at).toBeUndefined();
  });

  test('a maintenance job with NO phases payload defaults to MAINTENANCE_PHASES (mixed included), not GLOBAL_PHASES', async () => {
    // Regression pin for the split's changed default: a legacy queued
    // maintenance job (or a hand-submitted one) with no explicit phases now
    // runs mixed + global — synthesize/patterns must appear in the report.
    const repoPath = mkdtempSync(join(tmpdir(), 'gbrain-global-default-'));
    const handlers = await captureHandlers();
    const handler = handlers.get('autopilot-global-maintenance');
    // id present so the handler threads a real privateQueueOwnerJobId into
    // runCycle (worker jobs always carry one).
    const result = await handler!({ id: 4101, data: { repoPath }, signal: undefined });
    const ranPhases = result.report.phases.map((p: any) => p.phase);
    for (const p of MAINTENANCE_PHASES) expect(ranPhases).toContain(p);
    expect(ranPhases).toContain('synthesize');
    expect(ranPhases).toContain('patterns');
    expect(ranPhases).toContain('consolidate');
    const consolidate = result.report.phases.find((p: { phase: string }) => p.phase === 'consolidate');
    expect(consolidate.status).toBe('ok');
    expect(consolidate.details.takes_written).toBe(0);
    expect(ranPhases).not.toContain('sync');
    expect(result.report.phases.some((p: any) => p.status === 'fail')).toBe(true);
    expect(await engine.getConfig(LAST_GLOBAL_AT_KEY)).toBeNull();
  }, 60_000);

  test('global maintenance consolidates every source when repoPath matches one source', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'gbrain-consolidate-scope-'));
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path) VALUES ('alpha', 'alpha', $1), ('beta', 'beta', NULL)`,
      [repoPath],
    );
    for (const sourceId of ['alpha', 'beta']) {
      for (let i = 0; i < 3; i++) {
        await engine.executeRaw(
          `INSERT INTO facts (source_id, entity_slug, fact, source, valid_from, visibility)
           VALUES ($1, 'people/example', $2, 'test', now() - interval '2 days', 'world')`,
          [sourceId, `${sourceId} fact ${i}`],
        );
      }
    }
    const handlers = await captureHandlers();
    const result = await handlers.get('autopilot-global-maintenance')!({
      id: 6837,
      data: { repoPath, phases: ['consolidate'] },
      signal: undefined,
    });
    const consolidate = result.report.phases.find((p: { phase: string }) => p.phase === 'consolidate');
    expect(consolidate.details.buckets_processed).toBe(2);

    const scoped = await runCycle(engine, {
      brainDir: repoPath,
      sourceId: 'alpha',
      phases: ['consolidate'],
    });
    const scopedPhase = scoped.phases.find((p) => p.phase === 'consolidate');
    expect(scopedPhase?.details.buckets_processed).toBe(1);
  }, 60_000);

  test('runs global phases (no source_id) and stamps autopilot.last_global_at on success', async () => {
    expect(await engine.getConfig(LAST_GLOBAL_AT_KEY)).toBeNull();
    const repoPath = mkdtempSync(join(tmpdir(), 'gbrain-global-maintenance-'));
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path) VALUES ($1, $2, $3)`,
      ['repo-a', 'repo-a', repoPath],
    );
    const handlers = await captureHandlers();
    const handler = handlers.get('autopilot-global-maintenance');
    expect(handler).toBeTruthy();

    // id present so the handler threads a real privateQueueOwnerJobId into
    // runCycle (worker jobs always carry one).
    const result = await handler!({
      id: 4102,
      data: { phases: ['orphans'], repoPath },
      signal: undefined,
    });
    // The cycle ran the requested global phases (DB-only on an empty brain).
    const orphans = result.report.phases.find((p: any) => p.phase === 'orphans');
    expect(orphans).toBeTruthy();
    expect(orphans.details.source_id).toBeUndefined();
    expect(result.report.phases.some((p: any) => p.status === 'fail')).toBe(false);
    expect(['ok', 'clean']).toContain(result.report.status);
    // Freshness stamped so the dispatch gate backs off.
    const stamped = await engine.getConfig(LAST_GLOBAL_AT_KEY);
    expect(stamped).not.toBeNull();
    expect(Number.isFinite(new Date(stamped!).getTime())).toBe(true);
  });
});
