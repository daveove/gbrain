/**
 * pi-session.ts — pi-session v3 (.jsonl) adapters for omp and pi.
 *
 * omp is a pi fork and both write the same line grammar that OpenClaw (also
 * pi-based) writes, so message/header/compaction lines map through the
 * shipped `mapOpenclawLine`; this module adds only the title lines and the
 * per-harness detection. One parser, two formats: the format name keeps slugs
 * and provenance distinct.
 *
 * TURN SELECTION IS STRUCTURAL: only `message` lines with role user/assistant
 * contribute, and only their `text` blocks. `thinking` and `toolCall` blocks,
 * `toolResult` and `developer` messages (injected reminders), `custom` /
 * `custom_message` lines (system notices, async results), model/thinking
 * changes, credential pins and compaction summaries are all skipped.
 */

import { basename } from 'node:path';
import type { HostSpecTarget } from '../bootstrap/host-specs.ts';
import type {
  FileDiagnostics,
  ParsedSession,
  ParseSessionsOpts,
  TranscriptAdapter,
  TranscriptMessage,
} from './types.ts';
import { hasUnknownBlockShape, TRANSCRIPT_JSONL_HARD_CAP } from './types.ts';
import { mapOpenclawLine } from './openclaw.ts';
import { readJsonlWithinBudget } from './bounded-read.ts';

const LINE_GRAMMAR =
  "One JSON object per line. Header {type:'session', version:3, id, timestamp, cwd}. " +
  "Turns {type:'message', timestamp ISO, message:{role, content:[{type:'text'|'thinking'|'toolCall', ...}], " +
  "timestamp epoch-ms}}; roles user/assistant/toolResult/developer. Only user/assistant text blocks " +
  'are kept; the line ISO timestamp is the message time. model_change, thinking_level_change, ' +
  'custom, custom_message, credential_pin, compaction: skipped. Oversized files degrade to a ' +
  'head+tail read. Unknown fields tolerated.';

export const OMP_SPEC_TARGET: HostSpecTarget = {
  id: 'omp-session-2026-10',
  status: 'verified',
  verifiedAt: '2026-10-06',
  references: [
    'local ~/.omp/agent/sessions/<cwd-slug>/<iso>_<id>.jsonl (live sample 2026-10-06)',
    'test/fixtures/transcripts/omp-session.jsonl',
  ],
  note:
    LINE_GRAMMAR +
    " omp leads with {type:'title', v, title} and renames via {type:'title_change', title}; the " +
    "latest title wins. Subagent sessions live one directory deeper (<id>/<Agent>.jsonl).",
};

export const PI_SPEC_TARGET: HostSpecTarget = {
  id: 'pi-session-2026-10',
  status: 'verified',
  verifiedAt: '2026-10-06',
  references: [
    'local ~/.pi/agent/sessions/<cwd-slug>/<iso>_<id>.jsonl (live sample 2026-10-06)',
    'test/fixtures/transcripts/pi-session.jsonl',
  ],
  note:
    LINE_GRAMMAR +
    " pi names a session via {type:'session_info', name}. Its first line is the same session " +
    "header OpenClaw writes, so auto-detection keys on the '.pi/agent/sessions' path.",
};

type PiFormat = 'omp' | 'pi';

