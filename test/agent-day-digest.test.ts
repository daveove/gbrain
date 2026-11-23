import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  AGENT_ROLES, agentDaySlug, attributeRole, askText, buildRoleDay, dayStartUtc, renderRoleDay, splitTurns,
} from '../src/core/digests/agent-day.ts';
import { buildAgentDayPages, groupSessions, partNumber, putPage, readLocalAgentSessions } from '../scripts/write-agent-day-digests.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const BUZZ_PROMPT = [
  'You are an agent operating inside Buzz. Start with the `Content:` field in the current `<buzz-event>`.',
  'You are Yoda, the Buzz agent for the cockpit-keeper role.',
  '<buzz-event>',
  'Event ID: abc',
  'Content: @Yoda check the Supabase egress and report back',
  'Tags: [["h","x"]]',
  '</buzz-event>',
].join('\n');

const session = [
  `**User** (2026-10-29 2:02 PM): <base>\n${BUZZ_PROMPT}`,
  '**Assistant** (2026-10-29 2:30 PM): I opened draft PR https://github.com/acme-example/brain-example/pull/56 for https://linear.app/acme-example/issue/DAV-1234.',
  '**Assistant** (2026-10-29 2:31 PM): The operator must approve the passkey tap.',
  '**Assistant** (2026-10-29 2:32 PM): No passkey is required; no blocker.',
  '**Assistant** (2026-10-29 2:33 PM): The nightly run failed with exit 1 on the codex seat.',
  '**Assistant** (2026-10-28 11:59 PM): An older day line that failed.',
].join('\n');

