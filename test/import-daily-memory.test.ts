import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runImport, ImportAbortError } from '../src/commands/import.ts';
import { importFile } from '../src/core/import-file.ts';
import { createImportDailyMemory } from '../src/core/import-daily-memory.ts';
import { loadSyncFailures } from '../src/core/sync-failure-ledger.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine, version: string | null;
const roots: string[] = [];
const root = () => { const dir = mkdtempSync(join(tmpdir(), 'gbrain-import-day-')); roots.push(dir); return dir; };
const markdown = '---\ntype: note\ntitle: Synthetic fixture\ndate: "2026-09-24"\n---\n\nSynthetic fixture';
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); version = await engine.getConfig('version'); }, 60_000);
afterAll(async () => { await engine.disconnect(); for (const dir of roots) rmSync(dir, { recursive: true, force: true }); });
beforeEach(async () => { await resetPgliteState(engine); if (version) await engine.setConfig('version', version); });
const batches = () => engine.executeRaw<{ data: { daily_memory_dates: string[] } }>("SELECT data FROM minion_jobs WHERE name='autopilot-daily-memory' AND data ? 'daily_memory_dates'");


const expireLiveLeases = async () => {
  const lives = await engine.executeRaw<{ path: string }>(
    "SELECT path FROM op_checkpoint_paths WHERE op='import-daily-memory' AND path::jsonb->>'value' LIKE 'live:%'");
  let i = 0;
  for (const row of lives) {
    const wrapped = JSON.parse(row.path) as { origin: string; value: string };
    // Unique stale stamps so PK (op, fingerprint, path) cannot collide across origins.
    wrapped.value = `live:${new Date(Date.now() - (31 * 60 * 1000) - i).toISOString()}`;
    i += 1;
    await engine.executeRawDirect(
      'UPDATE op_checkpoint_paths SET path=$1 WHERE op=$2 AND path=$3',
      [JSON.stringify(wrapped), 'import-daily-memory', row.path]);
  }
};


test('post-import discovery failure banks slugs and withholds bookmark through a checkpoint-skipped retry', async () => {
  const dir = root(), home = root(); writeFileSync(join(dir, 'note.md'), markdown);
  for (const args of [['init'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture']]) {
    execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  }
  await engine.setConfig('sync.repo_path', dir); await engine.setConfig('sync.last_commit', 'before');
  let discoveries = 0;
  const execute = engine.executeRaw;
  const failure = spyOn(engine, 'executeRaw').mockImplementation(async function<T>(this: PGLiteEngine, sql: string, params?: unknown[]): Promise<T[]> {
    if (sql.includes('SELECT source_id, slug, title, effective_date') && ++discoveries === 2) throw new Error('Synthetic day discovery outage');
    return execute.call(this, sql, params) as Promise<T[]>;
  });
  try {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const result = await runImport(engine, [dir, '--no-embed', '--json', '--workers', '1'], { noExtract: true });
      expect(result.imported).toBe(1); expect(result.errors).toBe(1);
      expect(result.failures.some(f => f.path === '<daily-memory-refresh>')).toBe(true);
      expect(loadSyncFailures().some(f => f.path === '<daily-memory-refresh>' && f.state === 'open')).toBe(true);
    });
  } finally { failure.mockRestore(); }
  expect(await engine.getConfig('sync.last_commit')).toBe('before');
  expect(await engine.executeRaw("SELECT path FROM op_checkpoint_paths WHERE op='import-daily-memory' AND path::jsonb->>'value'='slug:note'")).toHaveLength(1);
  await withEnv({ GBRAIN_HOME: home }, async () => {
    const retried = await runImport(engine, [dir, '--no-embed', '--json', '--workers', '1'], { noExtract: true });
    expect(retried.imported).toBe(0); expect(retried.errors).toBe(0);
    expect(loadSyncFailures().filter(f => f.path === '<daily-memory-refresh>')).toEqual([]);
  });
  expect((await batches()).some(row => row.data.daily_memory_dates.includes('2026-09-24'))).toBe(true);
  expect(await engine.getConfig('sync.last_commit')).toBe(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim());
  expect(await engine.executeRaw("SELECT op FROM op_checkpoints WHERE op='import-daily-memory'")).toHaveLength(0);
});

