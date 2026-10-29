/**
 * Write one private day-out page per agent role (DAV-7417).
 *
 *   bun scripts/write-agent-day-digests.ts [YYYY-MM-DD] [--dry-run]
 *
 * Reads `conversations/sessions/<date>-*` pages that the nightly daily-memory
 * run captured, groups them by agent role, and writes
 * `digests/agent-day/<date>/<role>` through the normal `put` operation. No model
 * call, no network. `--dry-run` prints the pages and writes nothing.
 */
import { randomUUID } from 'node:crypto';
import { loadConfig, toEngineConfig } from '../src/core/config.ts';
import { createEngine } from '../src/core/engine-factory.ts';
import { connectWithRetry } from '../src/core/db.ts';
import { calendarDateInTimeZone } from '../src/core/cycle/cycle-date.ts';
import {
  agentDaySlug, attributeRole, buildRoleDay, renderRoleDay, AGENT_ROLES,
  type AgentRole, type SessionInput,
} from '../src/core/digests/agent-day.ts';

const SOURCE_ID = 'default';

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
async function putPage(slug: string, content: string): Promise<void> {
  const cli = new URL('../src/cli.ts', import.meta.url).pathname;
  const args = ['put', slug, '--source-id', SOURCE_ID, '--force', '--request-id', randomUUID()];
  const proc = Bun.spawn([process.execPath, cli, ...args], { stdin: new TextEncoder().encode(content), stdout: 'pipe', stderr: 'pipe' });
  const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`put ${slug} exited ${code}: ${err.slice(-400).replace(/postgres(ql)?:\/\/\S+/g, '[redacted-url]')}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const date = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a))
    ?? calendarDateInTimeZone(new Date(), process.env.GBRAIN_DAILY_MEMORY_ZONE || process.env.TZ || 'Asia/Manila');
  const config = loadConfig();
  if (!config) throw new Error('no gbrain config');
  const engineConfig = { ...toEngineConfig(config), poolSize: 1 };
  const engine = await createEngine(engineConfig);
  const rendered: { role: AgentRole; slug: string; content: string; sessions: number }[] = [];
  let unattributed = 0;
  try {
    await connectWithRetry(engine, engineConfig);
    const listed = await engine.listPages({ slugPrefix: `conversations/sessions/${date}-`, limit: 5000, sort: 'slug' });
    const pages = [];
    for (const row of listed) {
      const page = await engine.getPage(row.slug, { sourceId: SOURCE_ID });
      if (!page) continue;
      const imported = page.frontmatter?.transcript_import as { session_id?: string } | undefined;
      pages.push({ slug: page.slug, body: `${page.compiled_truth}\n${page.timeline}`, sessionId: imported?.session_id });
    }
    const byRole = new Map<AgentRole, SessionInput[]>();
    for (const session of groupSessions(pages)) {
      const role = attributeRole(session.text);
      if (!role) { unattributed++; continue; }
      byRole.set(role, [...(byRole.get(role) ?? []), session]);
    }
    for (const role of AGENT_ROLES) {
      const day = buildRoleDay(role, date, byRole.get(role) ?? []);
      if (!day.sessions.length) continue;
      const slug = agentDaySlug(date, role);
      rendered.push({ role, slug, content: renderRoleDay(day), sessions: day.sessions.length });
    }
  } finally {
    await engine.disconnect();
  }
  const written: string[] = [];
  const failed: string[] = [];
  for (const page of rendered) {
    if (dryRun) { console.log(`<<< ${page.slug}\n${page.content}`); continue; }
    try {
      await putPage(page.slug, page.content);
      written.push(page.slug);
    } catch (error) {
      failed.push(page.slug);
      console.error(`agent-day: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(JSON.stringify({ date, dryRun, pages: rendered.map((p) => ({ slug: p.slug, sessions: p.sessions })), written, failed, unattributedSessions: unattributed }));
  if (failed.length) process.exitCode = 1;
}

if (import.meta.main) await main();
