/**
 * Write one private day-out page per agent role (DAV-7417).
 *
 *   bun scripts/write-agent-day-digests.ts [YYYY-MM-DD] [--zone Asia/Manila] [--dry-run]
 *
 * Reads captured session pages and local OMP transcripts. Local text stays in
 * memory; only extracted private `digests/agent-day/<date>/<role>` pages are
 * written through `put`. No model call. `--dry-run` prints JSON counts only.
 */
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, toEngineConfig } from '../src/core/config.ts';
import { createEngine } from '../src/core/engine-factory.ts';
import { connectWithRetry } from '../src/core/db.ts';
import { calendarDateInTimeZone } from '../src/core/cycle/cycle-date.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import {
  agentDaySlug, attributeRole, buildRoleDay, dayStartUtc, renderRoleDay, AGENT_ROLES, PRIMARY_ROLES,
  type AgentRole, type SessionInput,
} from '../src/core/digests/agent-day.ts';
import { ompAdapter } from '../src/core/transcripts/pi-session.ts';
import { loadImportRedactionPatterns, redactSession, renderSessionParts, type ImportRedactionPattern } from '../src/core/transcripts/render.ts';

const SOURCE_ID = 'default';

async function entries(path: string) {
  try { return (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** Read local OMP sessions without importing their raw text into the brain. */
export async function readLocalAgentSessions(date: string, zone: string, opts: {
  root?: string; patterns?: ImportRedactionPattern[];
} = {}): Promise<SessionInput[]> {
  const root = opts.root || process.env.GBRAIN_DAILY_MEMORY_OMP_ROOT || join(homedir(), '.omp', 'agent', 'sessions');
  const folders: { path: string; role?: AgentRole }[] = [];
  for (const entry of await entries(root)) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'agentworld') {
      for (const [id, role] of Object.entries(PRIMARY_ROLES)) folders.push({ path: join(root, entry.name, id), role });
    } else folders.push({ path: join(root, entry.name) });
  }
  const start = dayStartUtc(date, zone).getTime();
  const nextDate = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const end = dayStartUtc(nextDate, zone).getTime();
  const patterns = opts.patterns ?? loadImportRedactionPatterns();
  const sessions = new Map<string, SessionInput>();
  for (const folder of folders) {
    for (const entry of await entries(folder.path)) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const path = join(folder.path, entry.name);
      // Read the full file: head/tail truncation can omit the requested day's middle turns.
      for await (const parsed of ompAdapter.parse(path, { maxBytes: Number.MAX_SAFE_INTEGER })) {
        if (!parsed.messages.some(message => {
          const time = Date.parse(message.timestamp);
          return time >= start && time < end;
        })) continue;
        const redacted = redactSession(parsed, { patterns });
        let head = '';
        for (const message of redacted.session.messages) {
          head += message.text.slice(0, 60_000 - head.length) + '\n';
          if (head.length >= 60_000) break;
        }
        const role = folder.role ?? attributeRole(head) ?? undefined;
        const previousUser = redacted.session.messages.findLast(message => message.role === 'user' && Date.parse(message.timestamp) < start);
        const messages = redacted.session.messages.filter(message => {
          const time = Date.parse(message.timestamp);
          return message === previousUser || (time >= start && time < end);
        });
        const rendered = renderSessionParts({ ...redacted, session: { ...redacted.session, messages } }, { sourcePath: path });
        const sessionId = parsed.meta.sessionId;
        const prior = sessions.get(sessionId);
        sessions.set(sessionId, {
          sessionId, role: role ?? prior?.role,
          slugs: [...(prior?.slugs ?? []), pathToFileURL(path).href],
          text: [prior?.text, ...rendered.parts.map(part => part.body)].filter(Boolean).join('\n'),
        });
      }
    }
  }
  return [...sessions.values()];
}

/** `<hash>-p3` is part 3 of a session; no suffix is part 1. */
export function partNumber(slug: string): number {
  const m = /-p(\d+)$/.exec(slug);
  return m ? Number(m[1]) : 1;
}

export function groupSessions(pages: { slug: string; body: string; sessionId?: string }[]): SessionInput[] {
  const bySession = new Map<string, { slug: string; body: string }[]>();
  for (const p of pages) {
    const key = p.sessionId ?? p.slug.replace(/-p\d+$/, '');
    bySession.set(key, [...(bySession.get(key) ?? []), p]);
  }
  return [...bySession].map(([sessionId, parts]) => {
    parts.sort((a, b) => partNumber(a.slug) - partNumber(b.slug));
    return { sessionId, slugs: parts.map((p) => p.slug), text: parts.map((p) => p.body).join('\n') };
  });
}

