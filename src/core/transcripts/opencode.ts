/**
 * opencode.ts — opencode session export (.json) adapter.
 *
 * opencode keeps sessions in SQLite (`~/.local/share/opencode/opencode.db`).
 * This adapter reads the per-session EXPORT shape — what `opencode export
 * <id>` prints and what scripts/daily-memory-seat-files.py writes from a
 * read-only query of the same store: {info, messages:[{info, parts}]}.
 *
 * TURN SELECTION IS STRUCTURAL: messages with info.role user/assistant
 * contribute their `text` parts; `synthetic` text parts (injected
 * continuation prompts) and every other part type (reasoning, tool,
 * step-start/finish, patch, file, compaction) are skipped. Monolithic JSON:
 * over-cap files are rejected, never truncated.
 */

import { readFileSync, statSync } from 'node:fs';
import type { HostSpecTarget } from '../bootstrap/host-specs.ts';
import type {
  FileDiagnostics,
  ParsedSession,
  ParseSessionsOpts,
  TranscriptAdapter,
  TranscriptMessage,
} from './types.ts';
import { hasUnknownBlockShape, TRANSCRIPT_JSONL_HARD_CAP } from './types.ts';

const OPENCODE_PART_TYPES = [
  'text', 'reasoning', 'tool', 'file', 'step-start', 'step-finish',
  'snapshot', 'patch', 'agent', 'retry', 'compaction', 'subtask',
];

export const OPENCODE_SPEC_TARGET: HostSpecTarget = {
  id: 'opencode-export-2026-10',
  status: 'verified',
  verifiedAt: '2026-10-06',
  references: [
    'local `opencode export <id>` (opencode 1.18.34, live sample 2026-10-06)',
    'local ~/.local/share/opencode/opencode.db tables session/message/part (data JSON columns)',
    'test/fixtures/transcripts/opencode-export.json',
  ],
  note:
    "Top level {info:{id:'ses_…', title, directory, time:{created, updated} epoch-ms, parentID?}, " +
    "messages:[{info:{id, role:'user'|'assistant', time:{created}}, parts:[{type, text?, synthetic?}]}]}. " +
    "Kept: non-synthetic type:'text' parts. Skipped: reasoning, tool, step-start, step-finish, " +
    'patch, file, compaction, synthetic text. Unknown fields tolerated.',
};

/** Structural head sniff: the export always opens with info.id = ses_… . */
const EXPORT_HEAD_RE = /^\s*\{\s*"info"\s*:\s*\{\s*"id"\s*:\s*"ses_/;

function epochIso(value: unknown): string {
  if (typeof value !== 'number') return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export const opencodeAdapter: TranscriptAdapter = {
  format: 'opencode',
  specTarget: OPENCODE_SPEC_TARGET,

  detect(path: string, sample: Buffer): boolean {
    return path.endsWith('.json') && EXPORT_HEAD_RE.test(sample.toString('utf8'));
  },

  async *parse(path: string, opts: ParseSessionsOpts = {}): AsyncGenerator<ParsedSession, FileDiagnostics> {
    const cap = opts.maxBytes ?? TRANSCRIPT_JSONL_HARD_CAP;
    const size = statSync(path).size;
    if (size > cap) throw new Error(`opencode export too large for import: ${size} bytes (cap ${cap})`);
    const doc = record(JSON.parse(readFileSync(path, 'utf8')));
    const info = record(doc.info);
    const sessionId = typeof info.id === 'string' ? info.id : '';
    if (!sessionId || !Array.isArray(doc.messages)) {
      throw new Error('not an opencode session export (expected {info:{id}, messages:[]})');
    }

    let skippedLines = 0;
    const messages: TranscriptMessage[] = [];
    for (const item of doc.messages) {
      const msgInfo = record(record(item).info);
      const role = msgInfo.role === 'user' || msgInfo.role === 'assistant' ? msgInfo.role : null;
      const parts = record(item).parts;
      if (!role || !Array.isArray(parts)) {
        skippedLines++;
        continue;
      }
      // Part types from opencode's own part union; any other shape may carry
      // text this filter would drop, so the export reads as drift.
      if (hasUnknownBlockShape(parts, OPENCODE_PART_TYPES)) skippedLines++;
      const textParts = parts.map(record).filter((p) => p.type === 'text');
      const text = textParts
        .filter((p) => p.synthetic !== true && typeof p.text === 'string')
        .map((p) => (p.text as string).trim())
        .filter(Boolean)
        .join('\n');
      if (!text) continue;
      const timestamp = epochIso(record(msgInfo.time).created);
      // Without its own time, an appended message inherits the previous one's
      // at render and `ingest --since` can filter the updated session; count
      // it so the scan stays unclean and the watermark holds.
      if (!timestamp) skippedLines++;
      messages.push({ role, timestamp, text });
    }

    let sessions = 0;
    if (messages.length > 0) {
      sessions = 1;
      const directory = typeof info.directory === 'string' ? info.directory : undefined;
      yield {
        meta: {
          harness: 'opencode',
          sessionId,
          title: typeof info.title === 'string' && info.title.trim() ? info.title.trim() : undefined,
          cwd: directory,
          startedAt: epochIso(record(info.time).created) || messages[0].timestamp || undefined,
          raw: { session_id: sessionId, cwd: directory ?? null, source_path: path },
        },
        messages,
      };
    }
    return {
      bytesRead: size,
      skippedLines,
      truncated: false,
      sessions,
      // A valid export with no messages, or only reasoning/tool/synthetic
      // parts, is understood. Malformed messages count in skippedLines.
      expectedEmpty: sessions === 0 && skippedLines === 0 ? true : undefined,
      zeroSessionsReason: sessions === 0 ? 'no non-synthetic text parts in user/assistant messages' : undefined,
    };
  },
};
