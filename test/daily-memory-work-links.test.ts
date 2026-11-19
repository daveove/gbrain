/**
 * DAV-6364: the day index lists the Linear issues and GitHub pull requests
 * that the day's harness session pages mention. Every fixture is invented.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  dailyMemorySlug, DAILY_MEMORY_SOURCE_ID, DAILY_MEMORY_WORK_LINK_CAP, DAILY_MEMORY_WORK_SESSION_CAP,
  ensureDailyMemorySource, extractWorkReferences, writeDailyMemoryFromSources,
} from '../src/core/cycle/daily-memory.ts';

const DAY = '2026-09-10';
const ZONE = 'UTC';

describe('extractWorkReferences', () => {
  test('keeps text order and one entry per mention', () => {
    expect(extractWorkReferences('Fix DAV-12 then acme/widgets#7, and DAV-12 again.'))
      .toEqual(['DAV-12', 'acme/widgets#7', 'DAV-12']);
  });

  test('a Linear issue URL and a pull request URL each count once', () => {
    expect(extractWorkReferences(
      'See https://linear.app/team/issue/DAV-40/fix-the-thing and https://github.com/Acme/Widgets/pull/9/files.',
    )).toEqual(['DAV-40', 'acme/widgets#9']);
    expect(extractWorkReferences('Opened github.com/acme/widgets/pull/10 today.')).toEqual(['acme/widgets#10']);
  });

  test('an id inside any other URL is not a reference', () => {
    expect(extractWorkReferences([
      'https://desk.example/now?item=DAV-41',
      'https://github.com/acme/widgets/tree/DAV-42-branch',
      'https://github.com/acme/widgets/issues/43',
      'https://example.com/acme/widgets#44',
    ].join(' '))).toEqual([]);
  });

  test('ids glued to other words, lowercase branch names and paths are not references', () => {
    expect(extractWorkReferences('xDAV-1 DAV-2x dav-3-branch src/file.ts#L4 ./acme/widgets#5 @scope/pkg#6')).toEqual([]);
  });

  test('an id in a code span still counts', () => {
    expect(extractWorkReferences('Run `gh pr view acme/widgets#11` for `DAV-13`.')).toEqual(['acme/widgets#11', 'DAV-13']);
  });
});

describe('daily memory Work section', () => {
  let engine: PGLiteEngine;
  let schemaVersion: string | null;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); schemaVersion = await engine.getConfig('version'); }, 180_000);
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => { await resetPgliteState(engine); if (schemaVersion) await engine.setConfig('version', schemaVersion); await ensureDailyMemorySource(engine); }, 120_000);

  async function putPage(slug: string, body: string, date = DAY): Promise<void> {
    await engine.putPage(slug, {
      type: slug.startsWith('conversations/') ? 'conversation' : 'note', title: `Fixture ${slug}`, compiled_truth: body,
      frontmatter: { date }, effective_date: new Date(`${date}T00:00:00Z`), effective_date_source: 'date',
    });
  }

  async function note(): Promise<string> {
    const page = await engine.getPage(dailyMemorySlug(DAY), { sourceId: DAILY_MEMORY_SOURCE_ID });
    return page!.compiled_truth;
  }

  const session = (n: string) => `conversations/sessions/${DAY}-omp-${n.padStart(12, '0')}`;
  const link = (n: string) => `[[default:${session(n)}]]`;

  test('lists each issue and pull request once, first seen, with its session links', async () => {
    await putPage(session('a'), [
      'User: work on DAV-101 and acme/widgets#61.',
      'Assistant: DAV-101 is open; https://github.com/acme/widgets/pull/61 is the same pull request.',
      'Assistant: also https://linear.app/team/issue/DAV-102/title and https://desk.example/now?item=DAV-999.',
    ].join('\n\n'));
    await putPage(session('b'), 'User: `DAV-103` blocks DAV-101.');
    await putPage('notes/plain-note', 'A note that names DAV-500 is not a session page.');
    await putPage('conversations/chatgpt/2026-09-10-thread-000000000000', 'A consumer chat that names DAV-501.');
    await putPage(`conversations/sessions/2026-09-11-omp-${'c'.padStart(12, '0')}`, 'Next day: DAV-777.', '2026-09-11');

    const result = await writeDailyMemoryFromSources(engine, { date: DAY, timezone: ZONE });
    expect(result.written).toBe(true);
    const text = await note();
    const work = text.slice(text.indexOf('## Work'));
    expect(work).toBe([
      '## Work',
      '',
      `- DAV-101 — ${link('a')}, ${link('b')}`,
      `- acme/widgets#61 — ${link('a')}`,
      `- DAV-102 — ${link('a')}`,
      `- DAV-103 — ${link('b')}`,
    ].join('\n'));
    // The Work section comes after every page section.
    expect(text.indexOf('## Work')).toBeGreaterThan(text.indexOf('## default'));
    for (const absent of ['DAV-500', 'DAV-501', 'DAV-777', 'DAV-999']) expect(text).not.toContain(absent);

    const rerun = await writeDailyMemoryFromSources(engine, { date: DAY, timezone: ZONE });
    expect(rerun.reason).toBe('unchanged');
  }, 60_000);

  test('a busy day keeps the reference cap and the per-reference session cap', async () => {
    const ids = Array.from({ length: DAILY_MEMORY_WORK_LINK_CAP + 5 }, (_, i) => `DAV-${1000 + i}`);
    const shared = DAILY_MEMORY_WORK_SESSION_CAP + 2;
    for (let i = 0; i < shared; i++) await putPage(session(`s${i}`), `Session ${i} on DAV-1000.`);
    // 'zz' sorts after every 's<n>' slug, so DAV-1000 is first seen on s0.
    await putPage(session('zz'), ids.join(' '));

    await writeDailyMemoryFromSources(engine, { date: DAY, timezone: ZONE });
    const text = await note();
    const items = text.split('\n').filter(line => /^- DAV-\d+ — /.test(line));
    expect(items).toHaveLength(DAILY_MEMORY_WORK_LINK_CAP);
    const shown = Array.from({ length: DAILY_MEMORY_WORK_SESSION_CAP }, (_, i) => link(`s${i}`)).join(', ');
    expect(items[0]).toBe(`- DAV-1000 — ${shown} and ${shared + 1 - DAILY_MEMORY_WORK_SESSION_CAP} more session pages`);
    expect(items.at(-1)).toStartWith(`- DAV-${1000 + DAILY_MEMORY_WORK_LINK_CAP - 1} — `);
    expect(text).not.toContain(`DAV-${1000 + DAILY_MEMORY_WORK_LINK_CAP} `);
    expect(text).toEndWith('5 more work references stay on the session pages.');
  }, 60_000);

  test('a day whose sessions mention no issue or pull request has no Work section', async () => {
    await putPage(session('a'), 'User: tidy the README.');
    await putPage('notes/plain-note', 'DAV-5 lives on a note, not a session.');
    const result = await writeDailyMemoryFromSources(engine, { date: DAY, timezone: ZONE });
    expect(result.written).toBe(true);
    const text = await note();
    expect(text).toContain(link('a'));
    expect(text).not.toContain('## Work');
  }, 60_000);
});
