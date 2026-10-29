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
const MEETING_RE = /circleback|pocket\.|pocket (?:meeting|recording|transcript)|personal meeting/i;
const DONE_RE = /\b(merged|opened|created|posted|deployed|shipped|filed|fixed|pushed|landed|closed|resolved|result:|installed|published|wrote|updated)\b/i;
const WAIT_RE = /(dave must(?! do:? ?nothing)|waiting on dave|needs dave|parked on dave|passkey|(?:for|from) dave'?s? (?:approval|decision|go\b|sign-?in|tap))/i;
const NOTHING_RE = /dave must do:?\s*nothing|nothing blocked|not blocked|no blocker/i;
const FAIL_RE = /\b(failed|failure|exit [1-9]\d?|timed out|time out|not verified|crashed|rejected|could not|cannot)\b/i;

export function splitTurns(text: string): Turn[] {
  const marks = [...text.matchAll(TURN_RE)];
  return marks.map((m, i) => {
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < marks.length ? (marks[i + 1].index ?? text.length) : text.length;
    return {
      role: m[1] === 'User' ? 'user' as const : 'assistant' as const,
      date: m[2],
      time: `${String(Number(m[3]) % 12 + (m[5] === 'PM' ? 12 : 0)).padStart(2, '0')}:${m[4]}`,
      text: text.slice(start, end).trim(),
    };
  });
}

/**
 * Which role a session belongs to. Buzz primaries say "You are <Name>, the Buzz
 * agent"; crew workers say "reporting to <Name>"; AgentWorld worktrees carry
 * `aw-<role>-`. Gandalf was Scotty's name until 23 Oct 2026.
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

function sentenceLines(text: string): string[] {
  return text.split('\n').map((l) => l.replace(/^\s*[-*•]\s*/, '').trim()).filter((l) => l.length >= 12);
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

export function buildRoleDay(role: AgentRole, date: string, sessions: SessionInput[]): RoleDay {
  const out: RoleDay = {
    role, date, sessions: [], sessionSlugs: [], asked: [], shipped: [], waiting: [], failed: [],
    links: { prs: [], issues: [] },
  };
  const prs = new Set<string>(), issues = new Set<string>();
  for (const s of sessions) {
    const turns = splitTurns(s.text).filter((t) => t.date === date);
    if (!turns.length) continue;
    const firstAsk = turns.find((t) => t.role === 'user');
    if (firstAsk && MEETING_RE.test(firstAsk.text.slice(0, 4000))) continue;
    out.sessions.push(s.sessionId);
    out.sessionSlugs.push(...s.slugs);
    const tag = s.sessionId.slice(0, 8);
    for (const t of turns) {
      if (t.role === 'user') {
        const ask = askText(t.text);
        if (ask && ask.length >= 12 && !MEETING_RE.test(ask)) out.asked.push({ time: t.time, text: ask, session: tag });
        continue;
      }
      for (const url of t.text.match(PR_URL_RE) ?? []) prs.add(url);
      for (const url of t.text.match(ISSUE_URL_RE) ?? []) issues.add(url);
      for (const line of sentenceLines(t.text)) {
        if (MEETING_RE.test(line) || line.startsWith('|')) continue;
        const item = { time: t.time, text: squash(line), session: tag };
        const hasLink = PR_URL_RE.test(line) || ISSUE_URL_RE.test(line);
        PR_URL_RE.lastIndex = 0; ISSUE_URL_RE.lastIndex = 0;
        if (hasLink && DONE_RE.test(line)) out.shipped.push(item);
        if (WAIT_RE.test(line) && !NOTHING_RE.test(line)) out.waiting.push(item);
        else if (FAIL_RE.test(line) && line.length < 400) out.failed.push(item);
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
    `Extractive summary of ${day.sessions.length} captured session(s). Lines are copied from the session text, not paraphrased. Times are Asia/Manila.`,
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