describe('agent day-out digest', () => {
  test('splits turns and converts 12-hour times', () => {
    const turns = splitTurns(session);
    expect(turns.map((t) => `${t.role}@${t.time}`)).toEqual(
      ['user@14:02', 'assistant@14:30', 'assistant@14:31', 'assistant@14:32', 'assistant@14:33', 'assistant@23:59']);
    expect(splitTurns('**User** (2026-10-29 12:05 AM): hi')[0].time).toBe('00:05');
  });

  test('attributes primaries, crew workers, worktrees and the Gandalf alias', () => {
    expect(attributeRole('You are Aslan, the Buzz agent for the x role')).toBe('aslan');
    expect(attributeRole('native OMP task worker reporting to Aragorn (svi-operator)')).toBe('aragorn');
    expect(attributeRole('worktree /x/aw-spock-abc123 branch')).toBe('spock');
    expect(attributeRole('You are Gandalf, the Buzz agent for sales')).toBe('scotty');
    expect(attributeRole('You are the operator\'s OMP agent.')).toBeNull();
  });

  test.each([
    ['cockpit-keeper', 'yoda'], ['agentworld-keeper', 'aslan'], ['svi-operator', 'aragorn'],
    ['intown-project', 'spock'], ['sales-marketing', 'scotty'], ['comms-keeper', 'mandalorian'],
    ['home-keeper', 'home-keeper'], ['delivery-keeper', 'delivery-keeper'], ['learning-keeper', 'learning-keeper'],
  ])('attributes the current primary id %s', (id, role) => {
    expect(attributeRole(`You are the persistent ${id} primary for Agentworld, the operator's first mate.`)).toBe(role);
    expect(attributeRole(`cwd: /home/operator/.local/state/agentworld-primary-worktrees/project/${id}`)).toBe(role);
    expect(attributeRole(`cwd: /home/operator/.local/state/agentworld-primary-worktrees/project/${id}/src`)).toBe(role);
    expect(attributeRole(`cwd: /home/operator/.herdr/worktrees/project/aw-${id}-abc123`)).toBe(role);
    expect(attributeRole(`cwd: /home/operator/.herdr/worktrees/project/aw-primary-${id}`)).toBe(role);
  });

  test('explicit identity wins over another primary worktree in the session', () => {
    const path = '/home/operator/agentworld-primary-worktrees/cockpit/cockpit-keeper';
    expect(attributeRole(`You are the persistent svi-operator primary for Agentworld.\n${path}`)).toBe('aragorn');
    expect(attributeRole(`reporting to Aragorn\n${path}`)).toBe('aragorn');
    expect(attributeRole(`You are Gandalf, the Buzz agent\n${path}`)).toBe('scotty');
    expect(attributeRole('You are the persistent unknown-keeper primary for Agentworld.')).toBeNull();
    expect(attributeRole('/agentworld-primary-worktrees/project/cockpit-keeper-extra')).toBeNull();
    expect(attributeRole('We discussed cockpit-keeper and sales-marketing.')).toBeNull();
  });

  test('takes the Buzz event content, not the prompt boilerplate', () => {
    expect(askText(`<base>\n${BUZZ_PROMPT}`)).toBe('@Yoda check the Supabase egress and report back');
    expect(askText('<file name="task.md">\nYou are Automaton 1.\n# Task: host the report cards (DAV-7357)\n\nbody'))
      .toBe('host the report cards (DAV-7357)');
  });

  test('extracts multiline goals before a wrapped file heading', () => {
    const goal = '# Goal\n\nFix the synthetic build';
    for (const text of [goal, `<file name="task.md">\n${goal}\n</file>`]) {
      expect(askText(text)).toBe('Fix the synthetic build');
      const day = buildRoleDay('yoda', '2026-10-29', [{
        sessionId: 'goal', slugs: ['goal'], text: `**User** (2026-10-29 2:00 PM): ${text}`,
      }]);
      expect(day.asked.map((item) => item.text)).toEqual(['Fix the synthetic build']);
    }
  });

  test('builds the four sections, keeps only the day, skips no-blocker lines', () => {
    const day = buildRoleDay('yoda', '2026-10-29', [{ sessionId: '01a18578-daf', slugs: ['conversations/sessions/2026-10-29-omp-x'], text: session }]);
    expect(day.asked.map((i) => i.text)).toEqual(['@Yoda check the Supabase egress and report back']);
    expect(day.shipped).toHaveLength(1);
    expect(day.shipped[0].text).toContain('pull/56');
    expect(day.waiting.map((i) => i.text)).toEqual(['The operator must approve the passkey tap.']);
    expect(day.failed.map((i) => i.text)).toEqual(['The nightly run failed with exit 1 on the codex seat.']);
    expect(day.links).toEqual({ prs: ['https://github.com/acme-example/brain-example/pull/56'], issues: ['https://linear.app/acme-example/issue/DAV-1234'] });
  });

  test('drops a session about a personal meeting and any line that mentions one', () => {
    const meeting = '**User** (2026-10-29 3:00 PM): Summarise my Circleback meeting from this morning\n**Assistant** (2026-10-29 3:01 PM): Done, opened https://github.com/a/b/pull/1';
    const mixed = '**User** (2026-10-29 3:00 PM): Fix the build\n**Assistant** (2026-10-29 3:01 PM): I merged https://github.com/a/b/pull/2\n**Assistant** (2026-10-29 3:02 PM): The Pocket recording failed to load';
    const day = buildRoleDay('spock', '2026-10-29', [
      { sessionId: 'm', slugs: ['a'], text: meeting },
      { sessionId: 'k', slugs: ['b'], text: mixed },
    ]);
    expect(day.sessions).toEqual(['k']);
    expect(JSON.stringify(day)).not.toMatch(/circleback|pocket/i);
  });

  test('a later line that mentions a Circleback meeting adds no link, fact or ask', () => {
    const text = [
      '**User** (2026-10-29 3:00 PM): Fix the build',
      '**Assistant** (2026-10-29 3:01 PM): I opened https://github.com/a/b/pull/10 for the build.\nFrom the Circleback meeting I opened https://github.com/a/b/pull/11 and https://linear.app/x/issue/DAV-9001.\n- The Circleback action item failed: https://github.com/a/b/pull/12',
      '**User** (2026-10-29 3:05 PM): What did Circleback say about the launch?',
      '**Assistant** (2026-10-29 3:06 PM): I opened https://github.com/a/b/pull/13 from that.',
    ].join('\n');
    const day = buildRoleDay('spock', '2026-10-29', [{ sessionId: 'k', slugs: ['b'], text }]);
    expect(day.links.prs).toEqual(['https://github.com/a/b/pull/10']);
    expect(day.links.issues).toEqual([]);
    expect(day.asked.map((i) => i.text)).toEqual(['Fix the build']);
    expect(day.shipped).toHaveLength(1);
    expect(JSON.stringify(day)).not.toMatch(/circleback|pull\/1[123]|DAV-9001/i);
  });

  test('a negated outcome is not shipped, a done sentence beside a negated one still is', () => {
    const text = [
      '**User** (2026-10-29 3:00 PM): Land the fix',
      '**Assistant** (2026-10-29 3:01 PM): I could not merge https://github.com/a/b/pull/20; it was not merged.',
      '**Assistant** (2026-10-29 3:02 PM): The merge of https://github.com/a/b/pull/21 failed and it did not land.',
      '**Assistant** (2026-10-29 3:03 PM): I opened draft https://github.com/a/b/pull/22. I did not request a review or merge it.',
    ].join('\n');
    const day = buildRoleDay('spock', '2026-10-29', [{ sessionId: 'k', slugs: ['b'], text }]);
    expect(day.shipped.map((i) => i.text)).toEqual(['I opened draft https://github.com/a/b/pull/22. I did not request a review or merge it.']);
    expect(day.failed.map((i) => i.text)).toContain('The merge of https://github.com/a/b/pull/21 failed and it did not land.');
  });

  test('zero failure counts stay out of failures while positive counts remain (DAV-8077)', () => {
    const summaries = [
      'All tests passed: 12 passed, 0 failed.',
      'The test summary: 0 failures.',
      'The test summary: 3 failed.',
      'The test summary: 10 failed.',
      'The test summary: 0 failed, then 3 failed.',
      'The test summary: 0 failed, but the launcher crashed.',
    ];
    const day = buildRoleDay(AGENT_ROLES[0], '2026-10-29', [{
      sessionId: 'synthetic-counts', slugs: ['synthetic-counts'],
      text: `**Assistant** (2026-10-29 3:00 PM): ${summaries.join('\n')}`,
    }]);
    expect(day.failed.map((item) => item.text)).toEqual(summaries.slice(2));
  });

  test('a trailing negated qualifier does not negate a completion (DAV-8078)', () => {
    const shipped = 'I merged https://github.com/a/b/pull/22 without changing the public API.';
    const text = [
      `**Assistant** (2026-10-29 3:00 PM): ${shipped}`,
      '**Assistant** (2026-10-29 3:01 PM): I did not merge https://github.com/a/b/pull/23.',
      '**Assistant** (2026-10-29 3:02 PM): I have not merged https://github.com/a/b/pull/24.',
      '**Assistant** (2026-10-29 3:03 PM): I never opened https://github.com/a/b/pull/25.',
    ].join('\n');
    const day = buildRoleDay(AGENT_ROLES[0], '2026-10-29', [{
      sessionId: 'synthetic-completions', slugs: ['synthetic-completions'], text,
    }]);
    expect(day.shipped.map((item) => item.text)).toEqual([shipped]);
  });

  test.each(['Circleback', 'Pocket'])('checks the full ask before truncation for %s (DAV-8087)', (marker) => {
    const ask = `${'Review the synthetic report. '.repeat(12)}Summarize the ${marker} meeting.`;
    expect(ask.indexOf(marker)).toBeGreaterThan(260);
    for (const prompt of [ask, `<buzz-event>\nContent: ${ask}\nTags: []\n</buzz-event>`]) {
      const day = buildRoleDay(AGENT_ROLES[0], '2026-10-29', [{
        sessionId: 'synthetic-meeting', slugs: ['synthetic-meeting'],
        text: [
          `**User** (2026-10-29 3:00 PM): ${prompt}`,
          '**Assistant** (2026-10-29 3:01 PM): I merged https://github.com/a/b/pull/26 for https://linear.app/example/issue/DAV-9002.',
          '**Assistant** (2026-10-29 3:02 PM): The synthetic run failed with exit 1.',
          '**Assistant** (2026-10-29 3:03 PM): The synthetic run needs a passkey.',
        ].join('\n'),
      }]);
      expect(day.asked).toEqual([]);
      expect(day.shipped).toEqual([]);
      expect(day.failed).toEqual([]);
      expect(day.waiting).toEqual([]);
      expect(day.links).toEqual({ prs: [], issues: [] });
      expect(day.sessions).toEqual([]);
      expect(day.sessionSlugs).toEqual([]);
    }
  });

  test('renders private, deterministic pages with the contract slug', () => {
    const day = buildRoleDay('yoda', '2026-10-29', [{ sessionId: '01a18578-daf', slugs: ['conversations/sessions/2026-10-29-omp-x'], text: session }]);
    const page = renderRoleDay(day);
    expect(agentDaySlug('2026-10-29', 'yoda')).toBe('digests/agent-day/2026-10-29/yoda');
    expect(page).toContain('visibility: private');
    expect(page).toContain('agent_role: yoda');
    expect(page).toContain('- conversations/sessions/2026-10-29-omp-x');
    expect(renderRoleDay(day)).toBe(page);
  });

  test('groups part pages by session id in part order', () => {
    expect(partNumber('conversations/sessions/d-omp-h')).toBe(1);
    expect(partNumber('conversations/sessions/d-omp-h-p3')).toBe(3);
    const grouped = groupSessions([
      { slug: 'd-omp-h-p2', body: 'B', sessionId: 's1' },
      { slug: 'd-omp-h', body: 'A', sessionId: 's1' },
      { slug: 'd-omp-z', body: 'Z', sessionId: 's2' },
    ]);
    expect(grouped.find((g) => g.sessionId === 's1')).toEqual({ sessionId: 's1', slugs: ['d-omp-h', 'd-omp-h-p2'], text: 'A\nB' });
  });
});

