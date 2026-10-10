import { LINK_EXTRACTOR_VERSION_TS } from '../src/core/link-extraction.ts';
/**
 * The daily maintenance job writes one durable memory from pages that
 * already live in sources. The test calls `autopilot-global-maintenance`
 * the way that job does: no phase list, so the handler defaults to
 * MAINTENANCE_PHASES and writes the note after the cycle.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, spyOn } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';
import { resolveCycleDate } from '../src/core/cycle/cycle-date.ts';
import { dailyMemorySlug, DAILY_MEMORY_SOURCE_ID, ensureDailyMemorySource, queueDailyMemoryExtract, writeDailyMemoryFromSources } from '../src/core/cycle/daily-memory.ts';
import { PageRevisionConflictError } from '../src/core/page-state/types.ts';
import { dailyMemoryDaysForSlugs } from '../src/core/cycle/daily-memory-followup.ts';
import { computeEffectiveDate, DATE_INSTANT_PROVENANCE } from '../src/core/effective-date.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { extractEntityRefs } from '../src/core/link-extraction.ts';
import { createTranscriptIngestDailyMemory } from '../src/core/transcripts/ingest-daily-memory.ts';
import { runTranscriptsIngest } from '../src/core/transcripts/ingest.ts';
import { dailyMemoryArgs } from '../scripts/write-daily-memory.ts';
import { extractStaleFromDB } from '../src/commands/extract.ts';
import { operationsByName } from '../src/core/operations.ts';
import { serializeMarkdown } from '../src/core/markdown.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';

describe('daily memory from sources the brain already holds', () => {
  let engine: PGLiteEngine;
  let schemaVersion: string | null;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); schemaVersion = await engine.getConfig('version'); }, 30000);
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => { await resetPgliteState(engine); if (schemaVersion) await engine.setConfig('version', schemaVersion); await ensureDailyMemorySource(engine); });

  test('autopilot-global-maintenance writes one note linking today\'s pages and skips older and dream pages', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ($1, $1), ($2, $2)`,
      ['notes', 'mail'],
    );
    await engine.putPage('meetings/standup', {
      type: 'meeting',
      title: 'Standup',
      compiled_truth: 'talked about the rollout',
    }, { sourceId: 'notes' });
    await engine.putPage('threads/acme-example', {
      type: 'email',
      title: 'Acme thread',
      compiled_truth: 'shipped the widget',
    }, { sourceId: 'mail' });
    await engine.putPage('archive/old-note', {
      type: 'note',
      title: 'Old note',
      compiled_truth: 'from earlier in the week',
    }, { sourceId: 'notes' });
    await engine.executeRaw(
      `UPDATE pages SET updated_at = now() - interval '3 days', effective_date = NULL
       WHERE source_id = $1 AND slug = $2`,
      ['notes', 'archive/old-note'],
    );
    await engine.putPage('dream-cycle-summaries/noise', {
      type: 'note',
      title: 'Dream cycle noise',
      compiled_truth: 'generated earlier today',
      frontmatter: { dream_generated: true },
    }, { sourceId: 'notes' });

    const handlers = new Map<string, (job: any) => Promise<any>>();
    await registerBuiltinHandlers(
      { register(name: string, fn: (job: any) => Promise<any>) { handlers.set(name, fn); } } as never,
      engine,
    );
    const handler = handlers.get('autopilot-global-maintenance');
    expect(handler).toBeTruthy();

    const repoPath = mkdtempSync(join(tmpdir(), 'gbrain-daily-memory-'));
    await handler!({ id: 6347, data: { repoPath }, signal: undefined });

    const day = await resolveCycleDate(engine);
    const page = await engine.getPage(dailyMemorySlug(day), { sourceId: DAILY_MEMORY_SOURCE_ID });
    expect(page).not.toBeNull();
    expect(page!.frontmatter.dream_generated).toBe(true);
    expect(page!.frontmatter.dream_cycle_date).toBe(day);
    expect(page!.compiled_truth).toContain('[[notes:meetings/standup]]');
    expect(page!.compiled_truth).toContain('[[mail:threads/acme-example]]');
    expect(page!.compiled_truth).toContain('## notes');
    expect(page!.compiled_truth).toContain('## mail');
    expect(page!.compiled_truth).not.toContain('archive/old-note');
    expect(page!.compiled_truth).not.toContain('Dream cycle noise');
    expect(page!.compiled_truth).not.toContain('talked about the rollout');
  }, 120_000);

  async function seedTodayPage(): Promise<void> {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ($1, $1)`,
      ['notes'],
    );
    await engine.putPage('meetings/standup', {
      type: 'meeting',
      title: 'Standup',
      compiled_truth: 'talked about the rollout',
    }, { sourceId: 'notes' });
  }

  test('timestamped effective dates use Manila while date-only values keep their calendar day', async () => {
    await engine.setConfig('cycle.timezone', 'Asia/Manila');
    for (const [slug, date] of [
      ['notes/instant', '2026-09-30T00:30:00+08:00'],
      ['notes/calendar', '2026-09-30'],
      ['notes/previous-calendar', '2026-09-29'],
    ]) {
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'body', frontmatter: { event_date: date } });
      const effective = computeEffectiveDate({ slug, frontmatter: { event_date: date }, createdAt: new Date(), updatedAt: new Date() });
      await engine.executeRaw(`UPDATE pages SET effective_date = $1, effective_date_source = $2 WHERE slug = $3`, [effective.date!.toISOString(), effective.source, slug]);
    }
    await writeDailyMemoryFromSources(engine, { date: '2026-09-30' });
    const page = await engine.getPage(dailyMemorySlug('2026-09-30'));
    expect(page!.compiled_truth).toContain('[[default:notes/instant]]');
    expect(page!.compiled_truth).toContain('[[default:notes/calendar]]');
    expect(page!.compiled_truth).not.toContain('[[default:notes/previous-calendar]]');
    await writeDailyMemoryFromSources(engine, { date: '2026-09-29' });
    const previous = await engine.getPage(dailyMemorySlug('2026-09-29'));
    expect(previous!.compiled_truth).not.toContain('[[default:notes/instant]]');
  });

  test('imported unquoted YAML calendar dates survive JSON storage while midnight datetimes remain instants', async () => {
    await engine.setConfig('cycle.timezone', 'America/Los_Angeles');
    for (const [slug, value] of [
      ['notes/yaml-calendar', '2026-09-30'],
      ['notes/yaml-utc-midnight', '2026-09-30T00:00:00Z'],
      ['notes/yaml-local-midnight', '2026-09-30T00:00:00-07:00'],
    ]) {
      await importFromContent(engine, slug, `---\ndate: ${value}\n---\n# Fixture\n\nA dated fixture.\n`, { noEmbed: true });
    }
    const imported = await engine.getPage('notes/yaml-calendar');
    expect(imported!.frontmatter.date).toBe('2026-09-30');
    await writeDailyMemoryFromSources(engine, { date: '2026-09-30' });
    const today = await engine.getPage(dailyMemorySlug('2026-09-30'));
    expect(today!.compiled_truth).toContain('[[default:notes/yaml-calendar]]');
    expect(today!.compiled_truth).toContain('[[default:notes/yaml-local-midnight]]');
    expect(today!.compiled_truth).not.toContain('[[default:notes/yaml-utc-midnight]]');
    await writeDailyMemoryFromSources(engine, { date: '2026-09-29' });
    const previous = await engine.getPage(dailyMemorySlug('2026-09-29'));
    expect(previous!.compiled_truth).toContain('[[default:notes/yaml-utc-midnight]]');
    expect(previous!.compiled_truth).not.toContain('[[default:notes/yaml-calendar]]');
    expect(previous!.compiled_truth).not.toContain('[[default:notes/yaml-local-midnight]]');
  });

  test('UTC-midnight timestamps and fallback anchors use the local day west of UTC', async () => {
    await engine.setConfig('cycle.timezone', 'America/Los_Angeles');
    await engine.putPage('notes/midnight', { type: 'note', title: 'Midnight', compiled_truth: 'body', frontmatter: { date: '2026-09-30T00:00:00Z' } });
    await engine.putPage('notes/calendar-value', { type: 'note', title: 'Calendar', compiled_truth: 'body', frontmatter: { date: '2026-09-30' } });
    await engine.executeRaw(`UPDATE pages SET effective_date = '2026-09-30T00:00:00Z', effective_date_source = 'date' WHERE slug IN ('notes/midnight', 'notes/calendar-value')`);
    await engine.putPage('notes/anchor', { type: 'note', title: 'Anchor', compiled_truth: 'body' });
    await engine.executeRaw(`UPDATE pages SET effective_date = '2026-09-30T00:00:00Z', effective_date_source = 'fallback' WHERE slug = 'notes/anchor'`);
    await writeDailyMemoryFromSources(engine, { date: '2026-09-29' });
    const page = await engine.getPage(dailyMemorySlug('2026-09-29'));
    expect(page!.compiled_truth).toContain('[[default:notes/midnight]]');
    expect(page!.compiled_truth).toContain('[[default:notes/anchor]]');
    expect(page!.compiled_truth).not.toContain('[[default:notes/calendar-value]]');
  });

  test('legacy serialized calendar scalars retain their day while fresh identical instants use the zone', async () => {
    await engine.setConfig('cycle.timezone', 'America/Los_Angeles');
    const iso = '2026-09-30T00:00:00.000Z';
    await engine.putPage('notes/legacy-calendar', {
      type: 'note', title: 'Legacy calendar', compiled_truth: 'fixture', frontmatter: { date: iso },
    });
    await engine.executeRaw(`UPDATE pages SET effective_date=$1::timestamptz, effective_date_source='date',
      frontmatter=jsonb_build_object('date',$2::text) WHERE slug='notes/legacy-calendar'`, [iso, iso]);
    // A normal read-modify-write must not promote the historical value.
    await engine.putPage('notes/legacy-calendar', { ...(await engine.getPage('notes/legacy-calendar'))!, compiled_truth: 'edited fixture' });
    await importFromContent(engine, 'notes/fresh-iso-instant', `---\ndate: "${iso}"\n---\n# Fixture\n\nExplicit timestamp.\n`, { noEmbed: true });
    await engine.putPage('notes/fresh-date-object', {
      type: 'note', title: 'Fresh date object', compiled_truth: 'fixture', frontmatter: { date: new Date(iso) },
      effective_date: new Date(iso), effective_date_source: 'date',
    });
    await writeDailyMemoryFromSources(engine, { date: '2026-09-30' });
    const today = await engine.getPage(dailyMemorySlug('2026-09-30'));
    expect(today!.compiled_truth).toContain('[[default:notes/legacy-calendar]]');
    expect(today!.compiled_truth).not.toContain('[[default:notes/fresh-iso-instant]]');
    expect(today!.compiled_truth).not.toContain('[[default:notes/fresh-date-object]]');
    await writeDailyMemoryFromSources(engine, { date: '2026-09-29' });
    const previous = await engine.getPage(dailyMemorySlug('2026-09-29'));
    expect(previous!.compiled_truth).not.toContain('[[default:notes/legacy-calendar]]');
    expect(previous!.compiled_truth).toContain('[[default:notes/fresh-iso-instant]]');
    expect(previous!.compiled_truth).toContain('[[default:notes/fresh-date-object]]');
    const edited = (await engine.getPage('notes/fresh-date-object'))!;
    await engine.putPage('notes/fresh-date-object', {
      ...edited, frontmatter: { ...edited.frontmatter, date: '2026-09-30' },
    });
    await writeDailyMemoryFromSources(engine, { date: '2026-09-30' });
    expect((await engine.getPage(dailyMemorySlug('2026-09-30')))!.compiled_truth)
      .toContain('[[default:notes/fresh-date-object]]');
  });

  test('replacement frontmatter retains known instant provenance and explicit calendar edits clear it', async () => {
    await engine.setConfig('cycle.timezone', 'America/Los_Angeles');
    const iso = '2026-09-30T00:00:00.000Z';
    const input = {
      type: 'note', title: 'Replacement fixture', compiled_truth: 'fixture',
      frontmatter: { date: iso }, effective_date: new Date(iso), effective_date_source: 'date' as const,
    };
    await engine.putPage('notes/replacement-instant', input);
    // Programmatic callers need not carry internal metadata in replacement frontmatter.
    await engine.putPage('notes/replacement-instant', { ...input, compiled_truth: 'edited fixture' });
    expect((await engine.getPage('notes/replacement-instant'))!.frontmatter[DATE_INSTANT_PROVENANCE])
      .toEqual({ date: iso });
    await writeDailyMemoryFromSources(engine, { date: '2026-09-29' });
    expect((await engine.getPage(dailyMemorySlug('2026-09-29')))!.compiled_truth)
      .toContain('[[default:notes/replacement-instant]]');
    await writeDailyMemoryFromSources(engine, { date: '2026-09-30' });
    expect(await engine.getPage(dailyMemorySlug('2026-09-30'))).toBeNull();
    await engine.putPage('notes/replacement-instant', { ...input, frontmatter: { date: '2026-09-30' } });
    expect((await engine.getPage('notes/replacement-instant'))!.frontmatter[DATE_INSTANT_PROVENANCE])
      .toBeUndefined();
    await writeDailyMemoryFromSources(engine, { date: '2026-09-30' });
    expect((await engine.getPage(dailyMemorySlug('2026-09-30')))!.compiled_truth)
      .toContain('[[default:notes/replacement-instant]]');
  });

  test('transcript ingest fails closed when daily-memory handoff is rejected', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-transcript-handoff-fail-'));
    const file = join(dir, 'session.jsonl');
    const timestamp = '2026-02-01T12:00:00.000Z';
    writeFileSync(file, [
      { timestamp, type: 'session_meta', payload: { id: 'handoff-fail-fixture', session_id: 'handoff-fail-fixture', timestamp, cwd: dir } },
      { timestamp, type: 'event_msg', payload: { type: 'user_message', message: 'Handoff failure fixture.' } },
      { timestamp, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixture acknowledged.' }] } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    const failure = spyOn(MinionQueue.prototype, 'add').mockRejectedValue(new Error('fixture queue unavailable'));
    try {
      const result = await runTranscriptsIngest(engine, {
        paths: [file], format: 'codex', sourceId: 'default',
      });
      expect(result.cleanScan).toBe(false);
      expect(result.dailyMemoryError).toMatch(/fixture queue unavailable|Daily-memory transcript ingest handoff rejected|Daily memory/);
      const page = await engine.executeRaw("SELECT slug FROM pages WHERE source_id='default' AND deleted_at IS NULL");
      expect(page.length).toBeGreaterThan(0);
    } finally {
      failure.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('transcript ingest queues affected-day refreshes for historical session dates', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-transcript-daily-handoff-'));
    const file = join(dir, 'session.jsonl');
    const timestamp = '2026-01-15T12:00:00.000Z';
    writeFileSync(file, [
      { timestamp, type: 'session_meta', payload: { id: 'historical-day-fixture', session_id: 'historical-day-fixture', timestamp, cwd: dir } },
      { timestamp, type: 'event_msg', payload: { type: 'user_message', message: 'Historical daily index fixture.' } },
      { timestamp, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixture acknowledged.' }] } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    try {
      expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE name='autopilot-daily-memory'")).toHaveLength(0);
      const ingested = await runTranscriptsIngest(engine, {
        paths: [file], format: 'codex', sourceId: 'default',
      });
      expect(ingested.pages.imported).toBe(1);
      expect(ingested.cleanScan).toBe(true);
      const batches = await engine.executeRaw<{ data: { daily_memory_dates?: string[] } }>(
        "SELECT data FROM minion_jobs WHERE name='autopilot-daily-memory'");
      expect(batches.some(row => row.data.daily_memory_dates?.includes('2026-01-15'))).toBe(true);
      const accepted = await engine.executeRaw('SELECT id FROM minion_jobs ORDER BY id');
      const unchanged = await runTranscriptsIngest(engine, { paths: [file], format: 'codex', sourceId: 'default' });
      expect(unchanged.pages.imported).toBe(0);
      expect(unchanged.pages.skipped).toBe(1);
      expect(unchanged.slugsTouched).toEqual(ingested.slugsTouched);
      expect(unchanged.cleanScan).toBe(true);
      expect(await engine.executeRaw('SELECT id FROM minion_jobs ORDER BY id')).toEqual(accepted);

    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const changedPaths of [false, true]) test(`transcript refresh rejection recovers with changed paths=${changedPaths} without losing clean-scan failure`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-transcript-retry-'));
    const file = join(dir, 'session.jsonl'), timestamp = '2026-01-16T12:00:00.000Z';
    writeFileSync(file, [
      { timestamp, type: 'session_meta', payload: { id: 'retry-day-fixture', timestamp, cwd: dir } },
      { timestamp, type: 'event_msg', payload: { type: 'user_message', message: 'Synthetic retry fixture.' } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    const opts = { paths: [file], format: 'codex' as const, sourceId: 'default' };
    try {
      const rejected = spyOn(MinionQueue.prototype, 'add').mockImplementation(async () => { throw new Error('Synthetic transcript refresh rejection'); });
      try {
        const first = await runTranscriptsIngest(engine, opts);
        expect(first.pages.imported).toBe(1);
        expect(first.cleanScan).toBe(false);
      } finally { rejected.mockRestore(); }
      expect(await engine.executeRaw("SELECT path FROM op_checkpoint_paths WHERE op='transcript-ingest-daily-memory' AND path::jsonb->>'value' LIKE 'slug:%'")).toHaveLength(1);
      let retryOpts = opts;
      if (changedPaths) {
        const next = join(dir, 'next.jsonl'), nextTimestamp = '2026-01-17T12:00:00.000Z';
        writeFileSync(next, [
          { timestamp: nextTimestamp, type: 'session_meta', payload: { id: 'next-day-fixture', timestamp: nextTimestamp, cwd: dir } },
          { timestamp: nextTimestamp, type: 'event_msg', payload: { type: 'user_message', message: 'Synthetic next fixture.' } },
        ].map(row => JSON.stringify(row)).join('\n') + '\n');
        rmSync(file);
        retryOpts = { ...opts, paths: [next] };
      }
      const retried = await runTranscriptsIngest(engine, retryOpts);
      expect(retried.pages.imported).toBe(changedPaths ? 1 : 0);
      expect(retried.pages.skipped).toBe(changedPaths ? 0 : 1);
      expect(retried.cleanScan).toBe(true);
      const jobs = await engine.executeRaw<{ data: { daily_memory_dates?: string[] } }>("SELECT data FROM minion_jobs WHERE name='autopilot-daily-memory'");
      expect(jobs.some(row => row.data.daily_memory_dates?.includes('2026-01-16'))).toBe(true);
      if (changedPaths) expect(jobs.some(row => row.data.daily_memory_dates?.includes('2026-01-17'))).toBe(true);
      expect(await engine.executeRaw("SELECT path FROM op_checkpoint_paths WHERE op='transcript-ingest-daily-memory'")).toHaveLength(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('transcript acceptance preserves a concurrent invocation bank for its own later handoff', async () => {
    await engine.putPage('notes/first-transcript-debt', { type: 'note', title: 'First fixture', compiled_truth: 'Synthetic fixture', frontmatter: { date: '2026-01-18' } });
    await engine.putPage('notes/concurrent-transcript-debt', { type: 'note', title: 'Concurrent fixture', compiled_truth: 'Synthetic fixture', frontmatter: { date: '2026-01-19' } });
    await engine.executeRaw("UPDATE pages SET effective_date=(frontmatter->>'date')::date::timestamptz,effective_date_source='date' WHERE source_id='default' AND slug=ANY($1::text[])", [['notes/first-transcript-debt', 'notes/concurrent-transcript-debt']]);
    const first = (await createTranscriptIngestDailyMemory(engine, { sourceId: 'default', runKey: 'first' }))!;
    const concurrent = (await createTranscriptIngestDailyMemory(engine, { sourceId: 'default', runKey: 'concurrent' }))!;
    await first.touched(['notes/first-transcript-debt']);
    const add = MinionQueue.prototype.add;
    let appended = false;
    const during = spyOn(MinionQueue.prototype, 'add').mockImplementation(async function(this: MinionQueue, name, data, opts) {
      if (name === 'autopilot-daily-memory' && !appended) {
        appended = true;
        await concurrent.touched(['notes/concurrent-transcript-debt']);
      }
      return add.call(this, name, data, opts);
    });
    try { await first.finish(); } finally { during.mockRestore(); }
    expect(await engine.executeRaw("SELECT path FROM op_checkpoint_paths WHERE op='transcript-ingest-daily-memory' AND path::jsonb->>'value'='slug:notes/concurrent-transcript-debt'")).toHaveLength(1);
    await concurrent.finish();
    const jobs = await engine.executeRaw<{ data: { daily_memory_dates?: string[] } }>("SELECT data FROM minion_jobs WHERE name='autopilot-daily-memory'");
    expect(jobs.some(row => row.data.daily_memory_dates?.includes('2026-01-19'))).toBe(true);
    expect(await engine.executeRaw("SELECT path FROM op_checkpoint_paths WHERE op='transcript-ingest-daily-memory'")).toHaveLength(0);
  });

  test('expired running lease lets a peer adopt abandoned before: debt', async () => {
    await engine.putPage('notes/abandoned-transcript', { type: 'note', title: 'Abandoned', compiled_truth: 'Synthetic fixture', frontmatter: { date: '2026-01-23' } });
    await engine.executeRaw("UPDATE pages SET effective_date=(frontmatter->>'date')::date::timestamptz,effective_date_source='date' WHERE source_id='default' AND slug='notes/abandoned-transcript'");
    const crashed = (await createTranscriptIngestDailyMemory(engine, { sourceId: 'default', runKey: 'crashed' }))!;
    await crashed.before(['notes/abandoned-transcript']);
    // Simulate write-then-crash: page revises and the calendar day moves while
    // the origin's lease expires without finish()/release().
    await engine.putPage('notes/abandoned-transcript', { type: 'note', title: 'Abandoned', compiled_truth: 'Synthetic fixture changed', frontmatter: { date: '2026-01-24' } });
    await engine.executeRaw("UPDATE pages SET effective_date=(frontmatter->>'date')::date::timestamptz,effective_date_source='date' WHERE source_id='default' AND slug='notes/abandoned-transcript'");
    const markers = await engine.executeRaw<{ path: string }>(
      "SELECT path FROM op_checkpoint_paths WHERE op='transcript-ingest-daily-memory' AND path::jsonb->>'value' LIKE 'running%'");
    expect(markers.length).toBeGreaterThan(0);
    for (const row of markers) {
      const wrapped = JSON.parse(row.path) as { origin: string; value: string };
      const expired = JSON.stringify({ origin: wrapped.origin, value: `running:${new Date(Date.now() - 31 * 60_000).toISOString()}` });
      await engine.executeRawDirect('UPDATE op_checkpoint_paths SET path=$1 WHERE path=$2', [expired, row.path]);
      // completed_keys stores the same wrapped strings; swap so UNION cannot see a live lease.
      await engine.executeRawDirect(
        "UPDATE op_checkpoints SET completed_keys=(completed_keys-$1::text[])||$2::jsonb WHERE op='transcript-ingest-daily-memory'",
        [[row.path], JSON.stringify([expired])]);
    }
    // Peer finish adopts the expired origin and queues prior + new dates.
    const peer = (await createTranscriptIngestDailyMemory(engine, { sourceId: 'default', runKey: 'peer' }))!;
    await peer.finish();
    const jobs = await engine.executeRaw<{ data: { daily_memory_dates?: string[] } }>("SELECT data FROM minion_jobs WHERE name='autopilot-daily-memory'");
    expect(jobs.some(row => row.data.daily_memory_dates?.includes('2026-01-23'))).toBe(true);
    expect(jobs.some(row => row.data.daily_memory_dates?.includes('2026-01-24'))).toBe(true);
    expect(await engine.executeRaw("SELECT path FROM op_checkpoint_paths WHERE op='transcript-ingest-daily-memory'")).toHaveLength(0);
  });

  test('future-dated running lease lets a peer adopt abandoned before: debt', async () => {
    await engine.putPage('notes/future-lease-transcript', { type: 'note', title: 'Future lease', compiled_truth: 'Synthetic fixture', frontmatter: { date: '2026-01-26' } });
    await engine.executeRaw("UPDATE pages SET effective_date=(frontmatter->>'date')::date::timestamptz,effective_date_source='date' WHERE source_id='default' AND slug='notes/future-lease-transcript'");
    const crashed = (await createTranscriptIngestDailyMemory(engine, { sourceId: 'default', runKey: 'future-crash' }))!;
    await crashed.before(['notes/future-lease-transcript']);
    await engine.putPage('notes/future-lease-transcript', { type: 'note', title: 'Future lease', compiled_truth: 'Synthetic fixture changed', frontmatter: { date: '2026-01-27' } });
    await engine.executeRaw("UPDATE pages SET effective_date=(frontmatter->>'date')::date::timestamptz,effective_date_source='date' WHERE source_id='default' AND slug='notes/future-lease-transcript'");
    const markers = await engine.executeRaw<{ path: string }>(
      "SELECT path FROM op_checkpoint_paths WHERE op='transcript-ingest-daily-memory' AND path::jsonb->>'value' LIKE 'running%'");
    expect(markers.length).toBeGreaterThan(0);
    for (const row of markers) {
      const wrapped = JSON.parse(row.path) as { origin: string; value: string };
      const future = JSON.stringify({ origin: wrapped.origin, value: `running:${new Date(Date.now() + 8 * 86400_000).toISOString()}` });
      await engine.executeRawDirect('UPDATE op_checkpoint_paths SET path=$1 WHERE path=$2', [future, row.path]);
      await engine.executeRawDirect(
        "UPDATE op_checkpoints SET completed_keys=(completed_keys-$1::text[])||$2::jsonb WHERE op='transcript-ingest-daily-memory'",
        [[row.path], JSON.stringify([future])]);
    }
    const peer = (await createTranscriptIngestDailyMemory(engine, { sourceId: 'default', runKey: 'peer-future' }))!;
    await peer.finish();
    const jobs = await engine.executeRaw<{ data: { daily_memory_dates?: string[] } }>("SELECT data FROM minion_jobs WHERE name='autopilot-daily-memory'");
    expect(jobs.some(row => row.data.daily_memory_dates?.includes('2026-01-26'))).toBe(true);
    expect(jobs.some(row => row.data.daily_memory_dates?.includes('2026-01-27'))).toBe(true);
    expect(await engine.executeRaw("SELECT path FROM op_checkpoint_paths WHERE op='transcript-ingest-daily-memory'")).toHaveLength(0);
  });

  test('renew refreshes the running lease so peers keep seeing the origin live', async () => {
    const live = (await createTranscriptIngestDailyMemory(engine, { sourceId: 'default', runKey: 'live' }))!;
    const before = await engine.executeRaw<{ path: string }>(
      "SELECT path FROM op_checkpoint_paths WHERE op='transcript-ingest-daily-memory' AND path::jsonb->>'value' LIKE 'running:%'");
    expect(before).toHaveLength(1);
    // Age the DB stamp past expiry while in-memory runningValue still holds the
    // pre-age value. renew must scrub that orphan and keep exactly one fresh lease.
    const wrapped = JSON.parse(before[0]!.path) as { origin: string; value: string };
    const aged = JSON.stringify({ origin: wrapped.origin, value: `running:${new Date(Date.now() - 31 * 60_000).toISOString()}` });
    await engine.executeRawDirect('UPDATE op_checkpoint_paths SET path=$1 WHERE path=$2', [aged, before[0]!.path]);
    await live.renew();
    const refreshed = await engine.executeRaw<{ path: string }>(
      "SELECT path FROM op_checkpoint_paths WHERE op='transcript-ingest-daily-memory' AND path::jsonb->>'value' LIKE 'running:%'");
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0]!.path).not.toBe(aged);
    const stamp = Date.parse(JSON.parse(refreshed[0]!.path).value.slice('running:'.length));
    expect(Date.now() - stamp).toBeLessThan(5_000);
    await engine.putPage('notes/live-transcript', { type: 'note', title: 'Live', compiled_truth: 'Synthetic fixture', frontmatter: { date: '2026-01-25' } });
    await engine.executeRaw("UPDATE pages SET effective_date=(frontmatter->>'date')::date::timestamptz,effective_date_source='date' WHERE source_id='default' AND slug='notes/live-transcript'");
    await live.before(['notes/live-transcript']);
    const peer = (await createTranscriptIngestDailyMemory(engine, { sourceId: 'default', runKey: 'peer-live' }))!;
    await peer.finish();
    // Peer must not adopt live's before: while the renewed lease is fresh.
    expect(await engine.executeRaw(
      "SELECT path FROM op_checkpoint_paths WHERE op='transcript-ingest-daily-memory' AND path::jsonb->>'value' LIKE 'before:%'")).toHaveLength(1);
    await live.finish();
    expect(await engine.executeRaw("SELECT path FROM op_checkpoint_paths WHERE op='transcript-ingest-daily-memory'")).toHaveLength(0);
  });

  test('failed renew keeps prior lease until success; release clears every running marker', async () => {
    const live = (await createTranscriptIngestDailyMemory(engine, { sourceId: 'default', runKey: 'renew-fail' }))!;
    const before = await engine.executeRaw<{ path: string }>(
      "SELECT path FROM op_checkpoint_paths WHERE op='transcript-ingest-daily-memory' AND path::jsonb->>'value' LIKE 'running%'");
    expect(before).toHaveLength(1);
    const prior = before[0]!.path;
    let deletes = 0;
    const direct = engine.executeRawDirect.bind(engine);
    const spy = spyOn(engine, 'executeRawDirect').mockImplementation(async (sql: string, params?: unknown[]) => {
      if (typeof sql === 'string' && sql.includes("path::jsonb->>'value' LIKE 'running:%'") && sql.includes('DELETE')) {
        deletes += 1;
        if (deletes === 1) throw new Error('Synthetic renew delete failure');
      }
      return direct(sql, params);
    });
    try {
      await expect(live.renew()).rejects.toThrow('Synthetic renew delete failure');
    } finally {
      spy.mockRestore();
    }
    // Prior marker must still be present (runningValue was not advanced past a failed renew).
    const afterFail = await engine.executeRaw<{ path: string }>(
      "SELECT path FROM op_checkpoint_paths WHERE op='transcript-ingest-daily-memory' AND path::jsonb->>'value' LIKE 'running%'");
    expect(afterFail.some(row => row.path === prior)).toBe(true);
    await live.release();
    expect(await engine.executeRaw(
      "SELECT path FROM op_checkpoint_paths WHERE op='transcript-ingest-daily-memory' AND path::jsonb->>'value' LIKE 'running%'")).toHaveLength(0);
  });

  test('renew and release skip legacy unwrapped checkpoint rows without JSON cast errors', async () => {
    const { createHash } = await import('node:crypto');
    const runKey = 'legacy-unwrapped';
    const legacyFingerprint = createHash('sha256').update(JSON.stringify(['default', runKey])).digest('hex').slice(0, 16);
    const legacyBefore = 'before:' + JSON.stringify({
      targets: [{ slug: 'notes/legacy-unwrapped', revision: null }],
      days: ['2026-01-09'],
    });
    await engine.executeRawDirect(
      `INSERT INTO op_checkpoints (op, fingerprint, completed_keys, updated_at)
       VALUES ('transcript-ingest-daily-memory', $1, $2::jsonb, now())
       ON CONFLICT (op, fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys, updated_at=now()`,
      [legacyFingerprint, JSON.stringify([legacyBefore, 'slug:notes/legacy-unwrapped'])]);
    await engine.executeRawDirect(
      `INSERT INTO op_checkpoint_paths (op, fingerprint, path) VALUES
         ('transcript-ingest-daily-memory', $1, $2),
         ('transcript-ingest-daily-memory', $1, 'slug:notes/legacy-unwrapped')
       ON CONFLICT DO NOTHING`,
      [legacyFingerprint, legacyBefore]);
    await engine.putPage('notes/legacy-unwrapped', { type: 'note', title: 'Legacy', compiled_truth: 'Synthetic fixture', frontmatter: { date: '2026-01-09' } });
    await engine.executeRaw("UPDATE pages SET effective_date=$1::date::timestamptz,effective_date_source='date' WHERE slug=$2 AND source_id='default'", ['2026-01-09', 'notes/legacy-unwrapped']);
    const live = (await createTranscriptIngestDailyMemory(engine, { sourceId: 'default', runKey }))!;
    // Pre-fix: casting unwrapped legacy paths threw and wedged renew/release.
    await expect(live.renew()).resolves.toBeUndefined();
    await expect(live.release()).resolves.toBeUndefined();
    const [retainedLegacy] = await engine.executeRaw<{ completed_keys: string[] }>(
      "SELECT completed_keys FROM op_checkpoints WHERE op='transcript-ingest-daily-memory' AND fingerprint=$1", [legacyFingerprint]);
    expect(retainedLegacy!.completed_keys).toContain(legacyBefore);
    expect(retainedLegacy!.completed_keys).toContain('slug:notes/legacy-unwrapped');
    const recovery = (await createTranscriptIngestDailyMemory(engine, { sourceId: 'default', runKey }))!;
    await recovery.finish();
    expect(await engine.executeRaw(
      "SELECT path FROM op_checkpoint_paths WHERE op='transcript-ingest-daily-memory' AND fingerprint=$1",
      [legacyFingerprint])).toHaveLength(0);
    expect(await engine.executeRaw(
      "SELECT id FROM minion_jobs WHERE name='autopilot-daily-memory' AND data->>'daily_memory_date'='2026-01-09'")).not.toHaveLength(0);
  });

  test('renew deletes obsolete running markers by origin predicate without reading unrelated debt', async () => {
    const live = (await createTranscriptIngestDailyMemory(engine, { sourceId: 'default', runKey: 'renew-predicate' }))!;
    await live.before(['notes/renew-predicate']);
    await engine.putPage('notes/renew-predicate', { type: 'note', title: 'Renew predicate', compiled_truth: 'Synthetic fixture', frontmatter: { date: '2026-01-28' } });
    await engine.executeRaw("UPDATE pages SET effective_date=(frontmatter->>'date')::date::timestamptz,effective_date_source='date' WHERE source_id='default' AND slug='notes/renew-predicate'");
    const selects: string[] = [];
    const execute = engine.executeRaw.bind(engine);
    const spy = spyOn(engine, 'executeRaw').mockImplementation(async function<T>(this: typeof engine, sql: string, params?: unknown[]): Promise<T[]> {
      if (typeof sql === 'string' && sql.includes('SELECT path FROM op_checkpoint_paths') && sql.includes('UNION')) {
        selects.push(sql);
      }
      return execute(sql, params) as Promise<T[]>;
    });
    try {
      await live.renew();
    } finally {
      spy.mockRestore();
    }
    expect(selects).toHaveLength(0);
    const markers = await engine.executeRaw<{ path: string }>(
      "SELECT path FROM op_checkpoint_paths WHERE op='transcript-ingest-daily-memory' AND path::jsonb->>'value' LIKE 'running%'");
    expect(markers).toHaveLength(1);
    await live.finish();
  });

  test('in-flight part write keeps renewing the transcript lease until import settles', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-transcript-part-lease-'));
    const file = join(dir, 'session.jsonl');
    const timestamp = '2026-01-26T12:00:00.000Z';
    writeFileSync(file, [
      { timestamp, type: 'session_meta', payload: { id: 'part-lease-fixture', session_id: 'part-lease-fixture', timestamp, cwd: dir } },
      { timestamp, type: 'event_msg', payload: { type: 'user_message', message: 'Part lease fixture.' } },
      { timestamp, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixture acknowledged.' }] } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    let enter!: () => void, settle!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const deferred = new Promise<void>(resolve => { settle = resolve; });
    const callbacks: Array<() => unknown> = [];
    const originalInterval = globalThis.setInterval;
    const timers = spyOn(globalThis, 'setInterval').mockImplementation(((callback: (...args: unknown[]) => void, delay: number, ...args: unknown[]) => {
      if (delay === 10 * 60_000) callbacks.push(() => callback(...args));
      return originalInterval(callback, delay, ...args);
    }) as typeof setInterval);
    const importer = spyOn(await import('../src/core/import-file.ts'), 'importFromContent').mockImplementation(async (...args) => {
      enter();
      await deferred;
      importer.mockRestore();
      return importFromContent(...args);
    });
    const run = runTranscriptsIngest(engine, { paths: [file], format: 'codex', sourceId: 'default' });
    try {
      await entered;
      expect(callbacks).toHaveLength(1);
      const before = await engine.executeRaw<{ path: string }>(
        "SELECT path FROM op_checkpoint_paths WHERE op='transcript-ingest-daily-memory' AND path::jsonb->>'value' LIKE 'running:%'");
      expect(before).toHaveLength(1);
      const wrapped = JSON.parse(before[0]!.path) as { origin: string; value: string };
      const aged = JSON.stringify({ origin: wrapped.origin, value: `running:${new Date(Date.now() - 31 * 60_000).toISOString()}` });
      await engine.executeRawDirect('UPDATE op_checkpoint_paths SET path=$1 WHERE path=$2', [aged, before[0]!.path]);
      await callbacks[0]!();
      const after = await engine.executeRaw<{ path: string }>(
        "SELECT path FROM op_checkpoint_paths WHERE op='transcript-ingest-daily-memory' AND path::jsonb->>'value' LIKE 'running:%'");
      expect(after).toHaveLength(1);
      expect(after[0]!.path).not.toBe(aged);
      const peer = (await createTranscriptIngestDailyMemory(engine, { sourceId: 'default', runKey: 'peer-part-lease' }))!;
      await peer.finish();
      expect(await engine.executeRaw(
        "SELECT path FROM op_checkpoint_paths WHERE op='transcript-ingest-daily-memory' AND path::jsonb->>'value' LIKE 'before:%'")).toHaveLength(1);
      settle();
      const result = await run;
      expect(result.pages.imported).toBe(1);
      expect(result.cleanScan).toBe(true);
    } finally {
      settle();
      await run.catch(() => undefined);
      timers.mockRestore();
      if (importer.mock) importer.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('atomic stale deletion re-banks adopted prior dates without a rendered daily index', async () => {
    const slug = 'notes/adopted-delete', day = '2026-01-17';
    await engine.putPage(slug, { type: 'note', title: 'Adopted deletion fixture', compiled_truth: 'Synthetic fixture', frontmatter: { date: day } });
    await engine.executeRaw("UPDATE pages SET effective_date=$1::date::timestamptz,effective_date_source='date' WHERE slug=$2 AND source_id='default'", [day, slug]);
    const live = (await createTranscriptIngestDailyMemory(engine, { sourceId: 'default', runKey: 'adopted-delete' }))!;
    await live.before([slug]);
    const [marker] = await engine.executeRaw<{ path: string }>("SELECT path FROM op_checkpoint_paths WHERE op='transcript-ingest-daily-memory' AND path::jsonb->>'value' LIKE 'running:%'");
    const wrapped = JSON.parse(marker!.path) as { origin: string; value: string };
    const aged = JSON.stringify({ origin: wrapped.origin, value: `running:${new Date(Date.now() - 31 * 60_000).toISOString()}` });
    await engine.executeRawDirect('UPDATE op_checkpoint_paths SET path=$1 WHERE path=$2', [aged, marker!.path]);
    const peer = (await createTranscriptIngestDailyMemory(engine, { sourceId: 'default', runKey: 'adopt-delete-peer' }))!;
    await peer.finish();
    expect(await engine.executeRaw("SELECT path FROM op_checkpoint_paths WHERE op='transcript-ingest-daily-memory' AND path::jsonb->>'value' LIKE 'before:%'")).toHaveLength(0);
    const [last] = await engine.executeRaw<{ id: number }>("SELECT max(id)::integer AS id FROM minion_jobs WHERE name='autopilot-daily-memory'");
    expect(await engine.getPage(dailyMemorySlug(day), { sourceId: DAILY_MEMORY_SOURCE_ID })).toBeNull();
    const originalTransaction = engine.transaction.bind(engine);
    const rejectedCommit = spyOn(engine, 'transaction').mockImplementation(fn => originalTransaction(async tx => {
      await fn(tx);
      throw new Error('synthetic pre-commit rejection');
    }));
    try {
      await expect(live.deleteStalePart(slug)).rejects.toThrow('synthetic pre-commit rejection');
      expect(await engine.getPage(slug)).not.toBeNull();
      expect(await engine.executeRaw("SELECT path FROM op_checkpoint_paths WHERE op='transcript-ingest-daily-memory' AND path::jsonb->>'value' LIKE 'before:%'")).toHaveLength(0);
    } finally { rejectedCommit.mockRestore(); }
    // No second before() call: failed commit must retain the cached original day.
    await live.deleteStalePart(slug);
    expect(await engine.getPage(slug)).toBeNull();
    await live.release();
    const recovery = (await createTranscriptIngestDailyMemory(engine, { sourceId: 'default', runKey: 'adopt-delete-recovery' }))!;
    await recovery.finish();
    expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE name='autopilot-daily-memory' AND data->>'daily_memory_date'=$1 AND id>$2", [day, last!.id])).not.toHaveLength(0);
  });

  test('committed transcript debt survives a peer retiring its older snapshot', async () => {
    const slug = 'notes/retiring-peer-delete', day = '2026-01-17';
    await engine.putPage(slug, { type: 'note', title: 'Peer retirement fixture', compiled_truth: 'Synthetic fixture', frontmatter: { date: day } });
    await engine.executeRaw("UPDATE pages SET effective_date=$1::date::timestamptz,effective_date_source='date' WHERE slug=$2 AND source_id='default'", [day, slug]);
    const live = (await createTranscriptIngestDailyMemory(engine, { sourceId: 'default', runKey: 'retiring-peer-delete' }))!;
    await live.before([slug]);
    const [marker] = await engine.executeRaw<{ path: string }>("SELECT path FROM op_checkpoint_paths WHERE op='transcript-ingest-daily-memory' AND path::jsonb->>'value' LIKE 'running:%'");
    const wrapped = JSON.parse(marker!.path) as { origin: string; value: string };
    const aged = JSON.stringify({ origin: wrapped.origin, value: `running:${new Date(Date.now() - 31 * 60_000).toISOString()}` });
    await engine.executeRawDirect('UPDATE op_checkpoint_paths SET path=$1 WHERE path=$2', [aged, marker!.path]);
    const peer = (await createTranscriptIngestDailyMemory(engine, { sourceId: 'default', runKey: 'retiring-peer' }))!;
    let pause!: () => void, settle!: () => void;
    const paused = new Promise<void>(resolve => { pause = resolve; });
    const deferred = new Promise<void>(resolve => { settle = resolve; });
    let held = false;
    const originalDirect = engine.executeRawDirect;
    const retirement = spyOn(engine, 'executeRawDirect').mockImplementation(async function <T = Record<string, unknown>>(this: PGLiteEngine, sql: string, params?: unknown[]): Promise<T[]> {
      if (!held && sql.includes('DELETE FROM op_checkpoint_paths') && sql.includes('path=ANY')) {
        held = true; pause(); await deferred;
      }
      // Transaction engines inherit this spy; preserve their own query handle.
      return (originalDirect<T>).call(this, sql, params);
    });
    const finish = peer.finish();
    try {
      await Promise.race([paused, finish.then(() => { throw new Error('peer finished before retirement pause'); })]);
      // Queue accepted, snapshot retirement not yet executed; no DB transaction is held.
      const [last] = await engine.executeRaw<{ id: number }>("SELECT max(id)::integer AS id FROM minion_jobs WHERE name='autopilot-daily-memory'");
      expect(last!.id).toBeGreaterThan(0);
      await live.deleteStalePart(slug);
      settle(); await finish;
      await live.release(); // Simulate a crash before this origin's finish.
      expect(await engine.getPage(slug)).toBeNull();
      const retained = await engine.executeRaw<{ path: string }>("SELECT path FROM op_checkpoint_paths WHERE op='transcript-ingest-daily-memory' AND path::jsonb->>'value' LIKE 'before:%'");
      expect(retained.some(row => JSON.parse(JSON.parse(row.path).value.slice(7)).days.includes(day))).toBe(true);
      const recovery = (await createTranscriptIngestDailyMemory(engine, { sourceId: 'default', runKey: 'retiring-peer-recovery' }))!;
      await recovery.finish();
      expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE name='autopilot-daily-memory' AND data->>'daily_memory_date'=$1 AND id>$2", [day, last!.id])).not.toHaveLength(0);
    } finally {
      settle(); await finish.catch(() => undefined);
      retirement.mockRestore(); await live.release();
    }
  });

  test('cancellation during atomic stale deletion rolls back the page and debt', async () => {
    const slug = 'notes/cancel-atomic-delete';
    await engine.putPage(slug, { type: 'note', title: 'Atomic cancellation fixture', compiled_truth: 'Synthetic fixture', frontmatter: { date: '2026-01-17' } });
    const controller = new AbortController();
    const live = (await createTranscriptIngestDailyMemory(engine, { sourceId: 'default', runKey: 'cancel-atomic-delete', signal: controller.signal }))!;
    await live.before([slug]);
    const originalTransaction = engine.transaction.bind(engine);
    const cancellation = spyOn(engine, 'transaction').mockImplementation(fn => originalTransaction(async tx => {
      const deletePage = tx.deletePage.bind(tx);
      tx.deletePage = async (...args) => {
        await deletePage(...args);
        controller.abort(new Error('synthetic debt bank cancellation'));
      };
      return fn(tx);
    }));
    try {
      await expect(live.deleteStalePart(slug)).rejects.toThrow('synthetic debt bank cancellation');
      expect(await engine.getPage(slug)).not.toBeNull();
      expect(await engine.executeRaw("SELECT path FROM op_checkpoint_paths WHERE op='transcript-ingest-daily-memory' AND path::jsonb->>'value'=$1", [`slug:${slug}`])).toHaveLength(0);
    } finally { cancellation.mockRestore(); await live.release(); }
  });

  for (const mutation of ['import', 'delete'] as const) {
    test(`transcript ${mutation} rolls back when atomic daily-memory debt banking fails after peer adoption`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'gbrain-transcript-atomic-bank-'));
      const file = join(dir, 'session.jsonl');
      const writeTranscript = (timestamp: string, message: string) => writeFileSync(file, [
        { timestamp, type: 'session_meta', payload: { id: 'atomic-bank-fixture', session_id: 'atomic-bank-fixture', timestamp, cwd: dir } },
        { timestamp, type: 'event_msg', payload: { type: 'user_message', message } },
        { timestamp, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixture acknowledged.' }] } },
      ].map(row => JSON.stringify(row)).join('\n') + '\n');
      const oldDay = '2026-01-14';
      writeTranscript(`${oldDay}T12:00:00.000Z`, 'Original atomic fixture.');
      const first = await runTranscriptsIngest(engine, { paths: [file], format: 'codex', sourceId: 'default' });
      const baseSlug = first.slugsTouched[0]!;
      const target = mutation === 'delete' ? `${baseSlug}-p2` : baseSlug;
      if (mutation === 'delete') {
        await engine.putPage(target, { type: 'note', title: 'Atomic stale fixture', compiled_truth: 'Synthetic stale fixture', frontmatter: { date: oldDay } });
        await engine.executeRaw("UPDATE pages SET effective_date=$1::date::timestamptz,effective_date_source='date' WHERE slug=$2 AND source_id='default'", [oldDay, target]);
      } else writeTranscript('2026-01-26T12:00:00.000Z', 'Changed atomic fixture.');
      const original = await engine.getPage(target);
      const leaseModule = await import('../src/core/transcripts/ingest-daily-memory.ts');
      const checkpointModule = await import('../src/core/op-checkpoint.ts');
      const originalCreate = leaseModule.createTranscriptIngestDailyMemory;
      const originalAppend = checkpointModule.appendCompleted;
      const originalAppendTx = checkpointModule.appendCompletedInTransaction;
      let adopted = false, bankFailureReady = false, lastId = 0;
      const leases = spyOn(leaseModule, 'createTranscriptIngestDailyMemory').mockImplementation(async (...args) => {
        const live = await originalCreate(...args);
        if (live) {
          const before = live.before.bind(live);
          live.before = async slugs => {
            await before(slugs);
            if (adopted || !slugs.includes(target)) return;
            adopted = true;
            const markers = await engine.executeRaw<{ path: string }>("SELECT path FROM op_checkpoint_paths WHERE op='transcript-ingest-daily-memory' AND path::jsonb->>'value' LIKE 'running:%'");
            for (const marker of markers) {
              const wrapped = JSON.parse(marker.path) as { origin: string; value: string };
              const aged = JSON.stringify({ origin: wrapped.origin, value: `running:${new Date(Date.now() - 31 * 60_000).toISOString()}` });
              await engine.executeRawDirect('UPDATE op_checkpoint_paths SET path=$1 WHERE path=$2', [aged, marker.path]);
            }
            const peer = (await originalCreate(engine, { sourceId: 'default', runKey: 'atomic-peer' }))!;
            await peer.finish();
            expect(await engine.executeRaw("SELECT path FROM op_checkpoint_paths WHERE op='transcript-ingest-daily-memory' AND path::jsonb->>'value' LIKE 'before:%'")).toHaveLength(0);
            const [last] = await engine.executeRaw<{ id: number }>("SELECT max(id)::integer AS id FROM minion_jobs WHERE name='autopilot-daily-memory'");
            lastId = last!.id;
            bankFailureReady = true;
          };
        }
        return live;
      });
      let rejected = false;
      const append = spyOn(checkpointModule, 'appendCompleted').mockImplementation(async (targetEngine, key, values) => {
        if (key.op === 'transcript-ingest-daily-memory' && bankFailureReady && values.some(value => JSON.parse(value).value === `slug:${target}`)) {
          rejected = true;
          return false;
        }
        return originalAppend(targetEngine, key, values);
      });
      const appendTx = typeof checkpointModule.appendCompletedInTransaction === 'function'
        ? spyOn(checkpointModule, 'appendCompletedInTransaction').mockImplementation(async (targetEngine, key, values) => {
        if (key.op === 'transcript-ingest-daily-memory' && bankFailureReady && values.some(value => JSON.parse(value).value === `slug:${target}`)) {
          rejected = true;
          throw new Error('Daily-memory transcript ingest checkpoint unavailable');
        }
        return originalAppendTx(targetEngine, key, values);
      }) : undefined;
      try {
        const outcome = await runTranscriptsIngest(engine, { paths: [file], format: 'codex', sourceId: 'default' })
          .then(result => ({ result, error: undefined as unknown }), error => ({ result: undefined, error }));
        expect(adopted).toBe(true);
        expect(rejected).toBe(true);
        if (mutation === 'import') {
          expect(outcome.error).toBeInstanceOf(Error);
          expect((outcome.error as Error).message).toContain('Daily-memory transcript ingest checkpoint unavailable');
        } else {
          expect(outcome.error).toBeUndefined();
          expect(outcome.result!.cleanScan).toBe(false);
          expect(outcome.result!.partsDeleted).toBe(0);
          expect(outcome.result!.pages.imported).toBe(0);
        }
        expect(await engine.getPage(target)).toEqual(original);
        append.mockRestore(); appendTx?.mockRestore(); leases.mockRestore();
        // A retry must recover the preserved old day and complete the mutation.
        const retry = await runTranscriptsIngest(engine, { paths: [file], format: 'codex', sourceId: 'default' });
        expect(retry.cleanScan).toBe(true);
        expect(mutation === 'delete' ? retry.partsDeleted : retry.pages.imported).toBe(1);
        expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE name='autopilot-daily-memory' AND data->>'daily_memory_date'=$1 AND id>$2", [oldDay, lastId])).not.toHaveLength(0);
      } finally {
        if (append.mock) append.mockRestore();
        if (appendTx?.mock) appendTx.mockRestore();
        if (leases.mock) leases.mockRestore();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test('stale-part delete rolls back when post-delete debt bank fails in-transaction', async () => {
    const day = '2026-01-11';
    const slug = 'notes/atomic-delete-bank';
    await engine.putPage(slug, { type: 'note', title: 'Atomic bank', compiled_truth: 'Synthetic fixture', frontmatter: { date: day } });
    await engine.executeRaw("UPDATE pages SET effective_date=$1::date::timestamptz,effective_date_source='date' WHERE slug=$2 AND source_id='default'", [day, slug]);
    const live = (await createTranscriptIngestDailyMemory(engine, { sourceId: 'default', runKey: 'atomic-delete-bank' }))!;
    await live.before([slug]);
    const before = await engine.executeRaw("SELECT path FROM op_checkpoint_paths WHERE op='transcript-ingest-daily-memory' AND path::jsonb->>'value' LIKE 'before:%'");
    expect(before.length).toBeGreaterThan(0);
    await expect(engine.transaction(async (tx) => {
      await tx.deletePage(slug, { sourceId: 'default' });
      // Force the transactional bank path to fail so delete cannot commit alone.
      const broken = Object.create(tx) as typeof tx;
      Object.defineProperty(broken, 'executeRaw', {
        value: async () => { throw new Error('synthetic transactional bank failure'); },
      });
      await live.beforeCommit(broken, slug);
    })).rejects.toThrow('synthetic transactional bank failure');
    expect(await engine.getPage(slug)).not.toBeNull();
    const retained = await engine.executeRaw("SELECT path FROM op_checkpoint_paths WHERE op='transcript-ingest-daily-memory' AND path::jsonb->>'value' LIKE 'before:%'");
    expect(retained.length).toBeGreaterThan(0);
    await live.release();
  });

  for (const failRenew of [false, true]) {
    test(`in-flight stale-part deletion preserves old-day debt with ${failRenew ? 'failed' : 'successful'} renewal`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'gbrain-transcript-delete-lease-'));
      const file = join(dir, 'session.jsonl'), nextFile = join(dir, 'next.jsonl');
      const timestamp = '2026-01-26T12:00:00.000Z', oldDay = '2026-01-14';
      const transcript = (id: string) => [
        { timestamp, type: 'session_meta', payload: { id, session_id: id, timestamp, cwd: dir } },
        { timestamp, type: 'event_msg', payload: { type: 'user_message', message: 'Deletion lease fixture.' } },
        { timestamp, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixture acknowledged.' }] } },
      ].map(row => JSON.stringify(row)).join('\n') + '\n';
      writeFileSync(file, transcript('delete-lease-fixture'));
      writeFileSync(nextFile, transcript('next-lease-fixture'));
      const initial = await runTranscriptsIngest(engine, { paths: [file], format: 'codex', sourceId: 'default' });
      const staleSlug = `${initial.slugsTouched[0]!}-p2`;
      await engine.putPage(staleSlug, { type: 'note', title: 'Stale part fixture', compiled_truth: 'Synthetic fixture', frontmatter: { date: oldDay } });
      await engine.executeRaw("UPDATE pages SET effective_date=$1::date::timestamptz,effective_date_source='date' WHERE slug=$2 AND source_id='default'", [oldDay, staleSlug]);
      // No rendered daily index exists for oldDay: post-delete slug lookup alone cannot recover it.
      expect(await engine.getPage(dailyMemorySlug(oldDay), { sourceId: DAILY_MEMORY_SOURCE_ID })).toBeNull();
      let enter!: () => void, settle!: () => void;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const deferred = new Promise<void>(resolve => { settle = resolve; });
      const active = new Map<ReturnType<typeof setInterval>, () => unknown>();
      const originalInterval = globalThis.setInterval, originalClear = globalThis.clearInterval;
      const timers = spyOn(globalThis, 'setInterval').mockImplementation(((callback: (...args: unknown[]) => unknown, delay: number, ...args: unknown[]) => {
        const handle = originalInterval(callback, delay, ...args);
        if (delay === 10 * 60_000) active.set(handle, () => callback(...args));
        return handle;
      }) as typeof setInterval);
      const clears = spyOn(globalThis, 'clearInterval').mockImplementation(((handle: ReturnType<typeof setInterval>) => {
        active.delete(handle); originalClear(handle);
      }) as typeof clearInterval);
      let deleting = false;
      const leaseModule = await import('../src/core/transcripts/ingest-daily-memory.ts');
      const originalCreate = leaseModule.createTranscriptIngestDailyMemory;
      const leases = spyOn(leaseModule, 'createTranscriptIngestDailyMemory').mockImplementation(async (...args) => {
        const live = await originalCreate(...args);
        if (live) {
          const deleteStalePart = live.deleteStalePart.bind(live);
          live.deleteStalePart = async slug => {
            deleting = true; enter();
            try { await deferred; await deleteStalePart(slug); }
            finally { deleting = false; }
          };
        }
        if (live && failRenew) {
          const renew = live.renew.bind(live);
          live.renew = () => deleting ? Promise.reject(new Error('synthetic deletion lease failure')) : renew();
        }
        return live;
      });
      const admitted: string[] = [];
      const run = runTranscriptsIngest(engine, { paths: [file, nextFile], format: 'codex', sourceId: 'default',
        onSession: id => { admitted.push(id); } }).then(result => ({ result, error: undefined as unknown }), error => ({ result: undefined, error }));
      try {
        await entered;
        expect(active.size).toBe(1);
        const markers = await engine.executeRaw<{ path: string }>("SELECT path FROM op_checkpoint_paths WHERE op='transcript-ingest-daily-memory' AND path::jsonb->>'value' LIKE 'running:%'");
        expect(markers).toHaveLength(1);
        const wrapped = JSON.parse(markers[0]!.path) as { origin: string; value: string };
        const aged = JSON.stringify({ origin: wrapped.origin, value: `running:${new Date(Date.now() - 31 * 60_000).toISOString()}` });
        await engine.executeRawDirect('UPDATE op_checkpoint_paths SET path=$1 WHERE path=$2', [aged, markers[0]!.path]);
        // Timer callback returns the complete renewal promise; no wall-clock sleep.
        await [...active.values()][0]!();
        const peer = (await originalCreate(engine, { sourceId: 'default', runKey: 'peer-deletion' }))!;
        await peer.finish();
        const before = await engine.executeRaw<{ id: number }>("SELECT id FROM minion_jobs WHERE name='autopilot-daily-memory' AND data->>'daily_memory_date'=$1 ORDER BY id", [oldDay]);
        if (failRenew) {
          expect(before.length).toBeGreaterThan(0);
          expect(await engine.executeRaw("SELECT path FROM op_checkpoint_paths WHERE op='transcript-ingest-daily-memory' AND path::jsonb->>'value' LIKE 'before:%'")).toHaveLength(0);
        } else expect(before).toHaveLength(0);
        const lastId = before.at(-1)?.id ?? 0;
        settle();
        const outcome = await run;
        expect(await engine.getPage(staleSlug)).toBeNull();
        expect(active.size).toBe(0);
        if (failRenew) {
          expect(outcome.error).toBeInstanceOf(Error);
          expect((outcome.error as Error).message).toContain('delete lease renewal failed');
          expect(admitted).toEqual(['delete-lease-fixture']);
          const retained = await engine.executeRaw<{ path: string }>("SELECT path FROM op_checkpoint_paths WHERE op='transcript-ingest-daily-memory' AND path::jsonb->>'value' LIKE 'before:%'");
          expect(retained.some(row => JSON.parse(JSON.parse(row.path).value.slice(7)).days.includes(oldDay))).toBe(true);
          // The rejected origin releases its lease but retains re-banked pre-delete dates.
          const recovery = (await originalCreate(engine, { sourceId: 'default', runKey: 'recover-deletion' }))!;
          await recovery.finish();
        } else {
          expect(outcome.error).toBeUndefined();
          expect(outcome.result!.partsDeleted).toBe(1);
          expect(outcome.result!.slugsTouched).toContain(staleSlug);
          expect(outcome.result!.cleanScan).toBe(true);
        }
        const after = await engine.executeRaw<{ id: number }>("SELECT id FROM minion_jobs WHERE name='autopilot-daily-memory' AND data->>'daily_memory_date'=$1 AND id>$2", [oldDay, lastId]);
        expect(after.length).toBeGreaterThan(0);
      } finally {
        settle(); await run;
        leases.mockRestore(); timers.mockRestore(); clears.mockRestore();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test('unchanged finish preserves a concurrent before: bank for later date recovery', async () => {
    await engine.putPage('notes/stable-transcript', { type: 'note', title: 'Stable', compiled_truth: 'Synthetic fixture', frontmatter: { date: '2026-01-20' } });
    await engine.putPage('notes/mutating-transcript', { type: 'note', title: 'Mutating', compiled_truth: 'Synthetic fixture', frontmatter: { date: '2026-01-21' } });
    await engine.executeRaw("UPDATE pages SET effective_date=(frontmatter->>'date')::date::timestamptz,effective_date_source='date' WHERE source_id='default' AND slug=ANY($1::text[])", [['notes/stable-transcript', 'notes/mutating-transcript']]);
    const unchanged = (await createTranscriptIngestDailyMemory(engine, { sourceId: 'default', runKey: 'unchanged' }))!;
    const mutating = (await createTranscriptIngestDailyMemory(engine, { sourceId: 'default', runKey: 'mutating' }))!;
    await mutating.before(['notes/mutating-transcript']);
    await unchanged.before(['notes/stable-transcript']);
    // Unchanged run finishes with no revision drift while mutating still holds
    // its before: bank and has not written yet.
    await unchanged.finish();
    const beforeRows = await engine.executeRaw<{ path: string }>(
      "SELECT path FROM op_checkpoint_paths WHERE op='transcript-ingest-daily-memory' AND path::jsonb->>'value' LIKE 'before:%'");
    expect(beforeRows).toHaveLength(1);
    expect(beforeRows[0]!.path).toContain('mutating-transcript');
    await engine.putPage('notes/mutating-transcript', { type: 'note', title: 'Mutating', compiled_truth: 'Synthetic fixture changed', frontmatter: { date: '2026-01-22' } });
    await engine.executeRaw("UPDATE pages SET effective_date=(frontmatter->>'date')::date::timestamptz,effective_date_source='date' WHERE source_id='default' AND slug='notes/mutating-transcript'");
    await mutating.touched(['notes/mutating-transcript']);
    await mutating.finish();
    const jobs = await engine.executeRaw<{ data: { daily_memory_dates?: string[] } }>("SELECT data FROM minion_jobs WHERE name='autopilot-daily-memory'");
    // Prior day from before: plus the new date after the write.
    expect(jobs.some(row => row.data.daily_memory_dates?.includes('2026-01-21'))).toBe(true);
    expect(jobs.some(row => row.data.daily_memory_dates?.includes('2026-01-22'))).toBe(true);
    expect(await engine.executeRaw("SELECT path FROM op_checkpoint_paths WHERE op='transcript-ingest-daily-memory'")).toHaveLength(0);
  });

  test('the daily ingest date zone links early-Manila Codex sessions while keeping their UTC slug', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-codex-manila-day-'));
    const file = join(dir, 'session.jsonl');
    const timestamp = '2026-09-29T16:30:00.000Z';
    writeFileSync(file, [
      { timestamp, type: 'session_meta', payload: { id: 'manila-day-fixture', session_id: 'manila-day-fixture', timestamp, cwd: dir } },
      { timestamp, type: 'event_msg', payload: { type: 'user_message', message: 'A daily index fixture.' } },
      { timestamp, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixture acknowledged.' }] } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    try {
      const ingested = await runTranscriptsIngest(engine, {
        paths: [file], format: 'codex', sourceId: 'default',
        dateZone: 'Asia/Manila', sinceIso: '2026-09-29T16:00:00.000Z',
      });
      expect(ingested.pages.imported).toBe(1);
      expect(ingested.cleanScan).toBe(true);
      const slug = ingested.slugsTouched[0]!;
      expect(slug).toContain('2026-09-29');
      const session = await engine.getPage(slug, { sourceId: 'default' });
      expect(session!.frontmatter.date).toBe('2026-09-30');
      expect(new Date(session!.effective_date!).toISOString()).toBe('2026-09-30T00:00:00.000Z');
      await engine.setConfig('cycle.timezone', 'Asia/Manila');
      await writeDailyMemoryFromSources(engine, { date: '2026-09-30' });
      expect((await engine.getPage(dailyMemorySlug('2026-09-30'), { sourceId: DAILY_MEMORY_SOURCE_ID }))!.compiled_truth).toContain(`[[default:${slug}]]`);
      const previous = await writeDailyMemoryFromSources(engine, { date: '2026-09-29' });
      expect(previous.reason).toBe('no_source_activity');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('same-slug pages retain their distinct source routing in the daily index', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('alpha', 'alpha'), ('beta', 'beta')`);
    for (const sourceId of ['alpha', 'beta']) {
      await engine.putPage('notes/shared', { type: 'note', title: sourceId, compiled_truth: 'A source fixture.' }, { sourceId });
    }
    const result = await writeDailyMemoryFromSources(engine);
    const page = await engine.getPage(result.slug, { sourceId: DAILY_MEMORY_SOURCE_ID });
    const refs = extractEntityRefs(page!.compiled_truth);
    expect(refs.filter(ref => ref.slug === 'notes/shared').map(ref => ref.sourceId)).toEqual(['alpha', 'beta']);
    expect(page!.compiled_truth).not.toContain('[[default:notes/shared]]');
  });

  test('a live human page at the daily slug is unchanged', async () => {
    await seedTodayPage();
    const slug = dailyMemorySlug(await resolveCycleDate(engine));
    const body = 'human wrote this day note by hand';
    await engine.putPage(slug, {
      type: 'note',
      title: 'My day',
      compiled_truth: body,
      frontmatter: { author: 'human' },
    }, { sourceId: DAILY_MEMORY_SOURCE_ID });

    const result = await writeDailyMemoryFromSources(engine);
    expect(result.written).toBe(false);
    expect(result.reason).toBe('human_page');

    const page = await engine.getPage(slug, { sourceId: DAILY_MEMORY_SOURCE_ID });
    expect(page).not.toBeNull();
    expect(page!.compiled_truth).toBe(body);
    expect(page!.title).toBe('My day');
    expect(page!.frontmatter.dream_generated).not.toBe(true);
    expect(page!.deleted_at ?? null).toBeNull();
  });

  test('a soft-deleted human page at the daily slug stays deleted and its body is unchanged', async () => {
    await seedTodayPage();
    const slug = dailyMemorySlug(await resolveCycleDate(engine));
    const body = 'human note that was removed';
    await engine.putPage(slug, {
      type: 'note',
      title: 'Removed day',
      compiled_truth: body,
    }, { sourceId: DAILY_MEMORY_SOURCE_ID });
    expect(await engine.softDeletePage(slug, { sourceId: DAILY_MEMORY_SOURCE_ID })).not.toBeNull();

    const result = await writeDailyMemoryFromSources(engine);
    expect(result.written).toBe(false);
    expect(result.reason).toBe('human_page');

    expect(await engine.getPage(slug, { sourceId: DAILY_MEMORY_SOURCE_ID })).toBeNull();
    const deleted = await engine.getPage(slug, { sourceId: DAILY_MEMORY_SOURCE_ID, includeDeleted: true });
    expect(deleted).not.toBeNull();
    expect(deleted!.deleted_at).toBeTruthy();
    expect(deleted!.compiled_truth).toBe(body);
    expect(deleted!.title).toBe('Removed day');
    expect(deleted!.frontmatter.dream_generated).not.toBe(true);
  });

  async function seedRecord(id: string, source: string, updatedAt: string, slug?: string): Promise<void> {
    await engine.executeRaw(
      `CREATE TABLE IF NOT EXISTS source_records (
        id text PRIMARY KEY, source_type text, source_ref text, entity_type text,
        entity_id text, payload_json jsonb, updated_at timestamptz
      )`, [],
    );
    await engine.executeRaw(
      `INSERT INTO source_records VALUES ($1, $2, $1, 'message', $1, $3::text::jsonb, $4::timestamptz)`,
      [id, source, JSON.stringify({ slug, title: 'private title', message: 'private body' }), updatedAt],
    );
    if (slug) {
      await engine.putPage(slug, { type: 'note', title: 'Stored page', compiled_truth: 'private page body' });
      await engine.executeRaw(
        `UPDATE pages SET effective_date = '2020-01-01'::timestamptz WHERE slug = $1`, [slug],
      );
    }
  }

  async function writeSeptember30() {
    await engine.setConfig('cycle.timezone', 'Asia/Manila');
    return writeDailyMemoryFromSources(engine, { now: () => new Date('2026-09-30T02:00:00Z') });
  }

  test('source records count all updates, cap stable openable record links, and omit payload text', async () => {
    for (let i = 0; i < 10; i++) {
      await seedRecord(`discrawl:${i}`, 'discrawl', '2026-09-30T00:00:00Z', `comms/disc-${i}`);
    }
    await seedRecord('gmail:1', 'gmail', '2026-09-30T00:00:00Z', 'mail/thread-1');
    await seedRecord('gmail:unpromoted', 'gmail', '2026-09-30T00:00:00Z');
    const result = await writeSeptember30();
    expect(result.written).toBe(true);
    const page = await engine.getPage(result.slug, { sourceId: DAILY_MEMORY_SOURCE_ID });
    expect(page!.compiled_truth).toContain('discrawl: 10 records changed');
    expect(page!.compiled_truth).toContain('gmail: 2 records changed');
    expect(page!.compiled_truth).toContain('[[dream:source-records/gmail/');
    expect(page!.compiled_truth).toContain('8 of 10 records are linked.');
    expect(page!.compiled_truth.match(/\[\[dream:source-records\/discrawl\//g)).toHaveLength(8);
    expect(page!.compiled_truth).not.toContain('gmail:unpromoted');
    expect(page!.compiled_truth).not.toContain('private');
    for (const [, slug] of page!.compiled_truth.matchAll(/\[\[dream:(source-records\/[^\]]+)\]\]/g)) {
      const recordPage = await engine.getPage(slug, { sourceId: DAILY_MEMORY_SOURCE_ID });
      expect(recordPage).not.toBeNull();
      expect(recordPage!.compiled_truth).not.toContain('private');
    }
    const allPages = await engine.executeRaw<{ total: number }>('SELECT count(*)::int AS total FROM pages', []);
    expect(allPages[0].total).toBe(22);
  });

  test('default human live and deleted notes block the dream writer before reference creation', async () => {
    await seedRecord('guard-record', 'gmail', '2026-09-30T00:00:00Z');
    const slug = dailyMemorySlug('2026-09-30');
    await engine.putPage(slug, { type: 'note', title: 'Human day', compiled_truth: 'Human fixture', frontmatter: {} });
    for (const deleted of [false, true]) {
      if (deleted) await engine.softDeletePage(slug);
      const guarded = await writeSeptember30();
      expect(guarded.reason).toBe('human_page');
      expect(guarded.source_id).toBe('default');
      expect(await engine.getPage(slug, { sourceId: DAILY_MEMORY_SOURCE_ID })).toBeNull();
      expect((await engine.getPage(slug, { includeDeleted: true }))!.compiled_truth).toBe('Human fixture');
      expect((await engine.executeRaw("SELECT 1 FROM pages WHERE slug LIKE 'source-records/%'")).length).toBe(0);
    }
  });

  test('new dream indexes retain historical default pages and resolve qualified graph targets', async () => {
    await seedRecord('stable-record', 'gmail', '2026-09-30T00:00:00Z');
    await engine.putPage('notes/default-target', { type: 'note', title: 'Default target', compiled_truth: 'Fixture',
      frontmatter: { date: '2026-09-30' } });
    await engine.executeRaw("UPDATE pages SET effective_date='2026-09-30T00:00:00Z', effective_date_source='date' WHERE source_id='default' AND slug='notes/default-target'");
    await writeSeptember30();
    const slug = dailyMemorySlug('2026-09-30');
    const first = (await engine.getPage(slug, { sourceId: DAILY_MEMORY_SOURCE_ID }))!;
    const ref = first.compiled_truth.match(/\[\[dream:(source-records\/[^\]]+)\]\]/)![1];
    await engine.putPage(ref, { type: 'note', title: 'Legacy reference', compiled_truth: 'Legacy identity',
      frontmatter: { dream_generated: true, source_record_id: 'stable-record', source_record_type: 'gmail', source_record_ref: 'stable-record' } });
    await engine.putPage(slug, { type: 'note', title: 'Legacy day', compiled_truth: `[[${ref}]]`,
      frontmatter: { dream_generated: true } });
    await writeSeptember30();
    expect((await engine.getPage(slug))!.compiled_truth).toBe(`[[${ref}]]`);
    expect((await engine.getPage(ref))!.compiled_truth).toBe('Legacy identity');
    const fresh = (await engine.getPage(slug, { sourceId: DAILY_MEMORY_SOURCE_ID }))!;
    expect(fresh.compiled_truth).toContain('[[default:notes/default-target]]');
    expect(fresh.compiled_truth).toContain(`[[dream:${ref}]]`);
    await extractStaleFromDB(engine, { dryRun: false, quiet: true, jsonMode: true, catchUp: false,
      includeFrontmatter: false, sourceIdFilter: DAILY_MEMORY_SOURCE_ID });
    const edges = await engine.getLinks(slug, { sourceId: DAILY_MEMORY_SOURCE_ID });
    expect(edges.some(edge => edge.to_slug === ref && edge.to_source_id === DAILY_MEMORY_SOURCE_ID)).toBe(true);
    expect(edges.some(edge => edge.to_slug === 'notes/default-target' && edge.to_source_id === 'default')).toBe(true);
  });

  test('brain-wide generated indexes remain owner-readable and hidden from scoped remote reads', async () => {
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES('restricted','Restricted fixture')", []);
    await engine.putPage('notes/restricted-fixture', {
      type: 'note', title: 'Restricted fixture', compiled_truth: 'Synthetic fixture',
      frontmatter: { date: '2026-09-30' },
    }, { sourceId: 'restricted' });
    await engine.executeRaw(
      `UPDATE pages SET effective_date = '2026-09-30T00:00:00Z'::timestamptz,
        effective_date_source = 'date'
       WHERE source_id = 'restricted' AND slug = 'notes/restricted-fixture'`,
    );
    await seedRecord('record-fixture', 'gmail', '2026-09-30T00:00:00Z');
    const result = await writeSeptember30();
    const daily = (await engine.getPage(result.slug, { sourceId: DAILY_MEMORY_SOURCE_ID }))!;
    expect(daily.compiled_truth).toContain('[[restricted:notes/restricted-fixture]]');
    const reference = daily.compiled_truth.match(/\[\[dream:(source-records\/[^\]]+)\]\]/)![1];
    const dreamCfg = await engine.executeRaw<{ federated: boolean | null; system_index: boolean | null }>(
      `SELECT (config->>'federated')::boolean AS federated, (config->>'system_index')::boolean AS system_index FROM sources WHERE id = $1`,
      [DAILY_MEMORY_SOURCE_ID],
    );
    expect(dreamCfg[0]?.federated).toBe(false);
    expect(dreamCfg[0]?.system_index).toBe(true);
    // Build current safe search projections so hiding isn't a missing-index side effect.
    for (const slug of [result.slug, reference]) {
      const page = (await engine.getPage(slug, { sourceId: DAILY_MEMORY_SOURCE_ID }))!;
      expect(page.frontmatter.visibility).toBe('private');
      expect(page.source_id).toBe(DAILY_MEMORY_SOURCE_ID);
      await importFromContent(engine, slug, serializeMarkdown(page.frontmatter, page.compiled_truth, '', {
        type: page.type, title: page.title, tags: [],
      }), { noEmbed: true, forceRechunk: true, sourceId: DAILY_MEMORY_SOURCE_ID });
    }
    await engine.setConfig('search.mcp_keyword_only', 'true');
    __resetPrivateVisibilityCacheForTests();
    const defaultRemote = (remote: boolean) => ({
      engine, remote, sourceId: 'default', config: { engine: 'pglite' }, dryRun: false,
      logger: { info() {}, warn() {}, error() {} },
      auth: { token: 'fixture', clientId: 'fixture', scopes: ['read'], allowedSources: ['default'] },
    }) as never;
    const dreamOwner = {
      engine, remote: false, sourceId: DAILY_MEMORY_SOURCE_ID, config: { engine: 'pglite' }, dryRun: false,
      logger: { info() {}, warn() {}, error() {} },
      auth: { token: 'fixture', clientId: 'fixture', scopes: ['read'], allowedSources: [DAILY_MEMORY_SOURCE_ID] },
    } as never;
    for (const slug of [result.slug, reference]) {
      await expect(operationsByName.get_page.handler(defaultRemote(true), { slug })).rejects.toThrow(/Page not found/);
      const owner = await operationsByName.get_page.handler(dreamOwner, { slug }) as { slug: string };
      expect(owner.slug).toBe(slug);
    }
    // Visibility opt-out must not pierce the source boundary for default-only grants.
    await engine.setConfig('search.remote_private_pages', 'visible');
    __resetPrivateVisibilityCacheForTests();
    for (const slug of [result.slug, reference]) {
      await expect(operationsByName.get_page.handler(defaultRemote(true), { slug })).rejects.toThrow(/Page not found/);
      const remoteList = await operationsByName.list_pages.handler(defaultRemote(true), { limit: 100 }) as { slug: string }[];
      expect(remoteList.map(row => row.slug)).not.toContain(slug);
      const remoteSearch = await operationsByName.search.handler(defaultRemote(true), {
        query: slug.startsWith('source-records/') ? 'Source reference' : 'Daily memory',
      }) as { slug: string }[];
      expect(remoteSearch.map(row => row.slug)).not.toContain(slug);
    }
    const ownerList = await operationsByName.list_pages.handler(dreamOwner, { limit: 100 }) as { slug: string }[];
    for (const slug of [result.slug, reference]) {
      expect(ownerList.map(row => row.slug)).toContain(slug);
    }
    for (const [query, slug] of [['Daily memory', result.slug], ['Source reference', reference]]) {
      const owner = await operationsByName.search.handler(dreamOwner, { query }) as { slug: string }[];
      expect(owner.map(row => row.slug)).toContain(slug);
    }
  });

  test('unrenderable stored slugs are skipped without inventing a link target', async () => {
    for (const slug of ['notes/safe', 'notes/bad[[phantom]]', 'notes/bad|alias', 'notes/bad#heading', 'notes/bad^block']) {
      await engine.putPage(slug, { type: 'note', title: 'Label [[injected]]', compiled_truth: 'Synthetic fixture' });
      await engine.executeRaw("UPDATE pages SET effective_date='2026-09-30T00:00:00Z', effective_date_source='filename' WHERE source_id='default' AND slug=$1", [slug]);
    }
    const result = await writeSeptember30();
    const daily = (await engine.getPage(result.slug, { sourceId: DAILY_MEMORY_SOURCE_ID }))!;
    expect(daily.compiled_truth).toContain('[[default:notes/safe]]');
    expect(daily.compiled_truth).not.toContain('[[default:notes/bad');
    expect(daily.compiled_truth).not.toContain('[[injected]]');
    for (const delimiter of ['|', '#', '^']) expect(daily.compiled_truth).not.toContain(`[[default:notes/bad${delimiter}`);
    expect(daily.compiled_truth).toContain('1 of 5 pages are linked.');
    expect(await engine.getPage('notes/bad[[phantom]]')).not.toBeNull();
  });

  test('refuses to commandeer a user-owned dream source', async () => {
    await engine.executeRaw(`DELETE FROM sources WHERE id = $1`, [DAILY_MEMORY_SOURCE_ID]);
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ($1, $2, $3::text::jsonb)`,
      [DAILY_MEMORY_SOURCE_ID, 'User dream repo', JSON.stringify({ federated: true })],
    );
    await seedRecord('gmail:1', 'gmail', '2026-09-30T00:00:00Z');
    const result = await writeSeptember30();
    expect(result.written).toBe(false);
    expect(result.reason).toBe('error');
    const cfg = await engine.executeRaw<{ federated: boolean | null; system_index: string | null }>(
      `SELECT (config->>'federated')::boolean AS federated, config->>'system_index' AS system_index
         FROM sources WHERE id = $1`,
      [DAILY_MEMORY_SOURCE_ID],
    );
    expect(cfg[0]?.federated).toBe(true);
    expect(cfg[0]?.system_index).toBeNull();
  });

  test('sticky-upgrades a legacy federated:false dream index we already own', async () => {
    await engine.executeRaw(`DELETE FROM sources WHERE id = $1`, [DAILY_MEMORY_SOURCE_ID]);
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ($1, $2, $3::text::jsonb)`,
      [DAILY_MEMORY_SOURCE_ID, 'Dream cycle indexes', JSON.stringify({ federated: false })],
    );
    await seedRecord('gmail:1', 'gmail', '2026-09-30T00:00:00Z');
    const result = await writeSeptember30();
    expect(result.written).toBe(true);
    const cfg = await engine.executeRaw<{ federated: boolean | null; system_index: boolean | null }>(
      `SELECT (config->>'federated')::boolean AS federated,
              (config->>'system_index')::boolean AS system_index
         FROM sources WHERE id = $1`,
      [DAILY_MEMORY_SOURCE_ID],
    );
    expect(cfg[0]?.federated).toBe(false);
    expect(cfg[0]?.system_index).toBe(true);
  });

  test('escapes markdown control characters in source-record metadata', async () => {
    await seedRecord('inject:1', 'evil\n[[notes/injected]]', '2026-09-30T00:00:00Z');
    const result = await writeSeptember30();
    expect(result.written).toBe(true);
    const page = await engine.getPage(result.slug, { sourceId: DAILY_MEMORY_SOURCE_ID });
    expect(page!.compiled_truth).not.toContain('[[notes/injected]]');
    expect(page!.compiled_truth).toContain('\\[\\[');
    await extractStaleFromDB(engine, {
      dryRun: false, quiet: true, jsonMode: true, catchUp: false, includeFrontmatter: false,
      sourceIdFilter: DAILY_MEMORY_SOURCE_ID,
    });
    const targets = (await engine.getLinks(result.slug))
      .filter(link => link.from_source_id === DAILY_MEMORY_SOURCE_ID)
      .map(link => link.to_slug);
    expect(targets).not.toContain('notes/injected');
  });

  test('unchanged indexes preserve revisions and retry failed extraction until day and references are fresh', async () => {
    await seedRecord('gmail:1', 'gmail', '2026-09-30T00:00:00Z');
    const first = await writeSeptember30();
    expect(first.written).toBe(true);
    expect(first.needs_extract).toBe(true);
    const snapshot = () => engine.executeRaw("SELECT slug, knowledge_revision, updated_at FROM pages WHERE source_id=$1 ORDER BY slug", [DAILY_MEMORY_SOURCE_ID]);
    const original = await snapshot();
    const enqueue = spyOn(MinionQueue.prototype, 'add');
    try {
      enqueue.mockImplementation(async () => { throw new Error('Synthetic first handoff failure'); });
      await expect(queueDailyMemoryExtract(engine, first)).rejects.toThrow('Synthetic first handoff failure');
    } finally { enqueue.mockRestore(); }
    const retry = await writeSeptember30();
    expect(retry.written).toBe(false);
    expect(retry.reason).toBe('unchanged');
    expect(retry.needs_extract).toBe(true);
    expect(await snapshot()).toEqual(original);
    await queueDailyMemoryExtract(engine, retry);
    expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE name='extract' AND status='waiting'")).toHaveLength(1);
    await engine.markPagesExtractedBatch([{ slug: retry.slug, source_id: DAILY_MEMORY_SOURCE_ID }], new Date().toISOString());
    expect((await writeSeptember30()).needs_extract).toBe(true); // The reference is still unstamped.
    await extractStaleFromDB(engine, { dryRun: false, quiet: true, jsonMode: true, catchUp: false,
      includeFrontmatter: false, sourceIdFilter: DAILY_MEMORY_SOURCE_ID });
    const healthy = await writeSeptember30();
    expect(healthy.reason).toBe('unchanged');
    expect(healthy.needs_extract).toBe(false);
    expect(await snapshot()).toEqual(original);
    const failIfCalled = spyOn(MinionQueue.prototype, 'add');
    try {
      failIfCalled.mockImplementation(async () => { throw new Error('Healthy no-op must not enqueue'); });
      await queueDailyMemoryExtract(engine, healthy);
      expect(failIfCalled).not.toHaveBeenCalled();
    } finally { failIfCalled.mockRestore(); }
  });

  test('empty activity clears only the live generated dream day and preserves historical targets', async () => {
    await seedRecord('gmail:empty', 'gmail', '2026-09-30T00:00:00Z');
    const first = await writeSeptember30();
    await extractStaleFromDB(engine, { dryRun: false, quiet: true, jsonMode: true, catchUp: false,
      includeFrontmatter: false, sourceIdFilter: DAILY_MEMORY_SOURCE_ID });
    expect(await engine.getLinks(first.slug, { sourceId: DAILY_MEMORY_SOURCE_ID })).not.toHaveLength(0);
    const original = (await engine.getPage(first.slug, { sourceId: DAILY_MEMORY_SOURCE_ID }))!;
    await engine.putPage(first.slug, { type: 'note', title: 'Historical generated day',
      compiled_truth: 'Historical [[default:source-records/example]]', frontmatter: { dream_generated: true } });
    const historical = await engine.getPage(first.slug);
    const references = await engine.executeRaw("SELECT slug,knowledge_revision FROM pages WHERE source_id=$1 AND slug LIKE 'source-records/%'", [DAILY_MEMORY_SOURCE_ID]);
    await engine.executeRaw('DELETE FROM source_records');
    const cleared = await writeSeptember30();
    expect(cleared.written).toBe(true);
    expect(cleared.needs_extract).toBe(true);
    const empty = (await engine.getPage(first.slug, { sourceId: DAILY_MEMORY_SOURCE_ID }))!;
    expect(original.compiled_truth).toContain('gmail: 1 record changed');
    expect(empty.compiled_truth).toContain('No stored page or source record activity remains');
    expect(empty.compiled_truth).not.toContain('[[');
    expect(empty.frontmatter.dream_generated).toBe(true);
    expect(await engine.getPage(first.slug)).toEqual(historical);
    expect(await engine.executeRaw("SELECT slug,knowledge_revision FROM pages WHERE source_id=$1 AND slug LIKE 'source-records/%'", [DAILY_MEMORY_SOURCE_ID])).toEqual(references);
    await extractStaleFromDB(engine, { dryRun: false, quiet: true, jsonMode: true, catchUp: false,
      includeFrontmatter: false, sourceIdFilter: DAILY_MEMORY_SOURCE_ID });
    expect(await engine.getLinks(first.slug, { sourceId: DAILY_MEMORY_SOURCE_ID })).toHaveLength(0);
    expect((await writeSeptember30()).reason).toBe('unchanged');
    await engine.softDeletePage(first.slug, { sourceId: DAILY_MEMORY_SOURCE_ID });
    expect((await writeSeptember30()).reason).toBe('no_source_activity');
    expect((await engine.getPage(first.slug, { sourceId: DAILY_MEMORY_SOURCE_ID, includeDeleted: true }))!.deleted_at).toBeTruthy();
  });

  for (const sourceId of ['default', DAILY_MEMORY_SOURCE_ID]) for (const deleted of [false, true]) {
    test(`empty activity preserves a human day in ${sourceId} (deleted=${deleted})`, async () => {
      const slug = dailyMemorySlug('2026-09-30');
      await engine.putPage(slug, { type: 'note', title: 'Human day', compiled_truth: 'Human day fixture',
        frontmatter: { author: 'human' } }, { sourceId });
      if (deleted) await engine.softDeletePage(slug, { sourceId });
      const before = await engine.getPage(slug, { sourceId, includeDeleted: true });
      const result = await writeSeptember30();
      expect(result.reason).toBe('human_page');
      expect(result.source_id).toBe(sourceId);
      expect(await engine.getPage(slug, { sourceId, includeDeleted: true })).toEqual(before);
    });
  }

  test('an archived owned index is not written or silently restored', async () => {
    await seedRecord('gmail:archived-index', 'gmail', '2026-09-30T00:00:00Z');
    await writeSeptember30();
    const before = await engine.getPage(dailyMemorySlug('2026-09-30'), { sourceId: DAILY_MEMORY_SOURCE_ID });
    await engine.executeRaw('UPDATE sources SET archived=true WHERE id=$1', [DAILY_MEMORY_SOURCE_ID]);
    const result = await writeSeptember30();
    expect(result.reason).toBe('error');
    expect(result.written).toBe(false);
    expect(await engine.getPage(dailyMemorySlug('2026-09-30'), { sourceId: DAILY_MEMORY_SOURCE_ID })).toEqual(before);
    expect((await engine.executeRaw<{ archived: boolean }>('SELECT archived FROM sources WHERE id=$1', [DAILY_MEMORY_SOURCE_ID]))[0]!.archived).toBe(true);
  });

  test('a human default day still probes stale dream extraction work', async () => {
    await seedRecord('gmail:human-default-probe', 'gmail', '2026-09-30T00:00:00Z');
    const first = await writeSeptember30();
    await engine.executeRaw("UPDATE pages SET updated_at=$2::timestamptz - interval '2 seconds', links_extracted_at=$2::timestamptz - interval '1 second' WHERE source_id=$1",
      [DAILY_MEMORY_SOURCE_ID, LINK_EXTRACTOR_VERSION_TS]);
    const slug = dailyMemorySlug('2026-09-30');
    await engine.putPage(slug, { type: 'note', title: 'Human default day', compiled_truth: 'Operator day note',
      frontmatter: { author: 'human' } }, { sourceId: 'default' });
    const result = await writeSeptember30();
    expect(result.reason).toBe('human_page');
    expect(result.source_id).toBe('default');
    expect(result.needs_extract).toBe(true);
    expect(await engine.getPage(first.slug, { sourceId: DAILY_MEMORY_SOURCE_ID })).not.toBeNull();
    await queueDailyMemoryExtract(engine, result);
    const jobs = await engine.executeRaw<{ data: Record<string, unknown> }>(
      "SELECT data FROM minion_jobs WHERE name='extract' AND status='waiting'");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.data.sourceId).toBe(DAILY_MEMORY_SOURCE_ID);
  });

  test('a human default index does not wake extraction for an unrelated dream source', async () => {
    await seedRecord('gmail:unowned-probe', 'gmail', '2026-09-30T00:00:00Z');
    await writeSeptember30();
    await engine.executeRaw("UPDATE sources SET name='User workspace', config='{}'::jsonb WHERE id=$1",
      [DAILY_MEMORY_SOURCE_ID]);
    await engine.putPage(dailyMemorySlug('2026-09-30'), {
      type: 'note', title: 'Human day', compiled_truth: 'Operator note', frontmatter: { author: 'human' },
    }, { sourceId: 'default' });
    const before = await engine.getPage(dailyMemorySlug('2026-09-30'), { sourceId: 'default' });
    const result = await writeSeptember30();
    expect(result.reason).toBe('human_page');
    expect(result.needs_extract).toBe(false);
    await queueDailyMemoryExtract(engine, result);
    expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE name='extract'")).toHaveLength(0);
    expect(await engine.getPage(dailyMemorySlug('2026-09-30'), { sourceId: 'default' })).toEqual(before);
  });

  test('an inactive day queues version-stale historical dream indexes without creating or resurrecting it', async () => {
    await seedRecord('gmail:historical-version', 'gmail', '2026-09-30T00:00:00Z');
    const historical = await writeSeptember30();
    await engine.executeRaw('DELETE FROM source_records');
    await engine.executeRaw("UPDATE pages SET updated_at=$2::timestamptz - interval '2 seconds', links_extracted_at=$2::timestamptz - interval '1 second' WHERE source_id=$1",
      [DAILY_MEMORY_SOURCE_ID, LINK_EXTRACTOR_VERSION_TS]);
    const snapshot = () => engine.executeRaw("SELECT slug,knowledge_revision,updated_at,deleted_at FROM pages WHERE source_id=$1 ORDER BY slug", [DAILY_MEMORY_SOURCE_ID]);
    const before = await snapshot();
    const day = '2026-10-02', slug = dailyMemorySlug(day);
    const missing = await writeDailyMemoryFromSources(engine, { date: day });
    expect(missing.reason).toBe('no_source_activity');
    expect(missing.needs_extract).toBe(true);
    expect(await engine.getPage(slug, { sourceId: DAILY_MEMORY_SOURCE_ID })).toBeNull();
    expect(await snapshot()).toEqual(before);
    await queueDailyMemoryExtract(engine, missing);
    expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE name='extract' AND status='waiting'")).toHaveLength(1);
    await engine.putPage(slug, { type: 'note', title: 'Deleted generated day', compiled_truth: 'Synthetic historical day',
      frontmatter: { dream_generated: true } }, { sourceId: DAILY_MEMORY_SOURCE_ID });
    await engine.softDeletePage(slug, { sourceId: DAILY_MEMORY_SOURCE_ID });
    expect((await writeDailyMemoryFromSources(engine, { date: day })).needs_extract).toBe(true);
    expect((await engine.getPage(slug, { sourceId: DAILY_MEMORY_SOURCE_ID, includeDeleted: true }))!.deleted_at).toBeTruthy();
    await engine.executeRaw("UPDATE pages SET links_extracted_at=$2::timestamptz WHERE source_id=$1", [DAILY_MEMORY_SOURCE_ID, LINK_EXTRACTOR_VERSION_TS]);
    const healthy = await writeDailyMemoryFromSources(engine, { date: day });
    expect(healthy.needs_extract).toBe(false);
    expect(await engine.getPage(historical.slug, { sourceId: DAILY_MEMORY_SOURCE_ID })).not.toBeNull();
  });

  test('archived page sources are excluded while source-record ingestion remains independent', async () => {
    await engine.executeRaw("INSERT INTO sources(id,name,archived) VALUES('archived-fixture','Archived fixture',true),('active-fixture','Active fixture',false)");
    for (const sourceId of ['archived-fixture', 'active-fixture']) {
      await engine.putPage('notes/day', { type: 'note', title: 'Day fixture', compiled_truth: 'Synthetic fixture',
        frontmatter: { date: '2026-09-30' } }, { sourceId });
    }
    await engine.executeRaw("UPDATE pages SET effective_date='2026-09-30T00:00:00Z'::timestamptz, effective_date_source='date' WHERE source_id=ANY($1::text[])",
      [['archived-fixture', 'active-fixture']]);
    await seedRecord('archived:source-record', 'archived-fixture', '2026-09-30T00:00:00Z');
    const first = await writeSeptember30();
    expect(first.pages).toBe(1);
    const page = (await engine.getPage(first.slug, { sourceId: DAILY_MEMORY_SOURCE_ID }))!;
    expect(page.compiled_truth).toContain('[[active-fixture:notes/day]]');
    expect(page.compiled_truth).not.toContain('[[archived-fixture:notes/day]]');
    expect(page.compiled_truth).toContain('archived-fixture: 1 record changed');
    await engine.executeRaw("UPDATE sources SET archived=false WHERE id='archived-fixture'");
    const restored = await writeSeptember30();
    expect(restored.pages).toBe(2);
    expect((await engine.getPage(first.slug, { sourceId: DAILY_MEMORY_SOURCE_ID }))!.compiled_truth).toContain('[[archived-fixture:notes/day]]');
  });

  test('unchanged generated targets need extraction when their watermark predates the extractor version', async () => {
    await seedRecord('gmail:version', 'gmail', '2026-09-30T00:00:00Z');
    const first = await writeSeptember30();
    const snapshot = () => engine.executeRaw("SELECT slug,knowledge_revision,updated_at FROM pages WHERE source_id=$1 ORDER BY slug", [DAILY_MEMORY_SOURCE_ID]);
    const before = await snapshot();
    // A watermark newer than the page can still predate the extractor implementation.
    await engine.executeRaw("UPDATE pages SET updated_at=$2::timestamptz - interval '2 seconds', links_extracted_at=$2::timestamptz - interval '1 second' WHERE source_id=$1",
      [DAILY_MEMORY_SOURCE_ID, LINK_EXTRACTOR_VERSION_TS]);
    const unchanged = await snapshot();
    const stale = await writeSeptember30();
    expect(stale.written).toBe(false);
    expect(stale.needs_extract).toBe(true);
    expect(await snapshot()).toEqual(unchanged);
    await queueDailyMemoryExtract(engine, stale);
    expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE name='extract' AND status='waiting'")).toHaveLength(1);
    await engine.executeRaw("UPDATE pages SET links_extracted_at=$2::timestamptz WHERE source_id=$1", [DAILY_MEMORY_SOURCE_ID, LINK_EXTRACTOR_VERSION_TS]);
    expect((await writeSeptember30()).needs_extract).toBe(false);
    // Day-only freshness cannot hide an older reference watermark.
    await engine.executeRaw("UPDATE pages SET links_extracted_at=$2::timestamptz - interval '1 second' WHERE source_id=$1 AND slug<>$3",
      [DAILY_MEMORY_SOURCE_ID, LINK_EXTRACTOR_VERSION_TS, first.slug]);
    expect((await writeSeptember30()).needs_extract).toBe(true);
    expect(before).toHaveLength(2);
  });

  test('record no-op requires private visibility and every source identity marker', async () => {
    await seedRecord('gmail:1', 'gmail', '2026-09-30T00:00:00Z');
    await writeSeptember30();
    const [row] = await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE source_id=$1 AND slug LIKE 'source-records/%'", [DAILY_MEMORY_SOURCE_ID]);
    const reference = (await engine.getPage(row.slug, { sourceId: DAILY_MEMORY_SOURCE_ID }))!;
    const frontmatter: Record<string, unknown> = { ...reference.frontmatter, visibility: 'world' };
    delete frontmatter.source_record_ref;
    await engine.putPage(row.slug, { ...reference, frontmatter }, { sourceId: DAILY_MEMORY_SOURCE_ID });
    expect((await writeSeptember30()).written).toBe(true);
    const repaired = (await engine.getPage(row.slug, { sourceId: DAILY_MEMORY_SOURCE_ID }))!;
    expect(repaired.frontmatter.visibility).toBe('private');
    expect(repaired.frontmatter.source_record_ref).toBe('gmail:1');
    expect(repaired.frontmatter.source_record_type).toBe('gmail');
    expect(repaired.frontmatter.source_record_id).toBe('gmail:1');
  });

  test('a successful daily write can enqueue a dream-scoped deferred extract', async () => {
    await seedRecord('gmail:1', 'gmail', '2026-09-30T00:00:00Z');
    const result = await writeSeptember30();
    expect(result.written).toBe(true);
    await queueDailyMemoryExtract(engine, { ...result, written: false, needs_extract: false });
    expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE name='extract'")).toHaveLength(0);
    await queueDailyMemoryExtract(engine, result);
    const jobs = await engine.executeRaw<{ idempotency_key: string | null }>(
      `SELECT idempotency_key FROM minion_jobs WHERE name = 'extract'`,
    );
    expect(jobs.some(job => job.idempotency_key === `extract-stale:${DAILY_MEMORY_SOURCE_ID}:daily-memory:${result.day}`)).toBe(true);
    const durable = (await engine.getPage(result.slug, { sourceId: DAILY_MEMORY_SOURCE_ID }))!;
    const enqueue = spyOn(MinionQueue.prototype, 'add');
    try {
      enqueue.mockResolvedValue({ status: 'completed', data: {} } as never);
      await expect(queueDailyMemoryExtract(engine, result)).rejects.toThrow('handoff was not accepted');
      expect((await engine.getPage(result.slug, { sourceId: DAILY_MEMORY_SOURCE_ID }))!.compiled_truth).toBe(durable.compiled_truth);
      enqueue.mockImplementation(async () => { throw new Error('Synthetic enqueue failure'); });
      await expect(queueDailyMemoryExtract(engine, result)).rejects.toThrow('Synthetic enqueue failure');
      expect((await engine.getPage(result.slug, { sourceId: DAILY_MEMORY_SOURCE_ID }))!.knowledge_revision).toBe(durable.knowledge_revision);
      enqueue.mockClear();
      await queueDailyMemoryExtract(engine, { ...result, written: false, needs_extract: false });
      expect(enqueue).not.toHaveBeenCalled();
    } finally { enqueue.mockRestore(); }
  });

  test('dream system index extracts outbound edges to other sources', async () => {
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES('notes','notes') ON CONFLICT (id) DO NOTHING", []);
    await engine.putPage('meetings/standup', {
      type: 'meeting', title: 'Standup', compiled_truth: 'talked about the rollout',
      frontmatter: { date: '2026-09-30' },
    }, { sourceId: 'notes' });
    await engine.executeRaw(
      `UPDATE pages SET effective_date = '2026-09-30T00:00:00Z'::timestamptz, effective_date_source = 'date'
       WHERE source_id = 'notes' AND slug = 'meetings/standup'`,
    );
    const result = await writeSeptember30();
    expect(result.written).toBe(true);
    await extractStaleFromDB(engine, {
      dryRun: false, quiet: true, jsonMode: true, catchUp: false, includeFrontmatter: false,
      sourceIdFilter: DAILY_MEMORY_SOURCE_ID,
    });
    const targets = (await engine.getLinks(result.slug))
      .filter(link => link.from_source_id === DAILY_MEMORY_SOURCE_ID)
      .map(link => `${link.to_source_id}:${link.to_slug}`);
    expect(targets).toContain('notes:meetings/standup');
  });

  test('record source types normalize to stored graph targets and preserve stable safe paths', async () => {
    await seedRecord('slash-reference', 'mail/slack', '2026-09-30T00:00:00Z');
    await seedRecord('safe-reference', 'gmail', '2026-09-30T00:00:00Z');
    await seedRecord('upper-reference', 'Mail:Slack', '2026-09-30T00:00:00Z');
    await seedRecord('unicode-reference', 'Mélange', '2026-09-30T00:00:00Z');
    const first = await writeSeptember30();
    expect(first.written).toBe(true);
    const page = (await engine.getPage(first.slug, { sourceId: DAILY_MEMORY_SOURCE_ID }))!;
    const slugs = [...page.compiled_truth.matchAll(/\[\[dream:(source-records\/[^\]]+)\]\]/g)].map(match => match[1]);
    expect(slugs).toHaveLength(4);
    expect(slugs.every(slug => slug === slug.toLowerCase())).toBe(true);
    expect(slugs.some(slug => slug.startsWith('source-records/mail%3aslack/'))).toBe(true);
    expect(slugs.some(slug => slug.startsWith('source-records/m%c3%a9lange/'))).toBe(true);
    expect(slugs.some(slug => slug.startsWith('source-records/gmail/'))).toBe(true);
    expect(slugs.some(slug => /^source-records\/type-[a-f0-9]{64}\/[a-f0-9]{64}$/.test(slug))).toBe(true);
    const stored = await engine.executeRaw<{ slug: string }>(
      "SELECT slug FROM pages WHERE source_id = $1 AND slug LIKE 'source-records/%'", [DAILY_MEMORY_SOURCE_ID]);
    expect(stored.map(row => row.slug).sort()).toEqual([...slugs].sort());
    for (const slug of slugs) expect(await engine.resolveSlugs(slug, { sourceId: DAILY_MEMORY_SOURCE_ID })).toContain(slug);
    await extractStaleFromDB(engine, {
      dryRun: false, quiet: true, jsonMode: true, catchUp: false, includeFrontmatter: false,
      sourceIdFilter: DAILY_MEMORY_SOURCE_ID,
    });
    const targets = (await engine.getLinks(first.slug, { sourceId: DAILY_MEMORY_SOURCE_ID })).map(link => link.to_slug);
    for (const slug of slugs) expect(targets).toContain(slug);
    await engine.executeRaw("UPDATE source_records SET id = 'replacement-slash-id' WHERE source_type = 'mail/slack'", []);
    await writeSeptember30();
    const refreshed = (await engine.getPage(first.slug, { sourceId: DAILY_MEMORY_SOURCE_ID }))!;
    expect([...refreshed.compiled_truth.matchAll(/\[\[dream:(source-records\/[^\]]+)\]\]/g)].map(match => match[1])).toEqual(slugs);
  });

  test('source record day boundaries use Manila midnight and count record-only activity', async () => {
    await seedRecord('before', 'gmail', '2026-09-29T15:59:59.999Z');
    await seedRecord('start', 'gmail', '2026-09-29T16:00:00Z');
    await seedRecord('end', 'gmail', '2026-09-30T15:59:59.999Z');
    await seedRecord('after', 'gmail', '2026-09-30T16:00:00Z');
    const result = await writeSeptember30();
    expect(result.written).toBe(true);
    expect(result.day).toBe('2026-09-30');
    const page = await engine.getPage(result.slug, { sourceId: DAILY_MEMORY_SOURCE_ID });
    expect(page!.compiled_truth).toContain('gmail: 2 records changed');
    expect(page!.compiled_truth.match(/\[\[dream:source-records\/gmail\//g)).toHaveLength(2);
  });

  test('record slugs survive changed row IDs and repeated writes without duplicates', async () => {
    await seedRecord('gmail:original', 'gmail', '2026-09-30T00:00:00Z');
    const result = await writeSeptember30();
    const first = await engine.getPage(result.slug, { sourceId: DAILY_MEMORY_SOURCE_ID });
    const slug = first!.compiled_truth.match(/\[\[dream:(source-records\/[^\]]+)\]\]/)![1];
    await engine.executeRaw(`UPDATE source_records SET id = 'replacement-id'`, []);
    await writeSeptember30();
    await writeSeptember30();
    const page = await engine.getPage(result.slug, { sourceId: DAILY_MEMORY_SOURCE_ID });
    expect(page!.compiled_truth).toContain(`[[dream:${slug}]]`);
    const record = await engine.getPage(slug, { sourceId: DAILY_MEMORY_SOURCE_ID });
    expect(record!.frontmatter.source_record_id).toBe('replacement-id');
    expect(record!.frontmatter.source_record_ref).toBe('gmail:original');
    const count = await engine.executeRaw<{ total: number }>('SELECT count(*)::int AS total FROM pages', []);
    expect(count[0].total).toBe(2);
  });

  test('human daily guard runs before metadata pages are created', async () => {
    await seedRecord('gmail:1', 'gmail', '2026-09-30T00:00:00Z');
    await engine.putPage(dailyMemorySlug('2026-09-30'), { type: 'note', title: 'Human day', compiled_truth: 'Preserve me' }, { sourceId: DAILY_MEMORY_SOURCE_ID });
    const result = await writeSeptember30();
    expect(result.reason).toBe('human_page');
    const count = await engine.executeRaw<{ total: number }>(
      `SELECT count(*)::int AS total FROM pages WHERE slug LIKE 'source-records/%'`, [],
    );
    expect(count[0].total).toBe(0);
  });

  test('human record index pages are preserved and deleted ones remain unlinked', async () => {
    await seedRecord('gmail:1', 'gmail', '2026-09-30T00:00:00Z');
    const result = await writeSeptember30();
    const first = await engine.getPage(result.slug, { sourceId: DAILY_MEMORY_SOURCE_ID });
    const slug = first!.compiled_truth.match(/\[\[dream:(source-records\/[^\]]+)\]\]/)![1];
    await engine.putPage(slug, { type: 'note', title: 'Human index', compiled_truth: 'Keep me', frontmatter: {} }, { sourceId: DAILY_MEMORY_SOURCE_ID });
    await writeSeptember30();
    expect((await engine.getPage(slug, { sourceId: DAILY_MEMORY_SOURCE_ID }))!.compiled_truth).toBe('Keep me');
    await engine.softDeletePage(slug, { sourceId: DAILY_MEMORY_SOURCE_ID });
    await writeSeptember30();
    const daily = await engine.getPage(result.slug, { sourceId: DAILY_MEMORY_SOURCE_ID });
    expect(daily!.compiled_truth).not.toContain(`[[dream:${slug}]]`);
    const deleted = await engine.getPage(slug, { sourceId: DAILY_MEMORY_SOURCE_ID, includeDeleted: true });
    expect(deleted!.deleted_at).toBeTruthy();
    expect(deleted!.compiled_truth).toBe('Keep me');
  });

  test('absent source_records table still permits page indexing', async () => {
    await engine.executeRaw('DROP TABLE IF EXISTS source_records', []);
    await seedTodayPage();
    const result = await writeDailyMemoryFromSources(engine);
    expect(result.written).toBe(true);
    const page = await engine.getPage(result.slug, { sourceId: DAILY_MEMORY_SOURCE_ID });
    expect(page!.compiled_truth).toContain('[[notes:meetings/standup]]');
  });

  test('a UTC-midnight effective_date stays on that calendar day west of UTC', async () => {
    await engine.setConfig('cycle.timezone', 'America/Los_Angeles');
    await engine.putPage('notes/dated', { type: 'note', title: 'Dated note', compiled_truth: 'body' });
    await engine.executeRaw(
      `UPDATE pages SET effective_date = '2026-09-29T00:00:00Z'::timestamptz,
        updated_at = '2026-09-28T12:00:00Z'::timestamptz WHERE slug = 'notes/dated'`,
    );
    await engine.putPage('notes/clock', { type: 'note', title: 'Clock fallback', compiled_truth: 'body' });
    await engine.executeRaw(
      `UPDATE pages SET effective_date = NULL,
        updated_at = '2026-09-29T15:00:00Z'::timestamptz WHERE slug = 'notes/clock'`,
    );
    await engine.putPage('notes/previous-local-day', { type: 'note', title: 'Previous local day', compiled_truth: 'body' });
    await engine.executeRaw(
      `UPDATE pages SET effective_date = NULL,
        updated_at = '2026-09-29T06:59:59Z'::timestamptz WHERE slug = 'notes/previous-local-day'`,
    );
    const result = await writeDailyMemoryFromSources(engine, { date: '2026-09-29' });
    expect(result.day).toBe('2026-09-29');
    expect(result.written).toBe(true);
    const page = await engine.getPage(result.slug, { sourceId: DAILY_MEMORY_SOURCE_ID });
    expect(page!.compiled_truth).toContain('[[default:notes/dated]]');
    expect(page!.compiled_truth).toContain('[[default:notes/clock]]');
    expect(page!.compiled_truth).not.toContain('previous-local-day');
  });

  test('an offset datetime uses the cycle timezone and a UTC-midnight date stays calendar', async () => {
    await engine.putPage('notes/manila-event', { type: 'note', title: 'Manila event', compiled_truth: 'body' });
    await engine.executeRaw(
      `UPDATE pages SET effective_date = '2026-09-30T00:30:00+08:00'::timestamptz,
        updated_at = '2026-09-01T00:00:00Z'::timestamptz WHERE slug = 'notes/manila-event'`,
    );
    await engine.setConfig('cycle.timezone', 'Asia/Manila');
    const manila = await writeDailyMemoryFromSources(engine, { date: '2026-09-30' });
    expect(manila.written).toBe(true);
    expect((await engine.getPage(manila.slug, { sourceId: DAILY_MEMORY_SOURCE_ID }))!.compiled_truth)
      .toContain('[[default:notes/manila-event]]');
    await engine.softDeletePage(manila.slug, { sourceId: DAILY_MEMORY_SOURCE_ID });

    await engine.setConfig('cycle.timezone', 'America/Los_Angeles');
    const losAngeles = await writeDailyMemoryFromSources(engine, { date: '2026-09-30' });
    expect(losAngeles.reason).toBe('no_source_activity');
    const previous = await writeDailyMemoryFromSources(engine, { date: '2026-09-29' });
    expect((await engine.getPage(previous.slug, { sourceId: DAILY_MEMORY_SOURCE_ID }))!.compiled_truth)
      .toContain('[[default:notes/manila-event]]');
  });

  test('an explicit cycle day is not shifted by a timezone west of UTC', async () => {
    await engine.setConfig('cycle.timezone', 'America/Los_Angeles');
    const args = dailyMemoryArgs('2026-09-29');
    expect(args).toEqual({ date: '2026-09-29' });
    const result = await writeDailyMemoryFromSources(engine, args);
    expect(result.day).toBe('2026-09-29');
    expect(result.slug).toBe('daily-memory/2026-09-29');
    expect(result.reason).toBe('no_source_activity');
    expect(dailyMemoryArgs(undefined)).toEqual({});
    expect(() => dailyMemoryArgs('2026-02-31')).toThrow('YYYY-MM-DD');
  });

  test('page indexing retains the 40-link cap and effective-date calendar precedence', async () => {
    await engine.setConfig('cycle.timezone', 'Asia/Manila');
    for (let i = 0; i < 42; i++) {
      const slug = `notes/page-${String(i).padStart(2, '0')}`;
      await engine.putPage(slug, { type: 'note', title: 'Today page', compiled_truth: 'private body' });
      await engine.executeRaw(
        `UPDATE pages SET effective_date = '2026-09-30T00:00:00Z'::timestamptz,
          updated_at = '2026-10-01T00:00:00Z'::timestamptz WHERE slug = $1`, [slug],
      );
    }
    await engine.putPage('notes/previous-day', { type: 'note', title: 'Previous day', compiled_truth: 'Earlier note' });
    await engine.executeRaw(
      `UPDATE pages SET effective_date = '2026-09-29T00:00:00Z'::timestamptz,
        updated_at = '2026-09-30T00:00:00Z'::timestamptz WHERE slug = 'notes/previous-day'`, [],
    );
    // These precede the accepted labels but their UTC day only is September30.
    for (let i = 0; i < 85; i++) {
      await engine.putPage(`notes/aaa-instant-${String(i).padStart(2, '0')}`, {
        type: 'note', title: 'Other local day', compiled_truth: 'Synthetic fixture',
        frontmatter: { date: '2026-09-30T23:30:00Z', unrelated_blob: 'x'.repeat(32768) },
      });
    }
    await engine.executeRaw(`UPDATE pages SET effective_date='2026-09-30T23:30:00Z'::timestamptz,
      effective_date_source='date', updated_at='2026-10-01T00:00:00Z'::timestamptz
      WHERE slug LIKE 'notes/aaa-instant-%'`, []);
    const executeRaw = engine.executeRaw;
    let batches = 0;
    engine.executeRaw = (async function(this: PGLiteEngine, sql: string, params?: unknown[]) {
      const selected = await executeRaw.call(this, sql, params);
      if (sql.includes('AS utc_day')) {
        batches++;
        expect(selected.length).toBeLessThanOrEqual(40);
        for (const row of selected as { frontmatter: Record<string, unknown> }[]) {
          expect(row.frontmatter).not.toHaveProperty('unrelated_blob');
        }
      }
      return selected;
    }) as typeof engine.executeRaw;
    let result;
    try { result = await writeSeptember30(); } finally { engine.executeRaw = executeRaw; }
    expect(batches).toBeGreaterThan(3);
    expect(result.pages).toBe(40);
    const page = await engine.getPage(result.slug, { sourceId: DAILY_MEMORY_SOURCE_ID });
    expect(page!.compiled_truth).toContain('40 of 42 pages are linked.');
    expect(page!.compiled_truth).not.toContain('previous-day');
    expect(page!.compiled_truth.match(/\[\[default:notes\/page-/g)).toHaveLength(40);
  });

  test('existing ratio_session pages are linked without creating or changing sessions', async () => {
    await engine.putPage('ratio/sessions/example-session', {
      type: 'ratio_session', title: 'Example session', compiled_truth: 'private session body',
    });
    const before = await engine.getPage('ratio/sessions/example-session');
    const result = await writeDailyMemoryFromSources(engine);
    expect(result.written).toBe(true);
    const page = await engine.getPage(result.slug, { sourceId: DAILY_MEMORY_SOURCE_ID });
    expect(page!.compiled_truth).toContain('[[default:ratio/sessions/example-session]]');
    expect(page!.compiled_truth).not.toContain('private session body');
    const after = await engine.getPage('ratio/sessions/example-session');
    expect(after!.compiled_truth).toBe(before!.compiled_truth);
    expect(after!.updated_at).toEqual(before!.updated_at);
    const sessions = await engine.executeRaw<{ total: number }>(
      `SELECT count(*)::int AS total FROM pages WHERE type = 'ratio_session'`, [],
    );
    expect(sessions[0].total).toBe(1);
  });

  test('dream daily notes refresh, including a soft-deleted generated note', async () => {
    await seedRecord('gmail:1', 'gmail', '2026-09-30T00:00:00Z');
    const slug = dailyMemorySlug('2026-09-30');
    await engine.putPage(slug, {
      type: 'note', title: 'Old generated note', compiled_truth: 'old index',
      frontmatter: { dream_generated: true },
    }, { sourceId: DAILY_MEMORY_SOURCE_ID });
    await engine.softDeletePage(slug, { sourceId: DAILY_MEMORY_SOURCE_ID });
    const result = await writeSeptember30();
    expect(result.written).toBe(true);
    const page = await engine.getPage(slug, { sourceId: DAILY_MEMORY_SOURCE_ID });
    expect(page!.compiled_truth).toContain('gmail: 1 record changed');
    expect(page!.compiled_truth).not.toContain('old index');
    expect(page!.deleted_at ?? null).toBeNull();
  });

  test('dailyMemoryDaysForSlugs includes soft-deleted pages so prior indexes can drop them', async () => {
    await engine.setConfig('cycle.timezone', 'Asia/Manila');
    await engine.putPage('notes/gone', {
      type: 'note', title: 'Gone', compiled_truth: 'was here',
      frontmatter: { date: '2026-09-20' },
    }, { sourceId: 'default' });
    await engine.executeRaw(
      "UPDATE pages SET effective_date='2026-09-20T00:00:00Z'::timestamptz, effective_date_source='date' WHERE source_id='default' AND slug='notes/gone'",
    );
    await engine.softDeletePage('notes/gone', { sourceId: 'default' });
    const days = await dailyMemoryDaysForSlugs(engine, 'default', ['notes/gone']);
    expect(days).toEqual(['2026-09-20']);
  });



  test('dailyMemoryDaysForSlugs includes prior dates when a page moves', async () => {
    await engine.setConfig('cycle.timezone', 'Asia/Manila');
    await ensureDailyMemorySource(engine);
    await engine.putPage('notes/moving', {
      type: 'note', title: 'Moving', compiled_truth: 'was Sep 10',
      frontmatter: { date: '2026-09-10' },
    }, { sourceId: 'default' });
    await engine.executeRaw(
      "UPDATE pages SET effective_date='2026-09-10T00:00:00Z'::timestamptz, effective_date_source='date' WHERE source_id='default' AND slug='notes/moving'",
    );
    // Prior index link still points at the old day after the move.
    await engine.putPage(dailyMemorySlug('2026-09-10'), {
      type: 'note', title: 'Daily memory 2026-09-10',
      compiled_truth: 'See [[notes/moving]].',
      frontmatter: { dream_generated: true, dream_cycle_date: '2026-09-10', visibility: 'private' },
    }, { sourceId: DAILY_MEMORY_SOURCE_ID });
    const from = await engine.getPage(dailyMemorySlug('2026-09-10'), { sourceId: DAILY_MEMORY_SOURCE_ID });
    const to = await engine.getPage('notes/moving', { sourceId: 'default' });
    await engine.executeRaw(
      `INSERT INTO links (from_page_id, to_page_id, link_type, link_source)
       VALUES ($1, $2, '', 'markdown')`,
      [from!.id, to!.id],
    );
    await engine.putPage('notes/moving', {
      type: 'note', title: 'Moving', compiled_truth: 'now Sep 20',
      frontmatter: { date: '2026-09-20' },
    }, { sourceId: 'default' });
    await engine.executeRaw(
      "UPDATE pages SET effective_date='2026-09-20T00:00:00Z'::timestamptz, effective_date_source='date' WHERE source_id='default' AND slug='notes/moving'",
    );
    const days = await dailyMemoryDaysForSlugs(engine, 'default', ['notes/moving']);
    expect(days).toContain('2026-09-10');
    expect(days).toContain('2026-09-20');
  });

  test('writeDailyMemoryFromSources omits wikilink delimiter slugs from generated targets', async () => {
    await engine.setConfig('cycle.timezone', 'UTC');
    for (const slug of ['notes/foo|bar', 'notes/foo#heading', 'notes/foo^block']) {
      await engine.putPage(slug, {
        type: 'note', title: slug, compiled_truth: 'body',
        frontmatter: { date: '2026-09-30' },
      }, { sourceId: 'default' });
      await engine.executeRaw(
        "UPDATE pages SET effective_date='2026-09-30T00:00:00Z'::timestamptz, effective_date_source='date' WHERE source_id='default' AND slug=$1",
        [slug],
      );
    }
    await engine.putPage('notes/safe', {
      type: 'note', title: 'Safe', compiled_truth: 'body',
      frontmatter: { date: '2026-09-30' },
    }, { sourceId: 'default' });
    await engine.executeRaw(
      "UPDATE pages SET effective_date='2026-09-30T00:00:00Z'::timestamptz, effective_date_source='date' WHERE source_id='default' AND slug='notes/safe'",
    );
    const result = await writeDailyMemoryFromSources(engine, { date: '2026-09-30' });
    expect(result.written).toBe(true);
    const page = await engine.getPage(dailyMemorySlug('2026-09-30'), { sourceId: DAILY_MEMORY_SOURCE_ID });
    expect(page!.compiled_truth).toContain('[[default:notes/safe]]');
    expect(page!.compiled_truth).not.toContain('foo|bar');
    expect(page!.compiled_truth).not.toContain('foo#heading');
    expect(page!.compiled_truth).not.toContain('foo^block');
  });

  test('dailyMemoryDaysForSlugs recovers prior event_date and zoned instant dates from versions', async () => {
    await engine.setConfig('cycle.timezone', 'Asia/Manila');
    await engine.putPage('notes/versioned', {
      type: 'note', title: 'Versioned', compiled_truth: 'old',
      frontmatter: { event_date: '2026-09-10' },
    }, { sourceId: 'default' });
    await engine.executeRaw(
      "UPDATE pages SET effective_date='2026-09-10T00:00:00Z'::timestamptz, effective_date_source='event_date' WHERE source_id='default' AND slug='notes/versioned'",
    );
    await engine.createVersion('notes/versioned', { sourceId: 'default' });
    await engine.putPage('notes/versioned', {
      type: 'note', title: 'Versioned', compiled_truth: 'mid',
      frontmatter: {
        date: '2026-09-20T16:30:00.000Z',
        [DATE_INSTANT_PROVENANCE]: { date: '2026-09-20T16:30:00.000Z' },
      },
    }, { sourceId: 'default' });
    await engine.executeRaw(
      "UPDATE pages SET effective_date='2026-09-20T16:30:00Z'::timestamptz, effective_date_source='date' WHERE source_id='default' AND slug='notes/versioned'",
    );
    await engine.createVersion('notes/versioned', { sourceId: 'default' });
    await engine.putPage('notes/versioned', {
      type: 'note', title: 'Versioned', compiled_truth: 'new',
      frontmatter: { date: '2026-09-25' },
    }, { sourceId: 'default' });
    await engine.executeRaw(
      "UPDATE pages SET effective_date='2026-09-25T00:00:00Z'::timestamptz, effective_date_source='date' WHERE source_id='default' AND slug='notes/versioned'",
    );
    const days = await dailyMemoryDaysForSlugs(engine, 'default', ['notes/versioned']);
    expect(days).toContain('2026-09-10'); // event_date from first version
    expect(days).toContain('2026-09-21'); // 16:30Z instant in Asia/Manila
    expect(days).toContain('2026-09-25'); // live calendar date
  });

  test('same-day revision conflict rescans and keeps the full index', async () => {
    await engine.setConfig('cycle.timezone', 'UTC');
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ($1, $1)`, ['notes']);
    await engine.putPage('notes/early', {
      type: 'note', title: 'Early', compiled_truth: 'early body',
      frontmatter: { date: '2026-09-30' },
    }, { sourceId: 'notes' });
    await engine.executeRaw(
      "UPDATE pages SET effective_date='2026-09-30T00:00:00Z'::timestamptz, effective_date_source='date' WHERE source_id='notes' AND slug='notes/early'",
    );
    expect((await writeDailyMemoryFromSources(engine, { date: '2026-09-30' })).written).toBe(true);

    await engine.putPage('notes/late', {
      type: 'note', title: 'Late', compiled_truth: 'late body',
      frontmatter: { date: '2026-09-30' },
    }, { sourceId: 'notes' });
    await engine.executeRaw(
      "UPDATE pages SET effective_date='2026-09-30T00:00:00Z'::timestamptz, effective_date_source='date' WHERE source_id='notes' AND slug='notes/late'",
    );

    let conflicts = 0;
    const realPut = engine.putPage.bind(engine);
    const putSpy = spyOn(engine, 'putPage').mockImplementation(async (slug, page, opts) => {
      if (opts?.sourceId === DAILY_MEMORY_SOURCE_ID && conflicts === 0) {
        conflicts += 1;
        throw new PageRevisionConflictError(
          '11111111-1111-1111-1111-111111111111',
          '22222222-2222-2222-2222-222222222222',
        );
      }
      return realPut(slug, page, opts);
    });

    const result = await writeDailyMemoryFromSources(engine, { date: '2026-09-30' });
    putSpy.mockRestore();
    expect(conflicts).toBe(1);
    expect(result.reason).not.toBe('error');
    expect(result.written).toBe(true);
    const page = await engine.getPage(dailyMemorySlug('2026-09-30'), { sourceId: DAILY_MEMORY_SOURCE_ID });
    expect(page!.compiled_truth).toContain('[[notes:notes/early]]');
    expect(page!.compiled_truth).toContain('[[notes:notes/late]]');
  });

  test('concurrent same-day writers converge on the full day index', async () => {
    await engine.setConfig('cycle.timezone', 'UTC');
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ($1, $1)`, ['notes']);
    for (const slug of ['notes/a', 'notes/b', 'notes/c']) {
      await engine.putPage(slug, {
        type: 'note', title: slug, compiled_truth: 'body',
        frontmatter: { date: '2026-09-30' },
      }, { sourceId: 'notes' });
      await engine.executeRaw(
        "UPDATE pages SET effective_date='2026-09-30T00:00:00Z'::timestamptz, effective_date_source='date' WHERE source_id='notes' AND slug=$1",
        [slug],
      );
    }
    const results = await Promise.all([
      writeDailyMemoryFromSources(engine, { date: '2026-09-30' }),
      writeDailyMemoryFromSources(engine, { date: '2026-09-30' }),
      writeDailyMemoryFromSources(engine, { date: '2026-09-30' }),
    ]);
    expect(results.every(r => r.reason !== 'error')).toBe(true);
    expect(results.some(r => r.written || r.reason === 'unchanged')).toBe(true);
    const page = await engine.getPage(dailyMemorySlug('2026-09-30'), { sourceId: DAILY_MEMORY_SOURCE_ID });
    expect(page!.compiled_truth).toContain('[[notes:notes/a]]');
    expect(page!.compiled_truth).toContain('[[notes:notes/b]]');
    expect(page!.compiled_truth).toContain('[[notes:notes/c]]');
  });

  test('source-record revision conflict retries and keeps newer metadata', async () => {
    await engine.setConfig('cycle.timezone', 'UTC');
    await seedRecord('cas-record', 'gmail', '2026-09-30T00:00:00Z');
    const newerUpdated = '2026-09-30T12:00:00.000Z';
    let conflicts = 0;
    const realPut = engine.putPage.bind(engine);
    const putSpy = spyOn(engine, 'putPage').mockImplementation(async (slug, page, opts) => {
      if (
        opts?.sourceId === DAILY_MEMORY_SOURCE_ID
        && typeof slug === 'string'
        && slug.startsWith('source-records/')
        && conflicts === 0
      ) {
        conflicts += 1;
        await realPut(slug, {
          type: 'note',
          title: 'gmail message record',
          compiled_truth: [
            'Source: gmail',
            'Record ID: cas-record-replacement',
            'Source reference: cas-record',
            'Entity type: message',
            'Entity ID: cas-record',
            `Updated: ${newerUpdated}`,
            '',
          ].join('\n'),
          timeline: '',
          frontmatter: {
            dream_generated: true,
            visibility: 'private',
            source_record_id: 'cas-record-replacement',
            source_record_type: 'gmail',
            source_record_ref: 'cas-record',
            source_record_updated_at: newerUpdated,
            raw_trace_exempt: true,
            raw_trace_exempt_reason: 'source record metadata index; payload stays in source_records',
          },
        }, { sourceId: DAILY_MEMORY_SOURCE_ID, force: true });
        throw new PageRevisionConflictError(
          '11111111-1111-1111-1111-111111111111',
          '22222222-2222-2222-2222-222222222222',
        );
      }
      return realPut(slug, page, opts);
    });

    const result = await writeDailyMemoryFromSources(engine, { date: '2026-09-30' });
    putSpy.mockRestore();
    expect(conflicts).toBe(1);
    expect(result.reason).not.toBe('error');
    expect(result.written).toBe(true);
    const pages = await engine.executeRaw<{ slug: string; updated_at: string }>(
      `SELECT slug, frontmatter->>'source_record_updated_at' AS updated_at
       FROM pages WHERE source_id=$1 AND slug LIKE 'source-records/%' AND deleted_at IS NULL`,
      [DAILY_MEMORY_SOURCE_ID],
    );
    expect(pages).toHaveLength(1);
    expect(pages[0]!.updated_at).toBe(newerUpdated);
    const idRow = await engine.executeRaw<{ id: string }>(
      `SELECT frontmatter->>'source_record_id' AS id
       FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL`,
      [DAILY_MEMORY_SOURCE_ID, pages[0]!.slug],
    );
    expect(idRow[0]!.id).toBe('cas-record-replacement');
  });




  test('pins one timezone across transcript ingest finish discovery and enqueue after cycle.timezone flips', async () => {
    await engine.setConfig('cycle.timezone', 'Asia/Manila');
    const slug = 'sessions/ingest-tz-pin';
    await engine.putPage(slug, {
      type: 'note', title: 'Synthetic ingest tz pin', compiled_truth: 'Synthetic fixture',
      frontmatter: { date: '2026-09-30T16:30:00Z' },
      effective_date: new Date('2026-09-30T16:30:00Z'), effective_date_source: 'date',
    });
    const owner = (await createTranscriptIngestDailyMemory(engine, { sourceId: 'default', runKey: 'ingest-tz-pin' }))!;
    await owner.before([slug]);
    await owner.touched([slug]);
    await engine.setConfig('cycle.timezone', 'America/Los_Angeles');
    await owner.finish();
    const queued = await engine.executeRaw<{ data: { daily_memory_dates?: string[]; daily_memory_timezone?: string } }>(
      "SELECT data FROM minion_jobs WHERE name='autopilot-daily-memory'");
    expect(queued.some(row => row.data.daily_memory_timezone === 'Asia/Manila'
      && (row.data.daily_memory_dates ?? []).includes('2026-10-01'))).toBe(true);
    expect(queued.every(row => row.data.daily_memory_timezone !== 'America/Los_Angeles')).toBe(true);
  });


});