/** Session title carried by a title-bearing line, if any. */
function titleOf(e: Record<string, unknown>): string | undefined {
  const value =
    e.type === 'title' || e.type === 'title_change' ? e.title : e.type === 'session_info' ? e.name : undefined;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function firstLineType(sample: Buffer): unknown {
  const firstLine = sample.toString('utf8').split('\n', 1)[0]?.trim();
  if (!firstLine) return undefined;
  try {
    const obj = JSON.parse(firstLine) as Record<string, unknown>;
    return obj !== null && typeof obj === 'object' ? obj.type : undefined;
  } catch {
    return undefined;
  }
}

const PI_ROLES = ['user', 'assistant', 'toolResult', 'developer'];
const PI_BLOCK_TYPES = ['text', 'thinking', 'toolCall', 'image'];

async function* parsePiSession(
  format: PiFormat,
  path: string,
  opts: ParseSessionsOpts,
): AsyncGenerator<ParsedSession, FileDiagnostics> {
  const budget = Math.max(1, Math.floor(opts.maxBytes ?? TRANSCRIPT_JSONL_HARD_CAP));
  const { raw, bytesRead, truncated } = readJsonlWithinBudget(path, budget);
  let skippedLines = 0;
  let sessionId = '';
  let cwd: string | undefined;
  let startedAt = '';
  let title: string | undefined;
  let sawHeader = false;
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
    const lineTitle = titleOf(entry as Record<string, unknown>);
    if (lineTitle) {
      title = lineTitle;
      continue;
    }
    const mapped = mapOpenclawLine(entry);
    if (mapped.kind === 'session') {
      if (sawHeader) continue;
      sawHeader = true;
      if (mapped.id) sessionId = mapped.id;
      if (mapped.cwd) cwd = mapped.cwd;
      if (mapped.startedAt) startedAt = mapped.startedAt;
      continue;
    }
    const e = entry as Record<string, unknown>;
    if (e.type !== 'message') continue;
    const m = typeof e.message === 'object' && e.message !== null ? (e.message as Record<string, unknown>) : null;
    // A message is understood when it has a known role and string or
    // known-block content. Anything else may hold text the shared mapper
    // dropped, so it counts as drift and the file can never pass as clean.
    const knownRole = m !== null && typeof m.role === 'string' && PI_ROLES.includes(m.role);
    const knownContent = m !== null &&
      (typeof m.content === 'string' || (Array.isArray(m.content) && !hasUnknownBlockShape(m.content, PI_BLOCK_TYPES)));
    if (!knownRole || !knownContent) skippedLines++;
    if (mapped.kind !== 'message') continue;
    // The line's ISO time is the turn time; the message's own epoch-ms time
    // is the source-backed fallback. A kept turn with neither cannot be
    // ordered against `ingest --since`, so it counts as drift.
    const message = mapped.message;
    if (Number.isNaN(Date.parse(message.timestamp))) {
      const epoch = m?.timestamp;
      const fallback = typeof epoch === 'number' ? new Date(epoch) : null;
      if (fallback && !Number.isNaN(fallback.getTime())) message.timestamp = fallback.toISOString();
      else {
        message.timestamp = '';
        skippedLines++;
      }
    }
    messages.push(message);
  }

  let sessions = 0;
  if (messages.length > 0) {
    sessions = 1;
    const sid = sessionId || basename(path, '.jsonl');
    yield {
      meta: {
        harness: format,
        sessionId: sid,
        title,
        cwd,
        startedAt: startedAt || messages[0].timestamp || undefined,
        raw: { session_id: sid, cwd: cwd ?? null, source_path: path },
      },
      messages,
    };
  }
  return {
    bytesRead,
    skippedLines,
    truncated,
    sessions,
    // A header-only session (opened, never prompted) is understood, not drift.
    expectedEmpty: sessions === 0 && sawHeader && skippedLines === 0 ? true : undefined,
    zeroSessionsReason: sessions === 0 ? 'no user/assistant text blocks in session file' : undefined,
  };
}

export const ompAdapter: TranscriptAdapter = {
  format: 'omp',
  specTarget: OMP_SPEC_TARGET,
  detect(path: string, sample: Buffer): boolean {
    return path.endsWith('.jsonl') && firstLineType(sample) === 'title';
  },
  parse(path: string, opts: ParseSessionsOpts = {}) {
    return parsePiSession('omp', path, opts);
  },
};

const PI_ROOT_SEGMENT = /[/\\]\.pi[/\\]agent[/\\]sessions[/\\]/;

export const piAdapter: TranscriptAdapter = {
  format: 'pi',
  specTarget: PI_SPEC_TARGET,
  detect(path: string, sample: Buffer): boolean {
    return path.endsWith('.jsonl') && PI_ROOT_SEGMENT.test(path) && firstLineType(sample) === 'session';
  },
  parse(path: string, opts: ParseSessionsOpts = {}) {
    return parsePiSession('pi', path, opts);
  },
};
