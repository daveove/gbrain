import { test, expect } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { spawnSync } from 'node:child_process';
import { operations } from '../src/core/operations.ts';
import { evidenceRecordReader } from '../src/core/evidence-context-reader.ts';
import { assembleEvidenceContexts } from '../packages/evidence-context/index.mjs';

const params = { source_id: 'default', accounts: [{ system: 'chat', network: 'network', accountKind: 'profile', account: 'owner-a' }], items: [{ id: 'item', references: [{ sourceType: 'comms_channel', sourceRef: 'a' }] }] };

test('the shared package runs its behavior suite under ordinary Node without Bun or engine imports', () => {
  const result = spawnSync('node', ['--test', 'packages/evidence-context/test/context.test.mjs'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('fail 0');
});

test('stock GBrain does not advertise an operation backed by a host-only intake table', () => {
  expect(operations.some(op => op.name === 'get_evidence_context')).toBe(false);
});

test('injected SQL reader runs exact resolution and tied keysets in an isolated database', async () => {
  const db = new PGlite();
  try {
    await db.exec('CREATE TABLE source_records (source_type text, source_ref text, entity_type text, entity_id text, payload_json jsonb, updated_at timestamptz)');
    for (const ref of ['a', 'b', 'c', 'd']) {
      const payload = { sourceSystem: 'chat', channel: 'network', profileId: 'owner-a', chatId: 'thread',
        evidence: { body: `Original ${ref}`, complete: true }, metadata: { sensitivity: { level: 'business' } } };
      if (ref === 'c') { delete (payload as { chatId?: string }).chatId; Object.assign(payload.metadata, { threadId: 'thread' }); }
      if (ref === 'd') { delete (payload as { chatId?: string }).chatId; Object.assign(payload, { message: { conversationId: 'thread' } }); }
      await db.query('INSERT INTO source_records VALUES ($1,$2,$3,$2,$4::text::jsonb,$5::timestamptz)',
        ['comms_channel', ref, 'comms_channel_message', JSON.stringify(payload), '2026-01-01T12:00:00.123456Z']);
    }
    const reader = evidenceRecordReader(async (sql, values) => (await db.query(sql, values)).rows as never[]);
    const first = await assembleEvidenceContexts({ items: params.items, reader, sourceId: 'default', authorize: () => true, perItemLimit: 2 });
    expect(first.packets[0].evidence.map(e => e.reference.sourceRef)).toEqual(['a', 'b']);
    const second = await assembleEvidenceContexts({ items: [{ ...params.items[0], continuation: first.packets[0].continuation }], reader, sourceId: 'default', authorize: () => true, perItemLimit: 2 });
    expect(second.packets[0].evidence.map(e => e.reference.sourceRef)).toEqual(['a', 'c', 'd']);
    expect(second.packets[0].coverage.queryExhausted).toBe(true);
  } finally { await db.close(); }
});

test('missing intake schema becomes an explicit per-item reader failure without database details', async () => {
  const reader = evidenceRecordReader(async () => { throw new Error('relation source_records does not exist: private details'); });
  const result = await assembleEvidenceContexts({ items: params.items, sourceId: 'default', reader, authorize: () => true });
  expect(result.packets[0].gaps).toContain('reader_failed');
  expect(JSON.stringify(result)).not.toContain('private details');
});
