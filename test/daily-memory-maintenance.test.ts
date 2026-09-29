/**
 * The daily maintenance job writes one durable memory from pages that
 * already live in sources. The test calls `autopilot-global-maintenance`
 * the way that job does: no phase list, so the handler defaults to
 * MAINTENANCE_PHASES and writes the note before the cycle.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';
import { resolveCycleDate } from '../src/core/cycle/cycle-date.ts';
import { dailyMemorySlug, DAILY_MEMORY_SOURCE_ID } from '../src/core/cycle/daily-memory.ts';

describe('daily memory from sources the brain already holds', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 30000);
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => { await resetPgliteState(engine); });

  test('autopilot-global-maintenance writes one note linking today\'s pages and skips older and dream pages', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ($1, $1), ($2, $2)`,
      ['notes', 'mail'],
    );
    await engine.putPage('meetings/standup', {
      type: 'meeting',
      title: 'Standup',
      compiled_truth: 'talked about the rollout',
    }, { sourceId: 'notes' });
    await engine.putPage('threads/acme-example', {
      type: 'email',
      title: 'Acme thread',
      compiled_truth: 'shipped the widget',
    }, { sourceId: 'mail' });
    await engine.putPage('archive/old-note', {
      type: 'note',
      title: 'Old note',
      compiled_truth: 'from earlier in the week',
    }, { sourceId: 'notes' });
    await engine.executeRaw(
      `UPDATE pages SET updated_at = now() - interval '3 days', effective_date = NULL
       WHERE source_id = $1 AND slug = $2`,
      ['notes', 'archive/old-note'],
    );
    await engine.putPage('dream-cycle-summaries/noise', {
      type: 'note',
      title: 'Dream cycle noise',
      compiled_truth: 'generated earlier today',
      frontmatter: { dream_generated: true },
    }, { sourceId: 'notes' });

    const handlers = new Map<string, (job: any) => Promise<any>>();
    await registerBuiltinHandlers(
      { register(name: string, fn: (job: any) => Promise<any>) { handlers.set(name, fn); } } as never,
      engine,
    );
    const handler = handlers.get('autopilot-global-maintenance');
    expect(handler).toBeTruthy();

    const repoPath = mkdtempSync(join(tmpdir(), 'gbrain-daily-memory-'));
    await handler!({ id: 6347, data: { repoPath }, signal: undefined });

    const day = await resolveCycleDate(engine);
    const page = await engine.getPage(dailyMemorySlug(day), { sourceId: DAILY_MEMORY_SOURCE_ID });
    expect(page).not.toBeNull();
    expect(page!.frontmatter.dream_generated).toBe(true);
    expect(page!.frontmatter.dream_cycle_date).toBe(day);
    expect(page!.compiled_truth).toContain('[[meetings/standup]]');
    expect(page!.compiled_truth).toContain('[[threads/acme-example]]');
    expect(page!.compiled_truth).toContain('## notes');
    expect(page!.compiled_truth).toContain('## mail');
    expect(page!.compiled_truth).not.toContain('archive/old-note');
    expect(page!.compiled_truth).not.toContain('Dream cycle noise');
    expect(page!.compiled_truth).not.toContain('talked about the rollout');
  }, 120_000);
});
