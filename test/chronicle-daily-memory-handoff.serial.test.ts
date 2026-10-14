/** Chronicle event and projection publication accepts its historical daily refresh atomically. */
import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { runChronicleExtract, type ChronicleJudge } from '../src/core/chronicle/extract-events.ts';
import { ensureDailyMemorySource, DAILY_MEMORY_SOURCE_ID, dailyMemorySlug } from '../src/core/cycle/daily-memory.ts';
import { runDailyMemoryJob } from '../src/core/cycle/daily-memory-followup.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
let schemaVersion: string | null;
const sourceId = 'chronicle-history', slug = 'meetings/fixture';
const judge: ChronicleJudge = async () => ({ events: [{
  when: '2026-09-20T17:00:00Z', who: [], what: 'Synthetic historical decision', kind: 'decision',
}] });
const extract = () => runChronicleExtract(engine, { sourceId, slug, judge, tz: 'UTC' });
const events = () => engine.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE source_id=$1 AND type=\'event\'', [sourceId]);
const jobs = () => engine.executeRaw<{ data: { daily_memory_dates?: string[]; daily_memory_date?: string } }>(
  "SELECT data FROM minion_jobs WHERE name='autopilot-daily-memory'");
beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  schemaVersion = await engine.getConfig('version');
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  if (schemaVersion) await engine.setConfig('version', schemaVersion);
  await engine.setConfig('cycle.timezone', 'Asia/Manila');
  await ensureDailyMemorySource(engine);
  await engine.executeRaw("INSERT INTO sources(id,name) VALUES($1,'Chronicle fixture')", [sourceId]);
  await engine.putPage(slug, { type: 'meeting', title: 'Fixture', compiled_truth: 'Synthetic meeting evidence',
    effective_date: new Date('2026-09-20T00:00:00Z') }, { sourceId });
});

test('refresh day follows brain timezone rather than event slug or projection UTC day', async () => {
  expect((await extract()).events_written).toBe(1);
  const [event] = await events();
  expect(event.slug).toStartWith('life/events/2026-09-20-');
  expect((await jobs()).some(job => job.data.daily_memory_dates?.includes('2026-09-21'))).toBe(true);
  expect((await jobs()).some(job => job.data.daily_memory_dates?.includes('2026-09-20'))).toBe(false);
  const queue = new MinionQueue(engine);
  const child = await queue.claim('chronicle-day-lock', 60_000, 'default', ['autopilot-daily-memory']);
  if (!child) throw new Error('Expected accepted historical refresh');
  await queue.completeJob(child.id, 'chronicle-day-lock', await runDailyMemoryJob(engine, child));
  expect((await engine.getPage(dailyMemorySlug('2026-09-21'), { sourceId: DAILY_MEMORY_SOURCE_ID }))?.compiled_truth)
    .toContain(`[[${sourceId}:${event.slug}]]`);
});

test('rejected settlement rolls back event, projection and accepted child; retry publishes once', async () => {
  const original = MinionQueue.prototype.add;
  let calls = 0;
  const add = spyOn(MinionQueue.prototype, 'add').mockImplementation(async function(this: MinionQueue, ...args: Parameters<MinionQueue['add']>) {
    if (++calls === 2) throw new Error('synthetic chronicle settlement outage');
    return original.call(this, ...args);
  });
  try { await expect(extract()).rejects.toThrow('synthetic chronicle settlement outage'); }
  finally { add.mockRestore(); }
  expect(calls).toBe(2);
  expect(await events()).toHaveLength(0);
  expect(await engine.executeRaw('SELECT id FROM timeline_entries WHERE event_page_id IS NOT NULL')).toHaveLength(0);
  expect(await jobs()).toHaveLength(0);
  await extract();
  expect(await events()).toHaveLength(1);
  expect(await engine.executeRaw('SELECT id FROM timeline_entries WHERE event_page_id IS NOT NULL')).toHaveLength(1);
  expect(await jobs()).toHaveLength(2);
});

test('re-publication retains an existing event prior day alongside its new effective day', async () => {
  await extract();
  const [event] = await events();
  await engine.executeRaw("UPDATE pages SET effective_date='2026-09-18T00:00:00Z'::timestamptz WHERE source_id=$1 AND slug=$2", [sourceId, event.slug]);
  await extract();
  expect((await jobs()).some(job => ['2026-09-18', '2026-09-21'].every(day => job.data.daily_memory_dates?.includes(day)))).toBe(true);
  expect(await events()).toHaveLength(1);
  expect(await engine.executeRaw('SELECT id FROM timeline_entries WHERE event_page_id IS NOT NULL')).toHaveLength(1);
});
