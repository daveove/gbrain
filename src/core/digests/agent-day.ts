/**
 * Per-agent day-out digest (DAV-7417).
 *
 * Pure, deterministic and extractive: it reads captured session text (the
 * `conversations/sessions/<date>-<harness>-<hash>[-pN]` pages that the nightly
 * daily-memory run writes) and renders one private page per agent role. It
 * calls no model and no network. Anything the rules cannot find stays out of
 * the page; the page never paraphrases.
 */

export const AGENT_ROLES = ['yoda', 'aslan', 'aragorn', 'spock', 'scotty', 'mandalorian'] as const;
export type AgentRole = typeof AGENT_ROLES[number];

export interface SessionInput {
  /** Slug of every captured part of one session, in part order. */
  slugs: string[];
  sessionId: string;
  /** Concatenated body of all parts (turns as `**User** (...)` / `**Assistant** (...)`). */
  text: string;
}

export interface Turn {
  role: 'user' | 'assistant';
  date: string;
  time: string;
  text: string;
}

export interface DayItem {
  time: string;
  text: string;
  session: string;
}

export interface RoleDay {
  role: AgentRole;
  date: string;
  /** IANA zone of `date` and of every rendered time. */
  zone: string;
  sessions: string[];
  sessionSlugs: string[];
  asked: DayItem[];
  shipped: DayItem[];
  waiting: DayItem[];
  failed: DayItem[];
  links: { prs: string[]; issues: string[] };
}

export const MAX_ITEMS_PER_SECTION = 12;
const MAX_ITEM_CHARS = 260;

const TURN_RE = /^\*\*(User|Assistant)\*\* \((\d{4}-\d{2}-\d{2}) (\d{1,2}):(\d{2}) (AM|PM)\): ?/gm;
const PR_URL_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;
const ISSUE_URL_RE = /https:\/\/linear\.app\/[\w-]+\/issue\/DAV-\d+/g;
/** Dave's personal meetings (Circleback, Pocket) never enter a digest page. */
const MEETING_RE = /circleback|\bpocket\b|personal meeting/i;
const DONE_RE = /\b(merged|opened|created|posted|deployed|shipped|filed|fixed|pushed|landed|closed|resolved|result:|installed|published|wrote|updated)\b/i;
const WAIT_RE = /(dave must(?! do:? ?nothing)|waiting on dave|needs dave|parked on dave|passkey|(?:for|from) dave'?s? (?:approval|decision|go\b|sign-?in|tap))/i;
const NOTHING_RE = /dave must do:?\s*nothing|nothing blocked|not blocked|no blocker/i;
const FAIL_RE = /\b(failed|failure|exit [1-9]\d?|timed out|time out|not verified|crashed|rejected|could not|cannot)\b/i;
/** Outcome words that a negation turns around; a sentence with one has not shipped. */
const NEGATED_RE = /\b(not|never|unable|cannot|failed|without)\b|n't\b/i;
const SHIP_LINK_RE = /https:\/\/(?:github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+|linear\.app\/[\w-]+\/issue\/DAV-\d+)/;

/** Calendar date and 24-hour time of an instant in an IANA zone. */
export function zonedParts(instantMs: number, zone: string): { date: string; time: string } {
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(instantMs))) parts[p.type] = p.value;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/** The UTC instant at which a calendar day starts in an IANA zone. */
export function dayStartUtc(date: string, zone: string): Date {
  const midnightUtc = Date.parse(`${date}T00:00:00Z`);
  const offsetAt = (instantMs: number): number => {
    const local = zonedParts(instantMs, zone);
    return Date.parse(`${local.date}T${local.time}:00Z`) - instantMs;
  };
  // The second pass uses the offset in force at the first answer, which is
  // right on a day where the zone changes its offset.
  return new Date(midnightUtc - offsetAt(midnightUtc - offsetAt(midnightUtc)));
}

/**
 * Captured turn anchors are UTC (`**User** (2026-10-29 2:02 AM):`). They are
 * converted to `zone` here so the day filter and the rendered times agree.
 */