test('pre-write bank recovers old undated day after interruption before post-write accounting and hash skip', async () => {
  const dir = root(), file = join(dir, 'note.md'); writeFileSync(file, markdown);
  await engine.putPage('note', { type: 'note', title: 'Prior fixture', compiled_truth: 'Before', frontmatter: {}, source_path: 'note.md' });
  await engine.executeRaw("UPDATE pages SET effective_date=NULL,effective_date_source=NULL,updated_at='2026-09-23T12:00:00Z'::timestamptz WHERE slug='note'");
  const opts = { sourceId: 'default', dir };
  const prior = (await createImportDailyMemory(engine, opts))!;
  await prior.before(file, 'note.md');
  expect((await importFile(engine, file, 'note.md', { noEmbed: true })).status).toBe('imported');
  // Simulate process loss after the canonical write, before imported() and file checkpoint.
  expect((await importFile(engine, file, 'note.md', { noEmbed: true })).status).toBe('skipped');
  // Process-loss recovery: adopting finish only retires foreign debt after live lease expiry.
  await expireLiveLeases();
  await (await createImportDailyMemory(engine, opts))!.finish();
  expect((await batches()).some(row => row.data.daily_memory_dates.includes('2026-09-23')
    && row.data.daily_memory_dates.includes('2026-09-24'))).toBe(true);
});

test('rejected daily handoff survives an unchanged retry and healthy no-op creates no jobs', async () => {
  const dir = root(), home = root(); writeFileSync(join(dir, 'note.md'), markdown);
  const add = MinionQueue.prototype.add;
  const failure = spyOn(MinionQueue.prototype, 'add').mockImplementation(async function(this: MinionQueue, name, data, opts) {
    if (name === 'autopilot-daily-memory') throw new Error('Synthetic daily handoff rejection');
    return add.call(this, name, data, opts);
  });
  try { await withEnv({ GBRAIN_HOME: home }, async () => {
    expect((await runImport(engine, [dir, '--no-embed', '--json'], { noExtract: true })).errors).toBe(1);
  }); } finally { failure.mockRestore(); }
  await withEnv({ GBRAIN_HOME: home }, async () => {
    expect((await runImport(engine, [dir, '--no-embed', '--json'], { noExtract: true })).errors).toBe(0);
    const accepted = await engine.executeRaw('SELECT id FROM minion_jobs ORDER BY id');
    expect((await runImport(engine, [dir, '--no-embed', '--json'], { noExtract: true })).imported).toBe(0);
    expect(await engine.executeRaw('SELECT id FROM minion_jobs ORDER BY id')).toEqual(accepted);
  });
});


test('pre-write date discovery failure leaves the canonical page and bookmark untouched', async () => {
  const dir = root(), home = root(); writeFileSync(join(dir, 'note.md'), markdown);
  await engine.setConfig('sync.last_commit', 'before');
  const execute = engine.executeRaw;
  const failure = spyOn(engine, 'executeRaw').mockImplementation(async function<T>(this: PGLiteEngine, sql: string, params?: unknown[]): Promise<T[]> {
    if (sql.includes('SELECT source_id, slug, title, effective_date')) throw new Error('Synthetic prior-date discovery outage');
    return execute.call(this, sql, params) as Promise<T[]>;
  });
  try { await withEnv({ GBRAIN_HOME: home }, async () => {
    const result = await runImport(engine, [dir, '--no-embed', '--json'], { noExtract: true });
    expect(result.imported).toBe(0); expect(result.errors).toBeGreaterThan(0);
  }); } finally { failure.mockRestore(); }
  expect(await engine.getPage('note')).toBeNull();
  expect(await engine.getConfig('sync.last_commit')).toBe('before');
  expect(await batches()).toHaveLength(0);
});

test('managed bookmark imports leave daily handoff to the outer sync transaction', async () => {
  const dir = root(), home = root(); writeFileSync(join(dir, 'note.md'), markdown);
  await withEnv({ GBRAIN_HOME: home }, async () => {
    expect((await runImport(engine, [dir, '--no-embed', '--json'], { noExtract: true, managedBookmark: true })).imported).toBe(1);
  });
  expect(await engine.getPage('note')).not.toBeNull();
  expect(await batches()).toHaveLength(0);
  expect(await engine.executeRaw("SELECT op FROM op_checkpoints WHERE op='import-daily-memory'")).toHaveLength(0);
});

