import { describe, expect, test } from 'bun:test';
import {
  agentDaySlug, attributeRole, askText, buildRoleDay, renderRoleDay, splitTurns,
} from '../src/core/digests/agent-day.ts';
import { groupSessions, partNumber } from '../scripts/write-agent-day-digests.ts';

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
  '**Assistant** (2026-10-29 2:30 PM): I opened draft PR https://github.com/daveove/gbrain/pull/56 for https://linear.app/daveove/issue/DAV-7404.',
  '**Assistant** (2026-10-29 2:31 PM): Dave must do: approve the passkey tap.',
  '**Assistant** (2026-10-29 2:32 PM): What Dave must do: nothing.',
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
    expect(attributeRole('You are Dave\'s OMP agent.')).toBeNull();
  });

  test('takes the Buzz event content, not the prompt boilerplate', () => {
    expect(askText(`<base>\n${BUZZ_PROMPT}`)).toBe('@Yoda check the Supabase egress and report back');
    expect(askText('<file name="task.md">\nYou are Automaton 1.\n# Task: host the report cards (DAV-7357)\n\nbody'))
      .toBe('host the report cards (DAV-7357)');
  });

  test('builds the four sections, keeps only the day, skips "nothing" lines', () => {
    const day = buildRoleDay('yoda', '2026-10-29', [{ sessionId: '01a18578-daf', slugs: ['conversations/sessions/2026-10-29-omp-x'], text: session }]);
    expect(day.asked.map((i) => i.text)).toEqual(['@Yoda check the Supabase egress and report back']);
    expect(day.shipped).toHaveLength(1);
    expect(day.shipped[0].text).toContain('pull/56');
    expect(day.waiting.map((i) => i.text)).toEqual(['Dave must do: approve the passkey tap.']);
    expect(day.failed.map((i) => i.text)).toEqual(['The nightly run failed with exit 1 on the codex seat.']);
    expect(day.links).toEqual({ prs: ['https://github.com/daveove/gbrain/pull/56'], issues: ['https://linear.app/daveove/issue/DAV-7404'] });
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
