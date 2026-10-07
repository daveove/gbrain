/**
 * bounded-read.ts — the over-budget degrade shared by the JSONL session
 * adapters that import oversized files instead of rejecting them (codex, omp,
 * pi, cursor).
 *
 * HEAD + TAIL, not tail alone: these formats put session identity (id, cwd,
 * start time) in the first records, so a pure tail read would import the
 * newest turns with no attributable session. The join between the two windows
 * is a line boundary neither side owns; both partial lines fail JSON.parse and
 * land in the caller's skippedLines, which is the honest accounting.
 */

import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';

/** Head window cap; also limited to a quarter of the budget. */
const HEAD_WINDOW_BYTES = 256 * 1024;

export interface BoundedText {
  raw: string;
  bytesRead: number;
  truncated: boolean;
}

export function readJsonlWithinBudget(path: string, budget: number): BoundedText {
  const size = statSync(path).size;
  if (size <= budget) return { raw: readFileSync(path, 'utf8'), bytesRead: size, truncated: false };
  const head = Math.min(HEAD_WINDOW_BYTES, Math.floor(budget / 4));
  const tail = budget - head;
  const fd = openSync(path, 'r');
  try {
    const hbuf = Buffer.alloc(head);
    const hn = readSync(fd, hbuf, 0, head, 0);
    const tbuf = Buffer.alloc(tail);
    const tn = readSync(fd, tbuf, 0, tail, size - tail);
    return {
      raw: hbuf.subarray(0, hn).toString('utf8') + '\n' + tbuf.subarray(0, tn).toString('utf8'),
      bytesRead: hn + tn,
      truncated: true,
    };
  } finally {
    closeSync(fd);
  }
}
