/**
 * cursor.ts — Cursor agent transcript (.jsonl) adapter.
 *
 * One file `<project>/agent-transcripts/<uuid>/<uuid>.jsonl` = one session;
 * `subagents/` siblings are delegated runs, not sessions, and are never
 * selected. Lines carry NO per-message timestamps, so times come from the
 * `<timestamp>` tag Cursor prepends to each user row; assistant rows carry the
 * previous message's time forward at render, except a trailing untagged
 * message, which takes the file mtime so appended replies count as an update.
 * A session with no tag starts at the file's birth time (mtime when the
 * filesystem has none).
 *
 * TURN SELECTION IS STRUCTURAL: a user row is human text only when it carries
 * a `<user_query>` block, and only that block's content is kept. Rows without
 * one are injected context (attached skills, subagent catalogs, timestamp-only
 * resume pings). Assistant rows keep `text` blocks; `tool_use` blocks and the
 * `{type, status}` turn bookkeeping rows are skipped.
 */

import { statSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { HostSpecTarget } from '../bootstrap/host-specs.ts';
import type {
  FileDiagnostics,
  ParsedSession,
  ParseSessionsOpts,
  TranscriptAdapter,
  TranscriptMessage,
} from './types.ts';
import { hasUnknownBlockShape, TRANSCRIPT_JSONL_HARD_CAP } from './types.ts';
import { readJsonlWithinBudget } from './bounded-read.ts';

const CURSOR_BLOCK_TYPES = ['text', 'tool_use'];

export const CURSOR_SPEC_TARGET: HostSpecTarget = {
  id: 'cursor-agent-transcript-2026-10',
  status: 'verified',
  verifiedAt: '2026-10-06',
  references: [
    'local ~/.cursor/projects/<project-slug>/agent-transcripts/<uuid>/<uuid>.jsonl (live sample 2026-10-06)',
    'test/fixtures/transcripts/cursor-agent-transcript.jsonl',
  ],
  note:
    "One JSON object per line: {role:'user'|'assistant', message:{content:[{type:'text', text} | " +
    "{type:'tool_use', name, input}]}} plus {type:'turn_ended', status, error?} bookkeeping rows. " +
    'User text wraps the typed prompt in <user_query>…</user_query> after a ' +
    "<timestamp>Wednesday, Sep 9, 2026, 1:36 AM (UTC+8)</timestamp> tag; user rows without " +
    'user_query are injected context. No per-line timestamps.',
};

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

const TIMESTAMP_TAG_RE =
  /<timestamp>\s*\w+, (\w{3}) (\d{1,2}), (\d{4}), (\d{1,2}):(\d{2}) (AM|PM) \(UTC(?:([+-])(\d{1,2})(?::?(\d{2}))?)?\)\s*<\/timestamp>/;
const USER_QUERY_RE = /<user_query>([\s\S]*?)<\/user_query>/g;

/** `<timestamp>Wednesday, Sep 9, 2026, 1:36 AM (UTC+8)</timestamp>` → UTC ISO. */
export function parseCursorTimestampTag(text: string): string | undefined {
  const m = TIMESTAMP_TAG_RE.exec(text);
  if (!m) return undefined;
  const month = MONTHS[m[1]];
  if (month === undefined) return undefined;
  const hour12 = Number(m[4]) % 12;
  const hour = m[6] === 'PM' ? hour12 + 12 : hour12;
  const offsetMinutes = m[7] ? (m[7] === '-' ? -1 : 1) * (Number(m[8]) * 60 + Number(m[9] ?? 0)) : 0;
  const utcMs = Date.UTC(Number(m[3]), month, Number(m[2]), hour, Number(m[5])) - offsetMinutes * 60_000;
  return Number.isNaN(utcMs) ? undefined : new Date(utcMs).toISOString();
}

function textBlocks(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('\n');
}

export const cursorAdapter: TranscriptAdapter = {
  format: 'cursor',
  specTarget: CURSOR_SPEC_TARGET,

  detect(path: string, sample: Buffer): boolean {
    if (!path.endsWith('.jsonl')) return false;
    for (const line of sample.toString('utf8').split('\n', 10)) {
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        if (obj === null || typeof obj !== 'object') return false;
        if (obj.type === 'turn_ended') continue;
        const keys = Object.keys(obj).sort().join(',');
        return keys === 'message,role' && (obj.role === 'user' || obj.role === 'assistant');
      } catch {
        return false;
      }
    }
    return false;
  },

  async *parse(path: string, opts: ParseSessionsOpts = {}): AsyncGenerator<ParsedSession, FileDiagnostics> {
    const budget = Math.max(1, Math.floor(opts.maxBytes ?? TRANSCRIPT_JSONL_HARD_CAP));
    const { raw, bytesRead, truncated } = readJsonlWithinBudget(path, budget);
    let skippedLines = 0;
    let firstTagTs = '';
    let lastTagTs = '';
    const messages: TranscriptMessage[] = [];

    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(t);
      } catch {
        skippedLines++;
        continue;
      }
      if (typeof entry !== 'object' || entry === null) {
        skippedLines++;
        continue;
      }
      const e = entry as Record<string, unknown>;
      if (e.type === 'turn_ended') continue;
      const msg = typeof e.message === 'object' && e.message !== null ? (e.message as Record<string, unknown>) : null;
      // A row that is neither bookkeeping nor a role+content-array turn is a
      // shape this parser does not know: count it so the file reads as drift.
      if (!msg || (e.role !== 'user' && e.role !== 'assistant') || !Array.isArray(msg.content)) {
        skippedLines++;
        continue;
      }
      // Only the observed block types are understood; anything else may carry
      // text textBlocks would drop, so the row counts as drift.
      if (hasUnknownBlockShape(msg.content, CURSOR_BLOCK_TYPES)) skippedLines++;
      const text = textBlocks(msg.content);
      if (e.role === 'user') {
        const timestamp = parseCursorTimestampTag(text) ?? '';
        if (timestamp && !firstTagTs) firstTagTs = timestamp;
        if (timestamp) lastTagTs = timestamp;
        const query = [...text.matchAll(USER_QUERY_RE)].map((m) => m[1].trim()).filter(Boolean).join('\n\n');
        if (query) messages.push({ role: 'user', timestamp, text: query });
      } else if (e.role === 'assistant') {
        const trimmed = text.trim();
        if (trimmed) messages.push({ role: 'assistant', timestamp: '', text: trimmed });
      }
    }

    let sessions = 0;
    if (messages.length > 0) {
      sessions = 1;
      const sessionId = basename(path, '.jsonl');
      const st = statSync(path);
      const mtimeIso = new Date(st.mtimeMs).toISOString();
      const startedAt = firstTagTs || new Date(st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs).toISOString();
      // Rows appended after the last tagged prompt have no time of their own.
      // Without one, the session's last timestamp stays at that prompt and
      // `ingest --since <watermark>` filters the updated session out; the file
      // mtime is the real time those rows were last written.
      const last = messages[messages.length - 1];
      if (!last.timestamp && mtimeIso > lastTagTs) last.timestamp = mtimeIso;
      yield {
        meta: {
          harness: 'cursor',
          sessionId,
          startedAt,
          raw: {
            session_id: sessionId,
            project: basename(dirname(dirname(dirname(path)))),
            source_path: path,
          },
        },
        messages,
      };
    }
    // Bookkeeping rows, injected user context and tool-only assistant rows are
    // understood traffic (e.g. a turn that failed on quota), not drift.
    const expectedEmpty = sessions === 0 && skippedLines === 0;
    return {
      bytesRead,
      skippedLines,
      truncated,
      sessions,
      expectedEmpty: expectedEmpty || undefined,
      zeroSessionsReason: sessions === 0 ? 'no <user_query> rows or assistant text in transcript' : undefined,
    };
  },
};