test('oversized markdown skips body parse during prior-slug discovery', async () => {
  const dir = root(), file = join(dir, 'note.md');
  // Larger than MAX_FILE_SIZE (5MB) so before() must not read/parse the body.
  writeFileSync(file, `${'x'.repeat(5_000_001)}`);
  await engine.putPage('note', { type: 'note', title: 'Prior fixture', compiled_truth: 'Before', frontmatter: {}, source_path: 'note.md' });
  await engine.executeRaw("UPDATE pages SET effective_date='2026-09-20T00:00:00Z'::timestamptz,effective_date_source='date' WHERE slug='note'");
  const prior = (await createImportDailyMemory(engine, { sourceId: 'default', dir }))!;
  await prior.before(file, 'note.md');
  const saved = await engine.executeRaw<{ path: string }>("SELECT path FROM op_checkpoint_paths WHERE op='import-daily-memory' AND path::jsonb->>'value' LIKE 'before:%'");
  expect(JSON.parse(JSON.parse(saved[0]!.path).value.slice(7)).days).toContain('2026-09-20');
  await prior.finish();
  expect(await batches()).toHaveLength(0);
});


test('prior-date discovery skips dangling symlink bodies and leaves canonical identity unchanged', async () => {
  const dir = root(), file = join(dir, 'note.md');
  await engine.putPage('note', { type: 'note', title: 'Canonical fixture', compiled_truth: 'Synthetic existing page', frontmatter: { date: '2026-09-20' } });
  const before = await engine.readPageSnapshot('note', { sourceId: 'default' });
  symlinkSync(join(dir, 'missing-target.md'), file);
  const daily = (await createImportDailyMemory(engine, { sourceId: 'default', dir }))!;
  await daily.before(file, 'note.md');
  await daily.finish();
  expect(await engine.readPageSnapshot('note', { sourceId: 'default' })).toEqual(before);
  expect(await batches()).toHaveLength(0);
});


test('finish retires only its snapshot and preserves a concurrent before: bank', async () => {
  const dir = root();
  const firstFile = join(dir, 'first.md');
  const secondFile = join(dir, 'second.md');
  writeFileSync(firstFile, '---\ntype: note\ntitle: First\ndate: "2026-09-24"\n---\n\nFirst');
  writeFileSync(secondFile, '---\ntype: note\ntitle: Second\ndate: "2026-09-25"\n---\n\nSecond');
  await engine.putPage('first', { type: 'note', title: 'First', compiled_truth: 'First', frontmatter: { date: '2026-09-24' }, source_path: 'first.md' });
  await engine.executeRaw("UPDATE pages SET effective_date=(frontmatter->>'date')::date::timestamptz,effective_date_source='date' WHERE source_id='default' AND slug='first'");
  await engine.putPage('second', { type: 'note', title: 'Second', compiled_truth: 'Second', frontmatter: { date: '2026-09-25' }, source_path: 'second.md' });
  await engine.executeRaw("UPDATE pages SET effective_date=(frontmatter->>'date')::date::timestamptz,effective_date_source='date' WHERE source_id='default' AND slug='second'");
  const opts = { sourceId: 'default', dir };
  const first = (await createImportDailyMemory(engine, opts))!;
  await first.before(firstFile, 'first.md');
  await first.imported('first');
  const peer = (await createImportDailyMemory(engine, opts))!;
  const direct = engine.executeRawDirect;
  let peerBanked = false;
  const spy = spyOn(engine, 'executeRawDirect').mockImplementation((async function (this: PGLiteEngine, sql: string, params?: unknown[]) {
    if (!peerBanked && sql.startsWith('DELETE FROM op_checkpoint_paths')) {
      peerBanked = true;
      await peer.before(secondFile, 'second.md');
    }
    return direct.call(this, sql, params);
  }) as typeof engine.executeRawDirect);
  try {
    await first.finish();
  } finally {
    spy.mockRestore();
  }
  expect(peerBanked).toBe(true);
  expect(await engine.executeRaw(
    "SELECT path FROM op_checkpoint_paths WHERE op='import-daily-memory' AND path::jsonb->>'value' LIKE 'before:%'")).toHaveLength(1);
  expect((await batches()).some(row => row.data.daily_memory_dates.includes('2026-09-24'))).toBe(true);
  await peer.imported('second');
  await peer.finish();
  expect((await batches()).some(row => row.data.daily_memory_dates.includes('2026-09-25'))).toBe(true);
  expect(await engine.executeRaw("SELECT op FROM op_checkpoints WHERE op='import-daily-memory'")).toHaveLength(0);
});