describe('agent day-out digest day boundaries (DAV-7417)', () => {
  test('turn anchors are UTC and convert to the digest zone', () => {
    const [early] = splitTurns('**Assistant** (2026-10-29 2:02 AM): a', 'Asia/Manila');
    expect([early.date, early.time]).toEqual(['2026-10-29', '10:02']);
    // 17:00 UTC on 29 Oct is 01:00 on 30 Oct in Manila.
    const [late] = splitTurns('**Assistant** (2026-10-29 5:00 PM): b', 'Asia/Manila');
    expect([late.date, late.time]).toEqual(['2026-10-30', '01:00']);
  });

  test('a day starts at local midnight, also across a daylight-saving change', () => {
    expect(dayStartUtc('2026-10-29', 'Asia/Manila').toISOString()).toBe('2026-10-28T16:00:00.000Z');
    expect(dayStartUtc('2026-11-01', 'America/New_York').toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(dayStartUtc('2026-11-02', 'America/New_York').toISOString()).toBe('2026-11-02T05:00:00.000Z');
  });

  test('a session spanning midnight keeps only the digest day, in Manila time', () => {
    const text = [
      `**User** (2026-10-28 3:00 PM): <base>\n${BUZZ_PROMPT}`,
      '**Assistant** (2026-10-28 3:05 PM): I merged https://github.com/a/b/pull/1 before midnight.',
      '**Assistant** (2026-10-29 3:05 AM): I opened https://github.com/a/b/pull/2 on the day.',
      '**Assistant** (2026-10-29 5:00 PM): I opened https://github.com/a/b/pull/3 after Manila midnight.',
    ].join('\n');
    const day = buildRoleDay('yoda', '2026-10-29', [{ sessionId: 's', slugs: ['x'], text }], 'Asia/Manila');
    expect(day.shipped.map((i) => i.text)).toEqual(['I opened https://github.com/a/b/pull/2 on the day.']);
    expect(day.shipped[0].time).toBe('11:05');
    expect(renderRoleDay(day)).toContain('Times are Asia/Manila.');
  });

  test('keeps earlier work when the first same-day user turn starts a meeting thread', () => {
    const text = [
      '**User** (2026-10-29 11:59 PM): Fix the synthetic build',
      '**Assistant** (2026-10-30 12:01 AM): I merged https://github.com/acme-example/brain-example/pull/31 for the build.',
      '**User** (2026-10-30 12:05 AM): Summarize the Circleback meeting',
      '**Assistant** (2026-10-30 12:06 AM): I opened https://github.com/acme-example/brain-example/pull/32 from those action items.',
    ].join('\n');
    const day = buildRoleDay('spock', '2026-10-30', [{ sessionId: 'build', slugs: ['b'], text }]);
    expect(day.sessions).toEqual(['build']);
    expect(day.sessionSlugs).toEqual(['b']);
    expect(day.shipped.map((item) => item.text)).toEqual(['I merged https://github.com/acme-example/brain-example/pull/31 for the build.']);
    expect(day.links.prs).toEqual(['https://github.com/acme-example/brain-example/pull/31']);
    expect(day.asked).toEqual([]);
    expect(JSON.stringify(day)).not.toMatch(/circleback|pull\/32/i);
  });

  test('a meeting ask before midnight keeps its reply out of the next day', () => {
    const text = [
      '**User** (2026-10-29 11:59 PM): Summarize the Circleback meeting',
      '**Assistant** (2026-10-30 12:01 AM): I opened https://github.com/a/b/pull/2 from those action items.',
      '**User** (2026-10-30 12:05 AM): Fix the build',
      '**Assistant** (2026-10-30 12:06 AM): I opened https://github.com/a/b/pull/3 for the build.',
    ].join('\n');
    const day = buildRoleDay('spock', '2026-10-30', [{ sessionId: 'k', slugs: ['b'], text }]);
    expect(day.links.prs).toEqual(['https://github.com/a/b/pull/3']);
    expect(day.shipped).toHaveLength(1);
    expect(day.asked.map((i) => i.text)).toEqual(['Fix the build']);
  });
});

describe('agent day-out CLI writes (DAV-7417)', () => {
  function fakeCli(firstCode: number, firstOutput = '', firstError = '', alwaysFail = false) {
    const root = mkdtempSync(join(tmpdir(), 'agent-day-cli-'));
    const statePath = join(root, 'state.json');
    const cli = join(root, 'cli.ts');
    const optionsUrl = new URL('../src/core/cli-options.ts', import.meta.url).href;
    writeFileSync(cli, `
import { parseGlobalFlags } from ${JSON.stringify(optionsUrl)};
const args = process.argv.slice(2);
const { cliOpts } = parseGlobalFlags(args);
const path = ${JSON.stringify(statePath)};
const state = await Bun.file(path).exists() ? await Bun.file(path).json() : { calls: [], writes: [] };
const content = await Bun.stdin.text();
const requestId = args[args.indexOf('--request-id') + 1];
state.calls.push({ args, requestId, content, timeoutMs: cliOpts.timeoutMs });
if ((cliOpts.timeoutMs ?? 180000) < 240000) {
  await Bun.write(path, JSON.stringify(state));
  console.error('context timed out at the old default');
  process.exit(124);
}
if (!state.writes.some(write => write.requestId === requestId)) state.writes.push({ requestId, content });
await Bun.write(path, JSON.stringify(state));
if (state.calls.length === 1 || ${alwaysFail}) {
  console.log(${JSON.stringify(firstOutput)});
  console.error(${JSON.stringify(firstError)});
  process.exit(${firstCode});
}
console.log('committed');
`);
    return {
      cli,
      state: () => JSON.parse(readFileSync(statePath, 'utf8')) as {
        calls: { args: string[]; requestId: string; content: string; timeoutMs: number }[];
        writes: { requestId: string; content: string }[];
      },
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
  }

  test('a simulated 240-second put exceeds the old default and succeeds', async () => {
    const cli = fakeCli(0);
    try {
      await putPage('digests/agent-day/2026-11-23/yoda', 'synthetic private page', cli.cli);
      const state = cli.state();
      expect(state.calls).toHaveLength(1);
      expect(state.calls[0].timeoutMs).toBe(360_000);
      expect(state.calls[0].args).toContain('--force');
      expect(state.calls[0].args[state.calls[0].args.indexOf('--wait') + 1]).toBe('300');
      expect(state.writes).toHaveLength(1);
    } finally { cli.cleanup(); }
  });

  test.each([
    [124, '', 'context timed out'],
    [10, 'write_pending', ''],
    [0, '{"status":"write_pending"}', ''],
    [1, '', 'Request timed out'],
  ] as const)('replays one request after exit %i and writes once', async (code, out, err) => {
    const cli = fakeCli(code, out, err);
    try {
      await putPage('digests/agent-day/2026-11-23/yoda', 'synthetic private page', cli.cli);
      const state = cli.state();
      expect(state.calls).toHaveLength(2);
      expect(state.calls[0].requestId).toMatch(/^[0-9a-f-]{36}$/);
      expect(state.calls[0]).toEqual(state.calls[1]);
      expect(state.writes).toHaveLength(1);
    } finally { cli.cleanup(); }
  });

  test('does not retry an unrelated CLI error', async () => {
    const cli = fakeCli(1, '', 'invalid_params');
    try {
      await expect(putPage('digests/agent-day/2026-11-23/yoda', 'synthetic private page', cli.cli)).rejects.toThrow('invalid_params');
      expect(cli.state().calls).toHaveLength(1);
    } finally { cli.cleanup(); }
  });

  test.each([10, 124])('stops after one retry of exit %i', async code => {
    const cli = fakeCli(code, '', 'still pending or timed out', true);
    try {
      await expect(putPage('digests/agent-day/2026-11-23/yoda', 'synthetic private page', cli.cli)).rejects.toThrow(`exited ${code}`);
      expect(cli.state().calls).toHaveLength(2);
      expect(cli.state().writes).toHaveLength(1);
    } finally { cli.cleanup(); }
  });
});

describe('agent day-out discovery (DAV-7417)', () => {
  let engine: PGLiteEngine, version: string | null;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    version = await engine.getConfig('version');
  }, 60_000);
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => {
    await resetPgliteState(engine);
    if (version) await engine.setConfig('version', version);
  });

  const seed = async (slug: string, body: string, sessionId: string, updatedAt: string) => {
    await engine.putPage(slug, {
      type: 'conversation', title: slug, compiled_truth: body, frontmatter: { transcript_import: { session_id: sessionId } },
    });
    await engine.executeRaw('UPDATE pages SET updated_at=$1::timestamptz WHERE source_id=$2 AND slug=$3', [updatedAt, 'default', slug]);
  };

  test('builds private pages for current primaries and excludes their meeting threads', async () => {
    const ids = ['cockpit-keeper', 'agentworld-keeper', 'svi-operator', 'intown-project', 'sales-marketing',
      'comms-keeper', 'home-keeper', 'delivery-keeper', 'learning-keeper'];
    for (const id of ids) {
      await seed(`conversations/sessions/2026-11-23-omp-${id}`, [
        `**User** (2026-11-23 1:00 AM): You are the persistent ${id} primary for Agentworld.`,
        '**Assistant** (2026-11-23 1:05 AM): I merged https://github.com/acme-example/brain-example/pull/9 for the synthetic build.',
        '**User** (2026-11-23 1:10 AM): Summarize the Circleback meeting from Pocket.',
        '**Assistant** (2026-11-23 1:15 AM): I opened https://github.com/acme-example/brain-example/pull/10 from that private meeting.',
      ].join('\n'), id, '2026-11-23T10:00:00Z');
    }
    const built = await buildAgentDayPages(engine, '2026-11-23', 'Asia/Manila');
    expect(built.unattributed).toBe(0);
    expect(built.pages.map(page => page.role)).toEqual([...AGENT_ROLES]);
    for (const page of built.pages) {
      expect(page.sessions).toBe(1);
      expect(page.content).toContain('visibility: private');
      expect(page.content).toContain('pull/9');
      expect(page.content).not.toMatch(/Circleback|Pocket|pull\/10/);
    }
  });

  test('reads local turns in memory, filters Manila days, redacts secrets and merges captured duplicates', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-day-local-'));
    const secret = 'synthetic' + 'Ab3xY7qR9z'.repeat(3);
    const makeSession = (file: string, id: string, turns: [string, string, string][]) => {
      mkdirSync(dirname(file), { recursive: true });
      const lines = [
        { type: 'session', version: 3, id, timestamp: '2026-11-22T15:00:00Z', cwd: '/home/operator/project' },
        ...turns.map(([role, timestamp, text]) => ({
          type: 'message', timestamp, message: { role, content: [{ type: 'text', text }] },
        })),
      ];
      writeFileSync(file, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
      utimesSync(file, new Date('2026-11-24T10:00:00Z'), new Date('2026-11-24T10:00:00Z'));
    };
    try {
      const primary = join(root, 'agentworld/cockpit-keeper/primary.jsonl');
      makeSession(primary, 'local-yoda', [
        ['user', '2026-11-22T15:00:00Z', 'Fix the synthetic build, reporting to Spock.'],
        ['assistant', '2026-11-22T15:59:00Z', 'I opened https://github.com/acme-example/brain-example/pull/1 before the Manila day.'],
        ['assistant', '2026-11-22T16:01:00Z', `I merged https://github.com/acme-example/brain-example/pull/2 with Bearer ${secret}.`],
        ['user', '2026-11-23T15:55:00Z', 'Summarize the Pocket meeting.'],
        ['assistant', '2026-11-23T15:56:00Z', 'I opened https://github.com/acme-example/brain-example/pull/3 from that private thread.'],
        ['assistant', '2026-11-23T16:01:00Z', 'I opened https://github.com/acme-example/brain-example/pull/4 after the Manila day.'],
      ]);
      makeSession(join(root, 'agentworld/agentworld-keeper/meeting.jsonl'), 'local-aslan', [
        ['user', '2026-11-22T15:59:00Z', 'Summarize the Circleback meeting.'],
        ['assistant', '2026-11-22T16:05:00Z', 'I opened https://github.com/acme-example/brain-example/pull/5 from the private meeting.'],
        ['user', '2026-11-22T16:10:00Z', 'Fix the synthetic independent build.'],
        ['assistant', '2026-11-22T16:11:00Z', 'I opened https://github.com/acme-example/brain-example/pull/6 for the independent build.'],
      ]);
      makeSession(join(root, '-project/worker.jsonl'), 'local-worker', [
        ['user', '2026-11-22T16:10:00Z', 'You are a worker reporting to Aragorn. Fix the synthetic build.'],
        ['assistant', '2026-11-22T16:11:00Z', 'I opened https://github.com/acme-example/brain-example/pull/7 for the worker build.'],
      ]);
      makeSession(join(root, '-project/worker/Child.jsonl'), 'excluded-child', [
        ['user', '2026-11-22T16:10:00Z', 'You are a worker reporting to Aragorn. Exclude this delegated session.'],
      ]);
      const local = await readLocalAgentSessions('2026-11-23', 'Asia/Manila', { root, patterns: [] });
      expect(local).toHaveLength(3);
      expect(local.find(session => session.sessionId === 'local-yoda')?.role).toBe('yoda');
      expect(local.map(session => session.text).join('\n')).not.toContain(secret);
      const captured = 'conversations/sessions/2026-11-22-omp-synthetic';
      await seed(captured, '**User** (2026-11-22 4:01 PM): You are Spock, the Buzz agent.', 'local-yoda', '2026-11-23T10:00:00Z');
      const before = await engine.listPages({ slugPrefix: 'conversations/sessions/' });
      const built = await buildAgentDayPages(engine, '2026-11-23', 'Asia/Manila', local);
      expect(built.pages.map(page => [page.role, page.sessions])).toEqual([['yoda', 1], ['aslan', 1], ['aragorn', 1]]);
      const yoda = built.pages.find(page => page.role === 'yoda')!.content;
      expect(yoda).toContain('pull/2');
      expect(yoda).toContain('<REDACTED:bearer>');
      expect(yoda).toContain(captured);
      expect(yoda).toContain('file://');
      expect(yoda).not.toMatch(/pull\/[134]|Pocket/);
      const aslan = built.pages.find(page => page.role === 'aslan')!.content;
      expect(aslan).toContain('pull/6');
      expect(aslan).not.toMatch(/pull\/5|Circleback|private meeting/);
      expect(built.pages.every(page => page.content.includes('visibility: private'))).toBe(true);
      expect(await engine.listPages({ slugPrefix: 'conversations/sessions/' })).toEqual(before);
      const nextDay = await readLocalAgentSessions('2026-11-24', 'Asia/Manila', { root, patterns: [] });
      const nextBuilt = await buildAgentDayPages(engine, '2026-11-24', 'Asia/Manila', nextDay);
      expect(nextBuilt.pages).toHaveLength(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('finds a session that started the day before by its updated pages, and reads every part', async () => {
    // Slug date 28 Oct (UTC start); part 1 holds the prompt, part 2 holds 29 Oct turns.
    await seed('conversations/sessions/2026-10-28-omp-aaaaaaaaaaaa',
      `**User** (2026-10-28 3:00 PM): <base>\n${BUZZ_PROMPT}`, 's-span', '2026-10-28T20:00:00Z');
    await seed('conversations/sessions/2026-10-28-omp-aaaaaaaaaaaa-p2',
      '**Assistant** (2026-10-29 3:05 AM): I opened https://github.com/a/b/pull/9 today.', 's-span', '2026-10-29T10:00:00Z');
    // Untouched since 20 Oct: out of the window even though it has a Manila 29 Oct anchor.
    await seed('conversations/sessions/2026-10-20-omp-bbbbbbbbbbbb',
      `**User** (2026-10-29 3:00 AM): <base>\n${BUZZ_PROMPT}\n**Assistant** (2026-10-29 3:05 AM): I opened https://github.com/a/b/pull/8.`,
      's-old', '2026-10-20T00:00:00Z');
    const built = await buildAgentDayPages(engine, '2026-10-29', 'Asia/Manila');
    expect(built.pages.map((p) => p.slug)).toEqual(['digests/agent-day/2026-10-29/yoda']);
    expect(built.pages[0].content).toContain('pull/9');
    expect(built.pages[0].content).not.toContain('pull/8');
    expect(built.pages[0].sessions).toBe(1);
  });
});
