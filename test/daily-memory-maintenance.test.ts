/**
 * The daily maintenance job writes one durable memory from pages that
 * already live in sources. The test calls `autopilot-global-maintenance`
 * the way that job does: no phase list, so the handler defaults to
 * MAINTENANCE_PHASES and writes the note before the cycle.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';
import { resolveCycleDate } from '../src/core/cycle/cycle-date.ts';
import { dailyMemorySlug, DAILY_MEMORY_SOURCE_ID, writeDailyMemoryFromSources } from '../src/core/cycle/daily-memory.ts';
import { computeEffectiveDate } from '../src/core/effective-date.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { extractEntityRefs } from '../src/core/link-extraction.ts';
import { runTranscriptsIngest } from '../src/core/transcripts/ingest.ts';
import { dailyMemoryArgs } from '../scripts/write-daily-memory.ts';

describe('daily memory from sources the brain already holds', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 30000);
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => { await resetPgliteState(engine); });

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
    expect(page!.compiled_truth).toContain('[[notes/instant]]');
    expect(page!.compiled_truth).toContain('[[notes/calendar]]');
    expect(page!.compiled_truth).not.toContain('[[notes/previous-calendar]]');
    await writeDailyMemoryFromSources(engine, { date: '2026-09-29' });
    const previous = await engine.getPage(dailyMemorySlug('2026-09-29'));
    expect(previous!.compiled_truth).not.toContain('[[notes/instant]]');
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
    expect(today!.compiled_truth).toContain('[[notes/yaml-calendar]]');
    expect(today!.compiled_truth).toContain('[[notes/yaml-local-midnight]]');
    expect(today!.compiled_truth).not.toContain('[[notes/yaml-utc-midnight]]');
    await writeDailyMemoryFromSources(engine, { date: '2026-09-29' });
    const previous = await engine.getPage(dailyMemorySlug('2026-09-29'));
    expect(previous!.compiled_truth).toContain('[[notes/yaml-utc-midnight]]');
    expect(previous!.compiled_truth).not.toContain('[[notes/yaml-calendar]]');
    expect(previous!.compiled_truth).not.toContain('[[notes/yaml-local-midnight]]');
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
    expect(page!.compiled_truth).toContain('[[notes/midnight]]');
    expect(page!.compiled_truth).toContain('[[notes/anchor]]');
    expect(page!.compiled_truth).not.toContain('[[notes/calendar-value]]');
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
    expect(today!.compiled_truth).toContain('[[notes/legacy-calendar]]');
    expect(today!.compiled_truth).not.toContain('[[notes/fresh-iso-instant]]');
    expect(today!.compiled_truth).not.toContain('[[notes/fresh-date-object]]');
    await writeDailyMemoryFromSources(engine, { date: '2026-09-29' });
    const previous = await engine.getPage(dailyMemorySlug('2026-09-29'));
    expect(previous!.compiled_truth).not.toContain('[[notes/legacy-calendar]]');
    expect(previous!.compiled_truth).toContain('[[notes/fresh-iso-instant]]');
    expect(previous!.compiled_truth).toContain('[[notes/fresh-date-object]]');
    const edited = (await engine.getPage('notes/fresh-date-object'))!;
    await engine.putPage('notes/fresh-date-object', {
      ...edited, frontmatter: { ...edited.frontmatter, date: '2026-09-30' },
    });
    await writeDailyMemoryFromSources(engine, { date: '2026-09-30' });
    expect((await engine.getPage(dailyMemorySlug('2026-09-30')))!.compiled_truth)
      .toContain('[[notes/fresh-date-object]]');
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
        paths: [file], format: 'codex', sourceId: DAILY_MEMORY_SOURCE_ID,
        dateZone: 'Asia/Manila', sinceIso: '2026-09-29T16:00:00.000Z',
      });
      expect(ingested.pages.imported).toBe(1);
      expect(ingested.cleanScan).toBe(true);
      const slug = ingested.slugsTouched[0]!;
      expect(slug).toContain('2026-09-29');
      const session = await engine.getPage(slug, { sourceId: DAILY_MEMORY_SOURCE_ID });
      expect(session!.frontmatter.date).toBe('2026-09-30');
      expect(new Date(session!.effective_date!).toISOString()).toBe('2026-09-30T00:00:00.000Z');
      await engine.setConfig('cycle.timezone', 'Asia/Manila');
      await writeDailyMemoryFromSources(engine, { date: '2026-09-30' });
      expect((await engine.getPage(dailyMemorySlug('2026-09-30')))!.compiled_truth).toContain(`[[${slug}]]`);
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
    expect(page!.compiled_truth).not.toContain('[[notes/shared]]');
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
    expect(page!.compiled_truth).toContain('[[source-records/gmail/');
    expect(page!.compiled_truth).toContain('8 of 10 records are linked.');
    expect(page!.compiled_truth.match(/\[\[source-records\/discrawl\//g)).toHaveLength(8);
    expect(page!.compiled_truth).not.toContain('gmail:unpromoted');
    expect(page!.compiled_truth).not.toContain('private');
    for (const [, slug] of page!.compiled_truth.matchAll(/\[\[(source-records\/[^\]]+)\]\]/g)) {
      const recordPage = await engine.getPage(slug, { sourceId: DAILY_MEMORY_SOURCE_ID });
      expect(recordPage).not.toBeNull();
      expect(recordPage!.compiled_truth).not.toContain('private');
    }
    const allPages = await engine.executeRaw<{ total: number }>('SELECT count(*)::int AS total FROM pages', []);
    expect(allPages[0].total).toBe(22);
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
    expect(page!.compiled_truth.match(/\[\[source-records\/gmail\//g)).toHaveLength(2);
  });

  test('record slugs survive changed row IDs and repeated writes without duplicates', async () => {
    await seedRecord('gmail:original', 'gmail', '2026-09-30T00:00:00Z');
    const result = await writeSeptember30();
    const first = await engine.getPage(result.slug, { sourceId: DAILY_MEMORY_SOURCE_ID });
    const slug = first!.compiled_truth.match(/\[\[(source-records\/[^\]]+)\]\]/)![1];
    await engine.executeRaw(`UPDATE source_records SET id = 'replacement-id'`, []);
    await writeSeptember30();
    await writeSeptember30();
    const page = await engine.getPage(result.slug, { sourceId: DAILY_MEMORY_SOURCE_ID });
    expect(page!.compiled_truth).toContain(`[[${slug}]]`);
    const record = await engine.getPage(slug, { sourceId: DAILY_MEMORY_SOURCE_ID });
    expect(record!.frontmatter.source_record_id).toBe('replacement-id');
    expect(record!.frontmatter.source_record_ref).toBe('gmail:original');
    const count = await engine.executeRaw<{ total: number }>('SELECT count(*)::int AS total FROM pages', []);
    expect(count[0].total).toBe(2);
  });

  test('human daily guard runs before metadata pages are created', async () => {
    await seedRecord('gmail:1', 'gmail', '2026-09-30T00:00:00Z');
    await engine.putPage(dailyMemorySlug('2026-09-30'), { type: 'note', title: 'Human day', compiled_truth: 'Preserve me' });
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
    const slug = first!.compiled_truth.match(/\[\[(source-records\/[^\]]+)\]\]/)![1];
    await engine.putPage(slug, { type: 'note', title: 'Human index', compiled_truth: 'Keep me', frontmatter: {} });
    await writeSeptember30();
    expect((await engine.getPage(slug))!.compiled_truth).toBe('Keep me');
    await engine.softDeletePage(slug, { sourceId: DAILY_MEMORY_SOURCE_ID });
    await writeSeptember30();
    const daily = await engine.getPage(result.slug, { sourceId: DAILY_MEMORY_SOURCE_ID });
    expect(daily!.compiled_truth).not.toContain(`[[${slug}]]`);
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
    expect(page!.compiled_truth).toContain('[[notes/dated]]');
    expect(page!.compiled_truth).toContain('[[notes/clock]]');
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
      .toContain('[[notes/manila-event]]');
    await engine.softDeletePage(manila.slug, { sourceId: DAILY_MEMORY_SOURCE_ID });

    await engine.setConfig('cycle.timezone', 'America/Los_Angeles');
    const losAngeles = await writeDailyMemoryFromSources(engine, { date: '2026-09-30' });
    expect(losAngeles.reason).toBe('no_source_activity');
    const previous = await writeDailyMemoryFromSources(engine, { date: '2026-09-29' });
    expect((await engine.getPage(previous.slug, { sourceId: DAILY_MEMORY_SOURCE_ID }))!.compiled_truth)
      .toContain('[[notes/manila-event]]');
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
    const result = await writeSeptember30();
    expect(result.pages).toBe(40);
    const page = await engine.getPage(result.slug, { sourceId: DAILY_MEMORY_SOURCE_ID });
    expect(page!.compiled_truth).toContain('40 of 42 pages are linked.');
    expect(page!.compiled_truth).not.toContain('previous-day');
    expect(page!.compiled_truth.match(/\[\[notes\/page-/g)).toHaveLength(40);
  });

  test('existing ratio_session pages are linked without creating or changing sessions', async () => {
    await engine.putPage('ratio/sessions/example-session', {
      type: 'ratio_session', title: 'Example session', compiled_truth: 'private session body',
    });
    const before = await engine.getPage('ratio/sessions/example-session');
    const result = await writeDailyMemoryFromSources(engine);
    expect(result.written).toBe(true);
    const page = await engine.getPage(result.slug, { sourceId: DAILY_MEMORY_SOURCE_ID });
    expect(page!.compiled_truth).toContain('[[ratio/sessions/example-session]]');
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
});