export function splitTurns(text: string, zone = 'UTC'): Turn[] {
  const marks = [...text.matchAll(TURN_RE)];
  return marks.map((m, i) => {
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < marks.length ? (marks[i + 1].index ?? text.length) : text.length;
    const hour = Number(m[3]) % 12 + (m[5] === 'PM' ? 12 : 0);
    const local = zonedParts(Date.parse(`${m[2]}T${String(hour).padStart(2, '0')}:${m[4]}:00Z`), zone);
    return {
      role: m[1] === 'User' ? 'user' as const : 'assistant' as const,
      date: local.date,
      time: local.time,
      text: text.slice(start, end).trim(),
    };
  });
}

/**
 * Which role a session belongs to. Buzz primaries say "You are <Name>, the Buzz
 * agent"; crew workers say "reporting to <Name>"; AgentWorld worktrees carry
 * `aw-<role>-`. Legacy alias names map to the current role.
 */
export function attributeRole(text: string): AgentRole | null {
  const head = text.slice(0, 60_000);
  const own = /You are (Yoda|Aslan|Aragorn|Spock|Scotty|Gandalf|Mandalorian), the Buzz agent/.exec(head);
  const crew = /reporting to (Yoda|Aslan|Aragorn|Spock|Scotty|Gandalf|Mandalorian)\b/i.exec(head);
  const wt = /\baw-(yoda|aslan|aragorn|spock|scotty|gandalf|mandalorian)-/i.exec(head);
  const name = own?.[1] ?? crew?.[1] ?? wt?.[1];
  if (!name) return null;
  const role = name.toLowerCase() === 'gandalf' ? 'scotty' : name.toLowerCase();
  return (AGENT_ROLES as readonly string[]).includes(role) ? role as AgentRole : null;
}

