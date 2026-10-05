import { test, expect } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { spawnSync } from 'node:child_process';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { evidenceContextOperations, evidenceRecordReader } from '../src/core/ops/evidence-context.ts';
import { assembleEvidenceContexts } from '../packages/evidence-context/index.mjs';

const operation = evidenceContextOperations.find(op => op.name === 'get_evidence_context')!;
const params = { source_id: 'default', accounts: [{ system: 'chat', network: 'network', accountKind: 'profile', account: 'owner-a' }], items: [{ id: 'item', references: [{ sourceType: 'comms_channel', sourceRef: 'a' }] }] };

test('the shared package runs its behavior suite under ordinary Node without Bun or engine imports', () => {
  const result = spawnSync('node', ['--test', 'packages/evidence-context/test/context.test.mjs'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('fail 0');
});

test('get_evidence_context denies remote, missing trust and page scopes before any SQL', async () => {
  let queries = 0;
  const base = { engine: { executeRaw: async () => { queries++; return []; } } };
  for (const remote of [true, undefined]) {
    await expect(operation.handler({ ...base, remote } as unknown as OperationContext, params)).rejects.toThrow('owner-local');
  }
  await expect(operation.handler({ ...base, remote: false, sourceId: 'team' } as unknown as OperationContext, params)).rejects.toThrow('page-source');
  expect(queries).toBe(0);
});

test('injected SQL reader runs exact resolution and tied keysets in an isolated database', async () => {
  const db = new PGlite();
  try {
    await db.exec('CREATE TABLE source_records (source_type text, source_ref text, entity_type text, entity_id text, payload_json jsonb, updated_at timestamptz)');
    for (const ref of ['a', 'b', 'c', 'd']) {
      const payload = { sourceSystem: 'chat', channel: 'network', profileId: 'owner-a', chatId: 'thread',
        evidence: { body: `Original ${ref}`, complete: true }, metadata: { sensitivity: { level: 'business' } } };
      await db.query('INSERT INTO source_records VALUES ($1,$2,$3,$2,$4::text::jsonb,$5::timestamptz)',
        ['comms_channel', ref, 'comms_channel_message', JSON.stringify(payload), '2026-01-01T12:00:00.123456Z']);
    }
    const reader = evidenceRecordReader(async (sql, values) => (await db.query(sql, values)).rows as never[]);
    const first = await assembleEvidenceContexts({ items: params.items, reader, sourceId: 'default', authorize: () => true, perItemLimit: 2 });
    expect(first.packets[0].evidence.map(e => e.reference.sourceRef)).toEqual(['a', 'b']);
    const second = await assembleEvidenceContexts({ items: [{ ...params.items[0], continuation: first.packets[0].continuation }], reader, sourceId: 'default', authorize: () => true, perItemLimit: 2 });
    expect(second.packets[0].evidence.map(e => e.reference.sourceRef)).toEqual(['a', 'c', 'd']);
    expect(second.packets[0].coverage.queryExhausted).toBe(true);
    const engine = { executeRaw: async (sql: string, values: unknown[]) => (await db.query(sql, values)).rows };
    const ctx = { engine, remote: false, sourceId: 'default' } as unknown as OperationContext;
    const allowed = await operation.handler(ctx, params) as typeof first;
    expect(allowed.packets[0].evidence.length).toBe(4);
    const denied = await operation.handler(ctx, { ...params, accounts: [{ ...params.accounts[0], account: 'other' }] }) as typeof first;
    expect(denied.packets[0].evidence).toEqual([]);
    for (const field of ['system', 'network', 'accountKind']) {
      const crossScope = await operation.handler(ctx, { ...params, accounts: [{ ...params.accounts[0], [field]: 'unrelated' }] }) as typeof first;
      expect(crossScope.packets[0].evidence).toEqual([]);
    }
  } finally { await db.close(); }
});

test('missing intake schema becomes an explicit per-item reader failure without database details', async () => {
  const ctx = { remote: false, sourceId: 'default', engine: { executeRaw: async () => { throw new Error('relation source_records does not exist: private details'); } } } as unknown as OperationContext;
  const result = await operation.handler(ctx, params) as { packets: { gaps: string[] }[] };
  expect(result.packets[0].gaps).toContain('reader_failed');
  expect(JSON.stringify(result)).not.toContain('private details');
});
