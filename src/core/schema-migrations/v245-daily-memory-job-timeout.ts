import type { Migration } from './types.ts';

/**
 * Pending daily-memory jobs keep the 10-minute timeout stamped when they were
 * queued, so a heavy historical day rewrite can never finish (DAV-7404). Raise
 * only pending rows still at the old default to the current 20-minute budget.
 */
export const v245: Migration = {
  version: 245,
  name: 'daily_memory_job_timeout',
  idempotent: true,
  sql: `UPDATE minion_jobs SET timeout_ms=1200000
    WHERE name='autopilot-daily-memory' AND timeout_ms=600000
      AND status IN ('waiting','delayed','active','waiting-children','paused');`,
};