const squash = (s: string, max = MAX_ITEM_CHARS): string => {
  const one = s.replace(/\s+/g, ' ').replace(/[`*]+/g, '').replace(/^[#>\s]+/, '').trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
};

/**
 * The ask: the `Content:` field of a Buzz event, else the `# Task:` or `# Goal`
 * heading of a delegated worker brief, else the first paragraph of a plain turn.
 */
export function askText(turnText: string): string | null {
  const events = [...turnText.matchAll(/^Content: ?([\s\S]*?)\n(?:Tags:|Parsed:|<\/buzz-event)/gm)];
  if (events.length) return squash(events[events.length - 1][1]);
  if (/<base>|<context>|<buzz-events?>/.test(turnText)) return null;
  const heading = /^# (?:Task|Goal):? *(.+)$/m.exec(turnText);
  if (heading) return squash(heading[1]);
  if (turnText.startsWith('<file ')) {
    const first = /^# (.+)$/m.exec(turnText);
    return first ? squash(first[1]) : null;
  }
  const goal = /^# Goal\s*\n+([\s\S]*?)(?:\n#|\n\n|$)/m.exec(turnText);
  return squash(goal?.[1] ?? turnText.split('\n\n')[0] ?? '');
}

const cap = <T,>(xs: T[]): T[] => xs.slice(0, MAX_ITEMS_PER_SECTION);

function dedupe(items: DayItem[]): DayItem[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const k = i.text.toLowerCase().slice(0, 100);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function buildRoleDay(role: AgentRole, date: string, sessions: SessionInput[], zone = 'UTC'): RoleDay {
  const out: RoleDay = {
    role, date, zone, sessions: [], sessionSlugs: [], asked: [], shipped: [], waiting: [], failed: [],
    links: { prs: [], issues: [] },
  };
  const prs = new Set<string>(), issues = new Set<string>();
  for (const s of sessions) {
    const allTurns = splitTurns(s.text, zone);
    const turns = allTurns.filter((t) => t.date === date);
    if (!turns.length) continue;
    const firstAsk = turns.find((t) => t.role === 'user');
    if (firstAsk && MEETING_RE.test(firstAsk.text.slice(0, 4000))) continue;
    out.sessions.push(s.sessionId);
    out.sessionSlugs.push(...s.slugs);
    const tag = s.sessionId.slice(0, 8);
    let meetingThread = false;
    for (const t of allTurns) {
      if (t.role === 'user') {
        const ask = askText(t.text);
        // The assistant turns that answer a meeting ask are skipped whole, also across midnight.
        meetingThread = Boolean(ask && MEETING_RE.test(ask));
        if (t.date === date && ask && ask.length >= 12 && !meetingThread) out.asked.push({ time: t.time, text: ask, session: tag });
        continue;
      }
      if (meetingThread || t.date !== date) continue;
      // Meeting content never feeds a page: this check runs on every line before
      // a link or a fact is read from it, so a later meeting line adds nothing.
      for (const line of t.text.split('\n').map((l) => l.trim()).filter((l) => l && !MEETING_RE.test(l))) {
        for (const url of line.match(PR_URL_RE) ?? []) prs.add(url);
        for (const url of line.match(ISSUE_URL_RE) ?? []) issues.add(url);
        if (line.length < 12 || line.startsWith('|')) continue;
        const bullet = line.replace(/^[-*•]\s*/, '');
        const item = { time: t.time, text: squash(bullet), session: tag };
        // A done word counts only in a sentence that also holds the link and no negation:
        // "I could not merge <PR>. It was not merged." ships nothing.
        const shippedHere = bullet.split(/(?<=[.!?])\s+/).some((sentence) =>
          SHIP_LINK_RE.test(sentence) && DONE_RE.test(sentence) && !NEGATED_RE.test(sentence));
        if (shippedHere) out.shipped.push(item);
        if (WAIT_RE.test(bullet) && !NOTHING_RE.test(bullet)) out.waiting.push(item);
        else if (FAIL_RE.test(bullet) && bullet.length < 400) out.failed.push(item);
      }
    }
  }
  out.asked = cap(dedupe(out.asked));
  out.shipped = cap(dedupe(out.shipped));
  out.waiting = cap(dedupe(out.waiting));
  out.failed = cap(dedupe(out.failed));
  out.links = { prs: [...prs].sort(), issues: [...issues].sort() };
  out.sessionSlugs = [...new Set(out.sessionSlugs)];
  return out;
}

export const agentDaySlug = (date: string, role: AgentRole): string => `digests/agent-day/${date}/${role}`;

function section(title: string, items: DayItem[], empty: string): string {
  if (!items.length) return `## ${title}\n\n${empty}\n`;
  return `## ${title}\n\n${items.map((i) => `- ${i.time} ${i.text} (session ${i.session})`).join('\n')}\n`;
}

/** Complete page markdown with frontmatter. Same input gives the same bytes. */
export function renderRoleDay(day: RoleDay): string {
  const name = day.role.charAt(0).toUpperCase() + day.role.slice(1);
  const lines = [
    '---',
    'type: note',
    `title: Agent day-out ${day.date} ${name}`,
    `digest_date: '${day.date}'`,
    `agent_role: ${day.role}`,
    'visibility: private',
    'generator: agent-day-v1',
    `session_count: ${day.sessions.length}`,
    '---',
    '',
    `# ${name} day-out ${day.date}`,
    '',
    `Extractive summary of ${day.sessions.length} captured session(s). Lines are copied from the session text, not paraphrased. Times are ${day.zone}.`,
    '',
    section('Asked', day.asked, 'No ask found in captured sessions.'),
    section('Shipped', day.shipped, 'No merged, opened or posted item with a PR or Linear link.'),
    section('Waiting on Dave', day.waiting, 'Nothing found.'),
    section('Failed or not verified', day.failed, 'Nothing found.'),
    '## Links',
    '',
    `- Pull requests: ${day.links.prs.length ? day.links.prs.join(' ') : 'none'}`,
    `- Linear issues: ${day.links.issues.length ? day.links.issues.join(' ') : 'none'}`,
    '',
    '## Sources',
    '',
    ...day.sessionSlugs.map((s) => `- ${s}`),
    '',
  ];
  return lines.join('\n');
}