test('identical concurrent before: banks stay distinct by invocation origin', async () => {
  const dir = root();
  const file = join(dir, 'note.md');
  writeFileSync(file, markdown);
  await engine.putPage('note', { type: 'note', title: 'Synthetic fixture', compiled_truth: 'Synthetic fixture', frontmatter: { date: '2026-09-24' }, source_path: 'note.md' });
  await engine.executeRaw("UPDATE pages SET effective_date=(frontmatter->>'date')::date::timestamptz,effective_date_source='date' WHERE source_id='default' AND slug='note'");
  const opts = { sourceId: 'default', dir };
  const first = (await createImportDailyMemory(engine, opts))!;
  const peer = (await createImportDailyMemory(engine, opts))!;
  await first.before(file, 'note.md');
  await peer.before(file, 'note.md');
  expect(await engine.executeRaw(
    "SELECT path FROM op_checkpoint_paths WHERE op='import-daily-memory' AND path::jsonb->>'value' LIKE 'before:%'")).toHaveLength(2);
  await first.imported('note');
  await first.finish();
  // Peer origin-tagged before: remains; identical values no longer share one row.
  expect(await engine.executeRaw(
    "SELECT path FROM op_checkpoint_paths WHERE op='import-daily-memory' AND path::jsonb->>'value' LIKE 'before:%'")).toHaveLength(1);
  expect((await batches()).some(row => row.data.daily_memory_dates.includes('2026-09-24'))).toBe(true);
  await peer.imported('note');
  await peer.finish();
  expect(await engine.executeRaw("SELECT op FROM op_checkpoints WHERE op='import-daily-memory'")).toHaveLength(0);
});

test('empty finish preserves live foreign before: debt', async () => {
  const dir = root();
  const file = join(dir, 'note.md');
  writeFileSync(file, markdown);
  await engine.putPage('note', { type: 'note', title: 'Synthetic fixture', compiled_truth: 'Synthetic fixture', frontmatter: { date: '2026-09-24' }, source_path: 'note.md' });
  await engine.executeRaw("UPDATE pages SET effective_date=(frontmatter->>'date')::date::timestamptz,effective_date_source='date' WHERE source_id='default' AND slug='note'");
  const opts = { sourceId: 'default', dir };
  const peer = (await createImportDailyMemory(engine, opts))!;
  await peer.before(file, 'note.md');
  await (await createImportDailyMemory(engine, opts))!.finish();
  expect(await engine.executeRaw(
    "SELECT path FROM op_checkpoint_paths WHERE op='import-daily-memory' AND path::jsonb->>'value' LIKE 'before:%'")).toHaveLength(1);
  await peer.imported('note');
  await peer.finish();
  expect((await batches()).some(row => row.data.daily_memory_dates.includes('2026-09-24'))).toBe(true);
  expect(await engine.executeRaw("SELECT op FROM op_checkpoints WHERE op='import-daily-memory'")).toHaveLength(0);
});

test('empty finish adopts foreign debt after live lease expires', async () => {
  const dir = root();
  const file = join(dir, 'note.md');
  writeFileSync(file, markdown);
  await engine.putPage('note', { type: 'note', title: 'Prior fixture', compiled_truth: 'Before', frontmatter: {}, source_path: 'note.md' });
  await engine.executeRaw("UPDATE pages SET effective_date=NULL,effective_date_source=NULL,updated_at='2026-09-23T12:00:00Z'::timestamptz WHERE slug='note'");
  const opts = { sourceId: 'default', dir };
  const peer = (await createImportDailyMemory(engine, opts))!;
  await peer.before(file, 'note.md');
  expect((await importFile(engine, file, 'note.md', { noEmbed: true })).status).toBe('imported');
  await expireLiveLeases();
  await (await createImportDailyMemory(engine, opts))!.finish();
  expect((await batches()).some(row => row.data.daily_memory_dates.includes('2026-09-23')
    && row.data.daily_memory_dates.includes('2026-09-24'))).toBe(true);
  expect(await engine.executeRaw(
    "SELECT path FROM op_checkpoint_paths WHERE op='import-daily-memory' AND path::jsonb->>'value' LIKE 'before:%'")).toHaveLength(0);
});