/** The generator owns these pages, so a rerun replaces the whole page (`--force`), as the Grok Bot digests do. */
export async function putPage(slug: string, content: string, cli = new URL('../src/cli.ts', import.meta.url).pathname): Promise<void> {
  const args = ['put', slug, '--source-id', SOURCE_ID, '--force', '--wait', '300', '--timeout', '360s', '--no-accept-pending', '--request-id', randomUUID()];
  const input = new TextEncoder().encode(content);
  for (let attempt = 0; attempt < 2; attempt++) {
    const proc = Bun.spawn([process.execPath, cli, ...args], { stdin: input, stdout: 'pipe', stderr: 'pipe' });
    const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const pending = /\bwrite_pending\b/.test(out) || /\bwrite_pending\b/.test(err);
    if (code === 0 && !pending) return;
    if (attempt === 0 && (pending || code === 10 || code === 124 || /\btimed? out\b|\bETIMEDOUT\b/i.test(`${out}\n${err}`))) continue;
    throw new Error(`put ${slug} exited ${code}: ${err.slice(-400).replace(/postgres(ql)?:\/\/\S+/g, '[redacted-url]')}`);
  }
}

export interface AgentDayBuild {
  pages: { role: AgentRole; slug: string; content: string; sessions: number }[];
  unattributed: number;
}

/**
 * Day-out pages for one calendar day in `zone`. A slug carries the UTC date a
 * session started, so a session that began on an earlier day and ran past
 * midnight is not under today's prefix. Sessions are found by when their pages
 * last changed; every part is read and only the day's turns are kept.
 */
export async function buildAgentDayPages(engine: BrainEngine, date: string, zone: string, localSessions: SessionInput[] = []): Promise<AgentDayBuild> {
  const touched = await engine.listPages({
    slugPrefix: 'conversations/sessions/', updated_after: dayStartUtc(date, zone).toISOString(), limit: 20000, sort: 'updated_asc',
  });
  const bases = [...new Set(touched.map((row) => row.slug.replace(/-p\d+$/, '')))];
  const pages = [];
  for (const base of bases) {
    for (let part = 1; ; part++) {
      const page = await engine.getPage(part === 1 ? base : `${base}-p${part}`, { sourceId: SOURCE_ID });
      if (!page) break;
      const imported = page.frontmatter?.transcript_import as { session_id?: string } | undefined;
      pages.push({ slug: page.slug, body: `${page.compiled_truth}\n${page.timeline}`, sessionId: imported?.session_id });
    }
  }
  const sessions = new Map(groupSessions(pages).map(session => [session.sessionId, session]));
  for (const session of localSessions) {
    const captured = sessions.get(session.sessionId);
    sessions.set(session.sessionId, { ...session, slugs: [...new Set([...(captured?.slugs ?? []), ...session.slugs])] });
  }
  const byRole = new Map<AgentRole, SessionInput[]>();
  let unattributed = 0;
  for (const session of sessions.values()) {
    const role = session.role ?? attributeRole(session.text);
    if (!role) { unattributed++; continue; }
    byRole.set(role, [...(byRole.get(role) ?? []), session]);
  }
  const out = [];
  for (const role of AGENT_ROLES) {
    const day = buildRoleDay(role, date, byRole.get(role) ?? [], zone);
    if (!day.sessions.length) continue;
    out.push({ role, slug: agentDaySlug(date, role), content: renderRoleDay(day), sessions: day.sessions.length });
  }
  return { pages: out, unattributed };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const zoneFlag = args.indexOf('--zone');
  const zone = (zoneFlag >= 0 ? args[zoneFlag + 1] : undefined)
    || process.env.GBRAIN_DAILY_MEMORY_ZONE || process.env.TZ || 'Asia/Manila';
  const date = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) ?? calendarDateInTimeZone(new Date(), zone);
  const config = loadConfig();
  if (!config) throw new Error('no gbrain config');
  // OMP is a seat beyond codex: read it only when the operator opted in via
  // GBRAIN_DAILY_MEMORY_SEATS, the same list the nightly capture uses.
  const seats = (process.env.GBRAIN_DAILY_MEMORY_SEATS || 'codex').split(/\s+/).filter(Boolean);
  const localSessions = seats.includes('omp') ? await readLocalAgentSessions(date, zone) : [];
  const engineConfig = { ...toEngineConfig(config), poolSize: 1 };
  const engine = await createEngine(engineConfig);
  let built: AgentDayBuild;
  try {
    await connectWithRetry(engine, engineConfig);
    built = await buildAgentDayPages(engine, date, zone, localSessions);
  } finally {
    await engine.disconnect();
  }
  const { pages: rendered, unattributed } = built;
  const written: string[] = [];
  const failed: string[] = [];
  for (const page of rendered) {
    if (dryRun) continue;
    try {
      await putPage(page.slug, page.content);
      written.push(page.slug);
    } catch (error) {
      failed.push(page.slug);
      console.error(`agent-day: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(JSON.stringify({ date, dryRun, pages: rendered.map((p) => ({ slug: p.slug, sessions: p.sessions })),
    sessionsByRole: Object.fromEntries(AGENT_ROLES.map(role => [role, rendered.find(page => page.role === role)?.sessions ?? 0])),
    written, failed, unattributedSessions: unattributed }));
  if (failed.length) process.exitCode = 1;
}

if (import.meta.main) await main();
