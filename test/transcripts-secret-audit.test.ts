/**
 * The installed-base transcript secret audit (#6147) and its doctor check.
 * Pages imported before the labeled-credential detector keep a typed
 * password; `gbrain transcripts audit-secrets` lists them by slug and count
 * (never a value) and `transcript_secret_exposure` reads its cached summary.
 *
 * R3/R4: engine in beforeAll, disconnect in afterAll; state reset per test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  CONVERSATION_SECRET_AUDIT_KEY,
  TRANSCRIPT_SECRET_AUDIT_KEY,
  auditTranscriptSecrets,
  loadTranscriptSecretAudit,
  saveTranscriptSecretAudit,
} from '../src/core/transcripts/secret-audit.ts';
import { transcriptSecretExposureCheck } from '../src/commands/doctor/checks/transcript-secrets.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';

const PW = ['hunter', '2'].join('');
let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

async function conversation(slug: string, body: string): Promise<void> {
  await engine.putPage(slug, {
    type: 'conversation', title: 'session', compiled_truth: body,
    frontmatter: { transcript_import: { harness: 'codex', session_id: slug } },
  });
}

const ctx = () => ({ engine, progress: { heartbeat() {} } }) as unknown as DoctorContext;

describe('transcripts audit-secrets', () => {
  test('lists affected conversation pages with counts and lines, never values; other pages are not scanned', async () => {
    await conversation('conversations/sessions/2026-01-02-codex-aaaaaaaaaaaa', `intro\nuser: password: ${PW}\nok\nlogin alice-example / ${PW}`);
    await conversation('conversations/sessions/2026-01-03-codex-bbbbbbbbbbbb', 'nothing secret here');
    await engine.putPage('notes/ops', { type: 'note', title: 'ops', compiled_truth: `password: ${PW}` });
    const result = await auditTranscriptSecrets(engine);
    expect(result.pages_scanned).toBe(2);
    expect(result.pages_affected).toBe(1);
    expect(result.hits_total).toBe(2);
    expect(result.by_pattern).toEqual({ labeled_credential: 2 });
    expect(result.pages).toEqual([
      { id: expect.any(Number), slug: 'conversations/sessions/2026-01-02-codex-aaaaaaaaaaaa', source_id: 'default', content_hash: expect.any(String), hits: { labeled_credential: 2 }, lines: [2, 4] },
    ]);
    expect(result.scope).toBe('transcripts');
    expect(JSON.stringify(result)).not.toContain(PW);
  });

  test('the cached summary carries no slugs and no values', async () => {
    await conversation('conversations/sessions/2026-01-02-codex-aaaaaaaaaaaa', `password: ${PW}`);
    expect(await saveTranscriptSecretAudit(engine, await auditTranscriptSecrets(engine))).toBe(true);
    const raw = (await engine.getConfig(TRANSCRIPT_SECRET_AUDIT_KEY)) ?? '';
    expect(raw).not.toContain(PW);
    expect(raw).not.toContain('conversations/');
    expect((await loadTranscriptSecretAudit(engine))?.hits_total).toBe(1);
  });
});

describe('transcripts audit-secrets --scope conversations (DAV-7162 monitor record)', () => {
  test('finds a seeded secret in body, title or frontmatter of any conversation page, imported or not', async () => {
    await conversation('conversations/sessions/2026-01-02-codex-aaaaaaaaaaaa', `ok\npassword: ${PW}`);
    await engine.putPage('conversations/manual/title-hit', { type: 'conversation', title: `password: ${PW}`, compiled_truth: 'clean' });
    await engine.putPage('conversations/manual/frontmatter-hit', { type: 'conversation', title: 'notes', compiled_truth: 'clean', frontmatter: { setup: `password: ${PW}` } });
    await engine.putPage('conversations/manual/clean', { type: 'conversation', title: 'clean', compiled_truth: 'nothing here' });
    await engine.putPage('notes/ops', { type: 'note', title: 'ops', compiled_truth: `password: ${PW}` });
    const result = await auditTranscriptSecrets(engine, { scope: 'conversations' });
    expect(result.scope).toBe('conversations');
    expect(result.pages_scanned).toBe(4);
    expect(result.pages_affected).toBe(3);
    expect(result.by_pattern).toEqual({ labeled_credential: 3 });
    // The transcripts scope still covers imported pages only, title and body only.
    expect((await auditTranscriptSecrets(engine)).pages_affected).toBe(1);
  });

  test('the stored record has counts, pattern names, page ids and the scan start; no slug and no matched text', async () => {
    await conversation('conversations/sessions/2026-01-02-codex-aaaaaaaaaaaa', `ok\npassword: ${PW}`);
    await engine.putPage('conversations/manual/frontmatter-hit', { type: 'conversation', title: 'notes', compiled_truth: 'clean', frontmatter: { setup: `password: ${PW}` } });
    const times = ['2026-10-23T01:00:00.000Z', '2026-10-23T01:00:05.000Z'];
    const result = await auditTranscriptSecrets(engine, { scope: 'conversations', now: () => new Date(times.shift() ?? '2026-10-23T02:00:00.000Z') });
    expect(await saveTranscriptSecretAudit(engine, result)).toBe(true);
    const raw = (await engine.getConfig(CONVERSATION_SECRET_AUDIT_KEY)) ?? '';
    expect(raw).not.toContain(PW);
    expect(raw).not.toContain('password');
    expect(raw).not.toContain('conversations/');
    const record = JSON.parse(raw);
    expect(record).toMatchObject({
      schema_version: 1, scope: 'conversations', complete: true, source_id: null, detector_version: 1,
      started_at: '2026-10-23T01:00:00.000Z', scanned_at: '2026-10-23T01:00:05.000Z',
      pages_scanned: 2, pages_affected: 2, hits_total: 2, by_pattern: { labeled_credential: 2 }, affected_pages_capped: false,
    });
    expect(record.affected_pages).toEqual(result.pages.map((p) => ({ id: p.id, source_id: 'default', content_hash: p.content_hash, hits: { labeled_credential: 1 } })));
    expect(Object.keys(record.affected_pages[0]).sort()).toEqual(['content_hash', 'hits', 'id', 'source_id']);
    // The doctor summary is a separate row and is not touched.
    expect(await engine.getConfig(TRANSCRIPT_SECRET_AUDIT_KEY)).toBeNull();
  });

  test('a clean scan stores a zero-hit record; a source-scoped result never makes a monitor record', async () => {
    await engine.putPage('conversations/manual/clean', { type: 'conversation', title: 'clean', compiled_truth: 'nothing here' });
    expect(await saveTranscriptSecretAudit(engine, await auditTranscriptSecrets(engine, { scope: 'conversations' }))).toBe(true);
    expect(JSON.parse((await engine.getConfig(CONVERSATION_SECRET_AUDIT_KEY)) ?? '{}')).toMatchObject({ pages_scanned: 1, hits_total: 0, affected_pages: [] });
    const scoped = await auditTranscriptSecrets(engine, { scope: 'conversations', sourceId: 'default' });
    expect(await saveTranscriptSecretAudit(engine, scoped)).toBe(false);
  });
});

describe('transcript_secret_exposure doctor check', () => {
  test('no imported conversation pages: no check emitted', async () => {
    expect(await transcriptSecretExposureCheck(ctx())).toBeNull();
  });

  test('never audited: warn with the read-only audit as fix', async () => {
    await conversation('conversations/sessions/2026-01-02-codex-aaaaaaaaaaaa', `password: ${PW}`);
    const check = await transcriptSecretExposureCheck(ctx());
    expect(check?.status).toBe('warn');
    expect((check?.fix as { argv: string[] }).argv).toEqual(['gbrain', 'transcripts', 'audit-secrets', '--json']);
    expect(check?.message).toContain('never been audited');
  });

  test('a cached audit with hits warns with its age; a clean audit is ok; the check never scans pages', async () => {
    await conversation('conversations/sessions/2026-01-02-codex-aaaaaaaaaaaa', `password: ${PW}`);
    const now = Date.parse('2026-10-06T12:00:00.000Z');
    await saveTranscriptSecretAudit(engine, await auditTranscriptSecrets(engine, { now: () => new Date(now - 3 * 3_600_000) }));
    const warn = await transcriptSecretExposureCheck(ctx(), now);
    expect(warn?.status).toBe('warn');
    expect(warn?.message).toContain('(3h ago) found 1 credential hit(s) on 1 conversation page(s)');
    expect(JSON.stringify(warn)).not.toContain(PW);

    await conversation('conversations/sessions/2026-01-02-codex-aaaaaaaaaaaa', 'password: <REDACTED:labeled_credential>');
    const stale = await transcriptSecretExposureCheck(ctx(), now);
    expect(stale?.status).toBe('warn');

    await saveTranscriptSecretAudit(engine, await auditTranscriptSecrets(engine, { now: () => new Date(now) }));
    const ok = await transcriptSecretExposureCheck(ctx(), now);
    expect(ok?.status).toBe('ok');
  });

  test('a source-scoped audit does not clear the brain-wide warning', async () => {
    await conversation('conversations/sessions/2026-01-02-codex-aaaaaaaaaaaa', 'clean');
    await saveTranscriptSecretAudit(engine, await auditTranscriptSecrets(engine, { sourceId: 'default' }));
    const check = await transcriptSecretExposureCheck(ctx());
    expect(check?.status).toBe('warn');
    expect(check?.message).toContain('covered only source default');
  });
});