test('renew refreshes the live lease stamp and finish still settles', async () => {
  const dir = root();
  const file = join(dir, 'note.md');
  writeFileSync(file, markdown);
  await engine.putPage('note', { type: 'note', title: 'Synthetic fixture', compiled_truth: 'Synthetic fixture', frontmatter: { date: '2026-09-24' }, source_path: 'note.md' });
  await engine.executeRaw("UPDATE pages SET effective_date=(frontmatter->>'date')::date::timestamptz,effective_date_source='date' WHERE source_id='default' AND slug='note'");
  const daily = (await createImportDailyMemory(engine, { sourceId: 'default', dir }))!;
  const before = await engine.executeRaw<{ path: string }>(
    "SELECT path FROM op_checkpoint_paths WHERE op='import-daily-memory' AND path::jsonb->>'value' LIKE 'live:%'");
  expect(before).toHaveLength(1);
  await daily.renew();
  const after = await engine.executeRaw<{ path: string }>(
    "SELECT path FROM op_checkpoint_paths WHERE op='import-daily-memory' AND path::jsonb->>'value' LIKE 'live:%'");
  expect(after).toHaveLength(1);
  expect(after[0]!.path).not.toBe(before[0]!.path);
  await daily.before(file, 'note.md');
  await daily.imported('note');
  await daily.finish();
  expect(await engine.executeRaw("SELECT op FROM op_checkpoints WHERE op='import-daily-memory'")).toHaveLength(0);
});

test('nonempty finish retires expired foreign before: debt', async () => {
  const dir = root();
  const file = join(dir, 'note.md');
  writeFileSync(file, markdown);
  await engine.putPage('note', { type: 'note', title: 'Synthetic fixture', compiled_truth: 'Synthetic fixture', frontmatter: { date: '2026-09-24' }, source_path: 'note.md' });
  await engine.executeRaw("UPDATE pages SET effective_date=(frontmatter->>'date')::date::timestamptz,effective_date_source='date' WHERE source_id='default' AND slug='note'");
  const opts = { sourceId: 'default', dir };
  const crashed = (await createImportDailyMemory(engine, opts))!;
  await crashed.before(file, 'note.md');
  await expireLiveLeases();
  const live = (await createImportDailyMemory(engine, opts))!;
  await live.before(file, 'note.md');
  await live.imported('note');
  await live.finish();
  expect(await engine.executeRaw(
    "SELECT path FROM op_checkpoint_paths WHERE op='import-daily-memory' AND path::jsonb->>'value' LIKE 'before:%'")).toHaveLength(0);
  expect(await engine.executeRaw("SELECT op FROM op_checkpoints WHERE op='import-daily-memory'")).toHaveLength(0);
});

test('future live lease is treated as abandoned', async () => {
  const dir = root();
  const file = join(dir, 'note.md');
  writeFileSync(file, markdown);
  await engine.putPage('note', { type: 'note', title: 'Prior fixture', compiled_truth: 'Before', frontmatter: {}, source_path: 'note.md' });
  await engine.executeRaw("UPDATE pages SET effective_date=NULL,effective_date_source=NULL,updated_at='2026-09-23T12:00:00Z'::timestamptz WHERE slug='note'");
  const opts = { sourceId: 'default', dir };
  const peer = (await createImportDailyMemory(engine, opts))!;
  await peer.before(file, 'note.md');
  const lives = await engine.executeRaw<{ path: string }>(
    "SELECT path FROM op_checkpoint_paths WHERE op='import-daily-memory' AND path::jsonb->>'value' LIKE 'live:%'");
  for (const row of lives) {
    const wrapped = JSON.parse(row.path) as { origin: string; value: string };
    wrapped.value = `live:${new Date(Date.now() + 60 * 60 * 1000).toISOString()}`;
    await engine.executeRawDirect(
      'UPDATE op_checkpoint_paths SET path=$1 WHERE op=$2 AND path=$3',
      [JSON.stringify(wrapped), 'import-daily-memory', row.path]);
  }
  expect((await importFile(engine, file, 'note.md', { noEmbed: true })).status).toBe('imported');
  await (await createImportDailyMemory(engine, opts))!.finish();
  expect((await batches()).some(row => row.data.daily_memory_dates.includes('2026-09-23')
    && row.data.daily_memory_dates.includes('2026-09-24'))).toBe(true);
});

