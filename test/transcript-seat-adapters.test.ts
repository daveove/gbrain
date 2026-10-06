/**
 * transcript-seat-adapters.test.ts — omp, pi, opencode and cursor adapters:
 * distilled user/assistant text only, slug/date conventions, malformed-line
 * tolerance, and detection against the existing formats.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectAdapter } from '../src/core/transcripts/detect.ts';
import { cursorAdapter, parseCursorTimestampTag } from '../src/core/transcripts/cursor.ts';
import { opencodeAdapter } from '../src/core/transcripts/opencode.ts';
import { ompAdapter, piAdapter } from '../src/core/transcripts/pi-session.ts';
import { redactSession, renderSessionParts } from '../src/core/transcripts/render.ts';
import { runTranscriptsIngest } from '../src/core/transcripts/ingest.ts';
import { transcriptSlugId, type FileDiagnostics, type ParsedSession, type TranscriptFormat } from '../src/core/transcripts/types.ts';

const FIXTURES = join(import.meta.dir, 'fixtures', 'transcripts');
const OMP_FIXTURE = join(FIXTURES, 'omp-session.jsonl');
const PI_FIXTURE = join(FIXTURES, 'pi-session.jsonl');
const CURSOR_FIXTURE = join(FIXTURES, 'cursor-agent-transcript.jsonl');
const OPENCODE_FIXTURE = join(FIXTURES, 'opencode-export.json');
const LEAK_MARKERS = ['PRIVATE-', 'TOOL-', 'INJECTED-', 'CUSTOM-DATA', 'COMPACTION-SUMMARY', 'SYNTHETIC-', 'SKILL-PREAMBLE'];

let tmp: string | null = null;
function tdir(): string {
  tmp = mkdtempSync(join(tmpdir(), 'gb-seat-adapters-'));
  return tmp;
}
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

async function drain(
  gen: AsyncGenerator<ParsedSession, FileDiagnostics>,
): Promise<{ sessions: ParsedSession[]; diag: FileDiagnostics }> {
  const sessions: ParsedSession[] = [];
  let r = await gen.next();
  while (!r.done) {
    sessions.push(r.value);
    r = await gen.next();
  }
  return { sessions, diag: r.value };
}

function renderBody(session: ParsedSession): { slug: string; content: string } {
  const rendered = renderSessionParts(redactSession(session), { sourcePath: 'fixture' });
  return { slug: rendered.baseSlug, content: rendered.parts.map((p) => p.content).join('\n') };
}

function expectNoLeaks(content: string): void {
  for (const marker of LEAK_MARKERS) expect(content).not.toContain(marker);
}

describe('ompAdapter', () => {
  test('keeps user/assistant text only, latest title, header identity', async () => {
    const { sessions, diag } = await drain(ompAdapter.parse(OMP_FIXTURE));
    expect([diag.skippedLines, diag.sessions, diag.truncated]).toEqual([1, 1, false]);
    const [s] = sessions;
    expect(s.meta.harness).toBe('omp');
    expect(s.meta.sessionId).toBe('omp-fixture-session-1');
    expect(s.meta.cwd).toBe('/home/alice-example/acme-example');
    expect(s.meta.title).toBe('Widget launch plan');
    expect(s.meta.startedAt).toBe('2026-09-30T02:00:00.000Z');
    expect(s.messages).toEqual([
      { role: 'user', timestamp: '2026-09-30T02:01:00.000Z', text: 'Outline the acme-example widget launch.' },
      { role: 'assistant', timestamp: '2026-09-30T02:01:30.000Z', text: 'Reading the launch notes first.' },
      { role: 'assistant', timestamp: '2026-09-30T02:03:00.000Z', text: 'Launch in three phases: beta, partners, general.' },
    ]);
  });

  test('renders a distilled page under the omp session slug', async () => {
    const { sessions } = await drain(ompAdapter.parse(OMP_FIXTURE));
    const { slug, content } = renderBody(sessions[0]);
    expect(slug).toBe(`conversations/sessions/2026-09-30-omp-${transcriptSlugId('omp-fixture-session-1')}`);
    expect(content).toContain('**User** (2026-09-30 2:01 AM): Outline the acme-example widget launch.');
    expectNoLeaks(content);
  });

  test('an over-budget file degrades to head+tail and keeps the header identity', async () => {
    const d = tdir();
    const p = join(d, 'big.jsonl');
    const head = Bun.file(OMP_FIXTURE);
    const filler = JSON.stringify({ type: 'custom', customType: 'pad', data: 'x'.repeat(2000) });
    writeFileSync(p, (await head.text()) + `${filler}\n`.repeat(200) + JSON.stringify({
      type: 'message', timestamp: '2026-09-30T05:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'Tail question.' }] },
    }) + '\n');
    const { sessions, diag } = await drain(ompAdapter.parse(p, { maxBytes: 64 * 1024 }));
    expect(diag.truncated).toBe(true);
    expect(sessions[0].meta.sessionId).toBe('omp-fixture-session-1');
    expect(sessions[0].messages.at(-1)!.text).toBe('Tail question.');
  });

  test('a header-only session is expected-empty, not drift', async () => {
    const d = tdir();
    const p = join(d, 'empty.jsonl');
    writeFileSync(p, [
      JSON.stringify({ type: 'title', v: 1, title: 'New session' }),
      JSON.stringify({ type: 'session', version: 3, id: 'omp-empty', timestamp: '2026-09-30T00:00:00.000Z', cwd: '/tmp' }),
    ].join('\n') + '\n');
    const { sessions, diag } = await drain(ompAdapter.parse(p));
    expect(sessions).toEqual([]);
    expect(diag.expectedEmpty).toBe(true);
  });
});

describe('piAdapter', () => {
  test('shares the pi-session parser; session_info names the page; compaction dropped', async () => {
    const { sessions, diag } = await drain(piAdapter.parse(PI_FIXTURE));
    expect(diag.skippedLines).toBe(1);
    const [s] = sessions;
    expect(s.meta.harness).toBe('pi');
    expect(s.meta.sessionId).toBe('pi-fixture-session-1');
    expect(s.meta.title).toBe('Inbox triage');
    expect(s.messages).toEqual([
      { role: 'user', timestamp: '2026-09-30T23:31:00.000Z', text: 'Which acme-example emails need replies?' },
      { role: 'assistant', timestamp: '2026-09-30T23:41:00.000Z', text: 'Two need replies: the invoice and the partner intro.' },
    ]);
    const { slug, content } = renderBody(s);
    expect(slug).toBe(`conversations/sessions/2026-09-30-pi-${transcriptSlugId('pi-fixture-session-1')}`);
    expectNoLeaks(content);
  });
});

describe('cursorAdapter', () => {
  test('parses the <timestamp> tag to UTC', () => {
    expect(parseCursorTimestampTag('<timestamp>Wednesday, Sep 30, 2026, 9:15 AM (UTC+8)</timestamp>')).toBe('2026-09-30T01:15:00.000Z');
    expect(parseCursorTimestampTag('<timestamp>Thursday, Oct 1, 2026, 12:05 AM (UTC-5:30)</timestamp>')).toBe('2026-10-01T05:35:00.000Z');
    expect(parseCursorTimestampTag('<timestamp>Friday, Oct 2, 2026, 12:00 PM (UTC)</timestamp>')).toBe('2026-10-02T12:00:00.000Z');
    expect(parseCursorTimestampTag('no tag')).toBeUndefined();
  });

  test('keeps <user_query> content and assistant text; injected rows and tools dropped', async () => {
    const { sessions, diag } = await drain(cursorAdapter.parse(CURSOR_FIXTURE));
    expect(diag.skippedLines).toBe(1);
    const [s] = sessions;
    expect(s.meta.harness).toBe('cursor');
    expect(s.meta.sessionId).toBe('cursor-agent-transcript');
    expect(s.meta.startedAt).toBe('2026-09-30T01:15:00.000Z');
    expect(s.messages).toEqual([
      { role: 'user', timestamp: '2026-09-30T01:15:00.000Z', text: 'Summarize the acme-example roadmap.' },
      { role: 'assistant', timestamp: '', text: 'Checking the roadmap doc.' },
      { role: 'assistant', timestamp: '', text: 'Q4 focuses on the widget launch.' },
      { role: 'user', timestamp: '2026-09-30T13:25:00.000Z', text: 'Thanks.' },
    ]);
    const { slug, content } = renderBody(s);
    expect(slug).toBe(`conversations/sessions/2026-09-30-cursor-${transcriptSlugId('cursor-agent-transcript')}`);
    expect(content).toContain('**Assistant** (2026-09-30 1:15 AM): Q4 focuses on the widget launch.');
    expectNoLeaks(content);
  });

  test('without a timestamp tag the session time falls back to the file time', async () => {
    const d = tdir();
    const p = join(d, 'abc.jsonl');
    writeFileSync(p, JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: '<user_query>Hi</user_query>' }] } }) + '\n');
    const at = new Date('2026-09-29T10:00:00.000Z');
    utimesSync(p, at, at);
    const { sessions } = await drain(cursorAdapter.parse(p));
    const st = statSync(p);
    const expected = new Date(st.birthtimeMs > 0 ? st.birthtimeMs : Date.parse('2026-09-29T10:00:00.000Z')).toISOString();
    expect(sessions[0].meta.startedAt).toBe(expected);
    expect(sessions[0].messages).toEqual([{ role: 'user', timestamp: '2026-09-29T10:00:00.000Z', text: 'Hi' }]);
  });

  test('a reply appended after the watermark re-imports a session whose prompt predates it', async () => {
    const d = tdir();
    const p = join(d, 'fresh.jsonl');
    const row = (role: string, text: string) => JSON.stringify({ role, message: { content: [{ type: 'text', text }] } });
    writeFileSync(p, [
      row('user', '<timestamp>Wednesday, Sep 30, 2026, 9:15 AM (UTC+8)</timestamp>\n<user_query>Draft the acme-example memo.</user_query>'),
      row('assistant', 'Drafting now.'),
      row('assistant', 'Memo done: three sections.'),
    ].join('\n') + '\n');
    const appendedAt = new Date('2026-09-30T15:00:00.000Z');
    utimesSync(p, appendedAt, appendedAt);
    const { sessions } = await drain(cursorAdapter.parse(p));
    expect(sessions[0].messages.at(-1)).toEqual({ role: 'assistant', timestamp: '2026-09-30T15:00:00.000Z', text: 'Memo done: three sections.' });
    const r = await runTranscriptsIngest({} as never, {
      paths: [p],
      format: 'cursor',
      dryRun: true,
      sinceIso: '2026-09-30T12:00:00.000Z',
      sourceId: 'default',
      userPatternsPath: '/nonexistent',
    });
    expect([r.sessionsSeen, r.sessionsFiltered, r.pages.planned]).toEqual([1, 0, 1]);
  });

  test('a file of only turn bookkeeping rows is expected-empty, not drift', async () => {
    const d = tdir();
    const p = join(d, 'errored.jsonl');
    writeFileSync(p, JSON.stringify({ type: 'turn_ended', status: 'error', error: 'out of usage' }) + '\n');
    const { sessions, diag } = await drain(cursorAdapter.parse(p));
    expect(sessions).toEqual([]);
    expect([diag.sessions, diag.expectedEmpty]).toEqual([0, true]);
  });
});

describe('opencodeAdapter', () => {
  test('non-synthetic text parts only; epoch → ISO; malformed messages counted', async () => {
    const { sessions, diag } = await drain(opencodeAdapter.parse(OPENCODE_FIXTURE));
    expect(diag.skippedLines).toBe(1);
    const [s] = sessions;
    expect(s.meta).toEqual({
      harness: 'opencode',
      sessionId: 'ses_fixture0000000000000001',
      title: 'Fix widget build',
      cwd: '/home/alice-example/acme-example',
      startedAt: '2026-09-30T02:00:00.000Z',
      raw: { session_id: 'ses_fixture0000000000000001', cwd: '/home/alice-example/acme-example', source_path: OPENCODE_FIXTURE },
    });
    expect(s.messages).toEqual([
      { role: 'user', timestamp: '2026-09-30T02:00:00.000Z', text: 'Why does the acme-example widget build fail?' },
      { role: 'assistant', timestamp: '2026-09-30T02:00:10.000Z', text: 'The build fails because the widget config is missing.' },
      { role: 'assistant', timestamp: '2026-09-30T02:03:30.000Z', text: 'Added the config; the build passes.' },
    ]);
    const { slug, content } = renderBody(s);
    expect(slug).toBe(`conversations/sessions/2026-09-30-opencode-${transcriptSlugId('ses_fixture0000000000000001')}`);
    expectNoLeaks(content);
  });

  test('rejects a JSON file that is not a session export', async () => {
    const d = tdir();
    const p = join(d, 'other.json');
    writeFileSync(p, '{"info":{}}');
    await expect(drain(opencodeAdapter.parse(p))).rejects.toThrow('not an opencode session export');
  });
});

describe('seat detection', () => {
  test('each seat fixture detects as its own format', () => {
    const d = tdir();
    const piHome = join(d, '.pi', 'agent', 'sessions', '--home-alice-example--');
    mkdirSync(piHome, { recursive: true });
    const piPath = join(piHome, '2026-09-30T23-30-00-000Z_pi-fixture.jsonl');
    copyFileSync(PI_FIXTURE, piPath);
    const cases: Array<[string, TranscriptFormat]> = [
      [OMP_FIXTURE, 'omp'],
      [piPath, 'pi'],
      [PI_FIXTURE, 'openclaw'],
      [CURSOR_FIXTURE, 'cursor'],
      [OPENCODE_FIXTURE, 'opencode'],
    ];
    for (const [path, format] of cases) {
      const r = detectAdapter(path);
      expect(r.ok && r.adapter.format).toBe(format);
    }
  });
});