test('concurrent renew keeps one live marker', async () => {
  const dir = root();
  const daily = (await createImportDailyMemory(engine, { sourceId: 'default', dir }))!;
  await Promise.all([daily.renew(), daily.renew(), daily.renew()]);
  expect(await engine.executeRaw(
    "SELECT path FROM op_checkpoint_paths WHERE op='import-daily-memory' AND path::jsonb->>'value' LIKE 'live:%'")).toHaveLength(1);
  await daily.release();
});

test('concurrent renewals leave one live lease', async () => {
  const dir = root();
  const daily = (await createImportDailyMemory(engine, { sourceId: 'default', dir }))!;
  await Promise.all([daily.renew(), daily.renew(), daily.renew(), daily.renew()]);
  expect(await engine.executeRaw(
    "SELECT path FROM op_checkpoint_paths WHERE op='import-daily-memory' AND path::jsonb->>'value' LIKE 'live:%'")).toHaveLength(1);
  await daily.finish();
  expect(await engine.executeRaw("SELECT op FROM op_checkpoints WHERE op='import-daily-memory'")).toHaveLength(0);
});

test('renew keeps live lease after cancellation stops admission', async () => {
  const dir = root();
  const file = join(dir, 'note.md');
  writeFileSync(file, markdown);
  await engine.putPage('note', { type: 'note', title: 'Prior fixture', compiled_truth: 'Before', frontmatter: {}, source_path: 'note.md' });
  await engine.executeRaw("UPDATE pages SET effective_date=NULL,effective_date_source=NULL,updated_at='2026-09-23T12:00:00Z'::timestamptz WHERE slug='note'");
  const controller = new AbortController();
  const daily = (await createImportDailyMemory(engine, { sourceId: 'default', dir, signal: controller.signal }))!;
  await daily.before(file, 'note.md');
  const before = await engine.executeRaw<{ path: string }>(
    "SELECT path FROM op_checkpoint_paths WHERE op='import-daily-memory' AND path::jsonb->>'value' LIKE 'live:%'");
  expect(before).toHaveLength(1);
  controller.abort();
  // Admission stopped; non-managed importFile has no signal. Renew must still refresh.
  await daily.renew();
  const after = await engine.executeRaw<{ path: string }>(
    "SELECT path FROM op_checkpoint_paths WHERE op='import-daily-memory' AND path::jsonb->>'value' LIKE 'live:%'");
  expect(after).toHaveLength(1);
  expect(after[0]!.path).not.toBe(before[0]!.path);
  // Empty peer must not retire before: debt while the cancelled origin stays live.
  await (await createImportDailyMemory(engine, { sourceId: 'default', dir }))!.finish();
  expect(await engine.executeRaw(
    "SELECT path FROM op_checkpoint_paths WHERE op='import-daily-memory' AND path::jsonb->>'value' LIKE 'before:%'")).toHaveLength(1);
  await daily.imported('note');
  await daily.release();
});

test('aborted import releases daily-memory live lease', async () => {
  const dir = root(), home = root();
  writeFileSync(join(dir, 'note.md'), markdown);
  const controller = new AbortController();
  const spy = spyOn(await import('../src/core/import-file.ts'), 'importFile').mockImplementation(async () => {
    controller.abort();
    return { status: 'imported' as const, slug: 'note', chunks: 1 };
  });
  try {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      await expect(runImport(engine, [dir, '--no-embed', '--json', '--workers', '1'], {
        noExtract: true, signal: controller.signal,
      })).rejects.toBeInstanceOf(ImportAbortError);
    });
  } finally { spy.mockRestore(); }
  expect(await engine.executeRaw(
    "SELECT path FROM op_checkpoint_paths WHERE op='import-daily-memory' AND path::jsonb->>'value' LIKE 'live:%'")).toHaveLength(0);
});

