import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, mkdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runImport, ImportAbortError } from '../src/commands/import.ts';
import { importFile, importImageFile, importCodeFile } from '../src/core/import-file.ts';
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
  let committed = false;
  const module = await import('../src/core/import-file.ts'), actualImport = module.importFile;
  const importer = spyOn(module, 'importFile').mockImplementation(async (...args) => {
    const result = await actualImport(...args);
    committed = result.status === 'imported';
    return result;
  });
  const execute = engine.executeRaw;
  const failure = spyOn(engine, 'executeRaw').mockImplementation(async function<T>(this: PGLiteEngine, sql: string, params?: unknown[]): Promise<T[]> {
    if (committed && sql.includes('SELECT source_id, slug, title, effective_date')) throw new Error('Synthetic day discovery outage');
    return execute.call(this, sql, params) as Promise<T[]>;
  });
  try {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const result = await runImport(engine, [dir, '--no-embed', '--json', '--workers', '1'], { noExtract: true });
      expect(result.imported).toBe(1); expect(result.errors).toBe(1);
      expect(result.failures.some(f => f.path === '<daily-memory-refresh>')).toBe(true);
      expect(loadSyncFailures().some(f => f.path === '<daily-memory-refresh>' && f.state === 'open')).toBe(true);
    });
  } finally { failure.mockRestore(); importer.mockRestore(); }
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


for (const proof of ['checkpoint lease', 'committed accounting', 'renewal failure accounting'] as const) {
  test(`cancelled in-flight import preserves ${proof} through renewal and settlement`, async () => {
    const dir = root(), home = root(), file = join(dir, 'note.md');
    writeFileSync(file, markdown);
    await engine.putPage('note', { type: 'note', title: 'Prior fixture', compiled_truth: 'Before', frontmatter: {}, source_path: 'note.md' });
    await engine.executeRaw("UPDATE pages SET effective_date=NULL,effective_date_source=NULL,updated_at='2026-09-23T12:00:00Z'::timestamptz WHERE slug='note'");
    const controller = new AbortController();
    let enter!: () => void, settle!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const deferred = new Promise<void>(resolve => { settle = resolve; });
    const callbacks: Array<() => void> = [];
    const originalInterval = globalThis.setInterval;
    const timers = spyOn(globalThis, 'setInterval').mockImplementation(((callback: (...args: unknown[]) => void, delay: number, ...args: unknown[]) => {
      if (delay === 10 * 60_000) callbacks.push(() => callback(...args));
      return originalInterval(callback, delay, ...args);
    }) as typeof setInterval);
    const module = await import('../src/core/import-file.ts');
    const importer = spyOn(module, 'importFile').mockImplementation(async () => {
      enter(); await deferred;
      // Model an already admitted database write settling despite caller abort.
      await engine.executeRaw("UPDATE pages SET frontmatter=$1::jsonb,effective_date='2026-09-24T00:00:00Z'::timestamptz,effective_date_source='date',compiled_truth='After',updated_at=now() WHERE slug='note' AND source_id='default'", [JSON.stringify({ date: '2026-09-24' })]);
      return { status: 'imported' as const, slug: 'note', chunks: 1 };
    });
    const renewalFailure = new Error('Synthetic renewal storage failure');
    let renewal: Promise<void> | undefined;
    const dailyModule = await import('../src/core/import-daily-memory.ts');
    const originalDaily = dailyModule.createImportDailyMemory;
    const dailySpy = spyOn(dailyModule, 'createImportDailyMemory').mockImplementation(async (eng, opts) => {
      const daily = await originalDaily(eng, opts);
      if (daily && opts.signal) {
        const renew = daily.renew.bind(daily);
        daily.renew = () => {
          renewal = proof === 'renewal failure accounting' ? Promise.reject(renewalFailure) : renew();
          return renewal;
        };
      }
      return daily;
    });
    const run = withEnv({ GBRAIN_HOME: home }, () => runImport(engine, [dir, '--no-embed', '--json', '--workers', '1'], {
      noExtract: true, signal: controller.signal,
    })).then(value => value, error => error);
    let retainedBefore = 0;
    try {
      await entered;
      controller.abort();
      // Advance the persisted lease beyond TTL while the unsignaled file write
      // remains deferred, then fire its existing ten-minute renewal callback.
      await expireLiveLeases();
      expect(callbacks).toHaveLength(1);
      callbacks[0]!();
      expect(renewal).toBeDefined();
      await renewal!.catch(() => undefined);
      if (proof === 'renewal failure accounting') {
        settle();
        expect(await run).toBe(renewalFailure);
        const { readFileSync, existsSync } = await import('node:fs');
        const checkpointPath = join(home, '.gbrain', 'import-checkpoint.json');
        const checkpoint = existsSync(checkpointPath) ? JSON.parse(readFileSync(checkpointPath, 'utf8')) : { completedPaths: [] };
        expect(checkpoint.completedPaths).toEqual(['note.md']);
        expect((await engine.executeRaw<{ date: string }>("SELECT frontmatter->>'date' AS date FROM pages WHERE source_id='default' AND slug='note'"))[0]!.date).toBe('2026-09-24');
        return;
      }

      await (await createImportDailyMemory(engine, { sourceId: 'default', dir }))!.finish();
      retainedBefore = (await engine.executeRaw("SELECT path FROM op_checkpoint_paths WHERE op='import-daily-memory' AND path::jsonb->>'value' LIKE 'before:%'")).length;
      if (proof === 'checkpoint lease') expect(retainedBefore).toBe(1);
      settle();
      const result = await run;
      expect(result).toBeInstanceOf(ImportAbortError);
      expect((result as ImportAbortError).partialResult?.imported).toBe(1);
      expect(retainedBefore).toBe(1);
      await (await createImportDailyMemory(engine, { sourceId: 'default', dir }))!.finish();
      expect((await batches()).some(row => row.data.daily_memory_dates.includes('2026-09-23')
        && row.data.daily_memory_dates.includes('2026-09-24'))).toBe(true);
      expect(await engine.executeRaw("SELECT path FROM op_checkpoint_paths WHERE op='import-daily-memory' AND path::jsonb->>'value' LIKE 'live:%'")).toHaveLength(0);
    } finally {
      settle(); await run;
      importer.mockRestore(); timers.mockRestore(); dailySpy.mockRestore();
    }
  });
}


const syntheticPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

test('runImport cancellation after a real commit recovers adopted old-day debt and partial progress', async () => {
  const dir = root(), home = root(), file = join(dir,'note.md'); writeFileSync(file,markdown);
  await engine.putPage('note',{type:'note',title:'Prior synthetic fixture',compiled_truth:'Before',frontmatter:{},source_path:'note.md'});
  await engine.executeRaw("UPDATE pages SET effective_date=NULL,effective_date_source=NULL,updated_at='2026-09-23T12:00:00Z'::timestamptz WHERE slug='note'");
  const controller = new AbortController();
  const module = await import('../src/core/import-file.ts'), actualImport = module.importFile;
  const importer = spyOn(module,'importFile').mockImplementation(async (...args) => {
    // The command has admitted this file and banked its pre-write snapshot.
    await expireLiveLeases();
    await (await createImportDailyMemory(engine,{sourceId:'default',dir}))!.finish();
    expect(await engine.executeRaw("SELECT path FROM op_checkpoint_paths WHERE op='import-daily-memory' AND path::jsonb->>'value' LIKE 'before:%'")).toHaveLength(0);
    const result = await actualImport(...args);
    expect(result.status).toBe('imported');
    controller.abort();
    return result;
  });
  try {
    const error = await withEnv({GBRAIN_HOME:home},() => runImport(engine,[dir,'--no-embed','--json','--workers','1'],{
      noExtract:true,signal:controller.signal,
    })).then(() => null,error => error);
    expect(error).toBeInstanceOf(ImportAbortError);
    expect((error as ImportAbortError).partialResult?.imported).toBe(1);
  } finally {importer.mockRestore();}
  expect((await engine.getPage('note'))!.frontmatter.date).toBe('2026-09-24');
  expect(await engine.executeRaw("SELECT path FROM op_checkpoint_paths WHERE op='import-daily-memory' AND path::jsonb->>'value' LIKE 'live:%'")).toHaveLength(0);
  await (await createImportDailyMemory(engine,{sourceId:'default',dir}))!.finish();
  expect((await batches()).some(row => row.data.daily_memory_dates.includes('2026-09-23')
    && row.data.daily_memory_dates.includes('2026-09-24'))).toBe(true);
});

for (const kind of ['markdown', 'code', 'image'] as const) {
  test(`${kind} commit restores adopted prior-day debt before post-commit accounting`, async () => {
    const dir = root();
    const relativePath = kind === 'markdown' ? 'note.md' : kind === 'code' ? 'src/example.ts' : 'images/example.png';
    const slug = kind === 'markdown' ? 'note' : relativePath;
    const file = join(dir, relativePath); mkdirSync(join(file, '..'), {recursive:true});
    writeFileSync(file, kind === 'markdown' ? markdown : kind === 'code' ? 'export const syntheticValue = 42;\n' : syntheticPng);
    await engine.putPage(slug, {type:kind === 'markdown' ? 'note' : kind, title:'Prior synthetic fixture', compiled_truth:'Before', frontmatter:{}, source_path:relativePath});
    await engine.executeRaw("UPDATE pages SET effective_date=NULL,effective_date_source=NULL,updated_at='2026-09-23T12:00:00Z'::timestamptz WHERE slug=$1",[slug]);
    const opts = {sourceId:'default',dir};
    const owner = (await createImportDailyMemory(engine,opts))!;
    const beforeCommit = await owner.before(file,relativePath);
    await expireLiveLeases();
    await (await createImportDailyMemory(engine,opts))!.finish();
    expect(await engine.executeRaw("SELECT path FROM op_checkpoint_paths WHERE op='import-daily-memory' AND path::jsonb->>'value' LIKE 'before:%'")).toHaveLength(0);
    const result = kind === 'image'
      ? await importImageFile(engine,file,relativePath,{noEmbed:true,beforeCommit})
      : await importFile(engine,file,relativePath,{noEmbed:true,beforeCommit});
    expect(result.status).toBe('imported');
    // Simulate loss immediately after canonical commit: no imported() call.
    await owner.release();
    await (await createImportDailyMemory(engine,opts))!.finish();
    const newDays = await (await import('../src/core/cycle/daily-memory-followup.ts')).dailyMemoryDaysForSlugs(engine,'default',[slug]);
    expect((await batches()).some(row => row.data.daily_memory_dates.includes('2026-09-23')
      && newDays.every(day => row.data.daily_memory_dates.includes(day)))).toBe(true);
  });

  test(`${kind} rejected commit hook rolls back page, projections and debt together`, async () => {
    const dir=root(),relativePath=kind==='markdown'?'note.md':kind==='code'?'src/example.ts':'images/example.png';
    const slug=kind==='markdown'?'note':relativePath,file=join(dir,relativePath);
    mkdirSync(join(file,'..'),{recursive:true});
    writeFileSync(file,kind==='markdown'?markdown:kind==='code'?'export const syntheticValue = 42;\n':syntheticPng);
    const owner=(await createImportDailyMemory(engine,{sourceId:'default',dir}))!;
    const bank=await owner.before(file,relativePath);
    const beforeCommit=async (tx: import('../src/core/engine.ts').BrainEngine,actualSlug:string) => {
      await bank?.(tx,actualSlug);
      throw new Error('Synthetic post-bank commit rejection');
    };
    const write=kind==='image'?importImageFile(engine,file,relativePath,{noEmbed:true,beforeCommit})
      :importFile(engine,file,relativePath,{noEmbed:true,beforeCommit});
    await expect(write).rejects.toThrow('Synthetic post-bank commit rejection');
    expect(await engine.getPage(slug,{sourceId:'default'})).toBeNull();
    expect(await engine.executeRaw('SELECT id FROM content_chunks')).toHaveLength(0);
    expect(await engine.executeRaw("SELECT path FROM op_checkpoint_paths WHERE op='import-daily-memory' AND path::jsonb->>'value' LIKE 'slug:%'")).toHaveLength(0);
    await owner.release();
  });
}

test('identity rename restores original slug day atomically after expired-peer adoption',async () => {
  const dir=root(),oldFile=join(dir,'old.md'),file=join(dir,'new.md');
  const content='---\ntype: note\ntitle: Synthetic moved fixture\nid: synthetic-stable-id\n---\n\nUnchanged synthetic body';
  writeFileSync(oldFile,content);
  await importFile(engine,oldFile,'old.md',{noEmbed:true,inferFrontmatter:false});
  await engine.executeRaw("UPDATE pages SET effective_date=NULL,effective_date_source=NULL,updated_at='2026-09-23T12:00:00Z'::timestamptz WHERE slug='old'");
  renameSync(oldFile,file);
  const opts={sourceId:'default',dir}; const owner=(await createImportDailyMemory(engine,opts))!;
  const beforeCommit=await owner.before(file,'new.md');
  await expireLiveLeases(); await (await createImportDailyMemory(engine,opts))!.finish();
  await importFile(engine,file,'new.md',{noEmbed:true,inferFrontmatter:false,beforeCommit});
  expect(await engine.getPage('old',{sourceId:'default'})).toBeNull();
  expect(await engine.getPage('new',{sourceId:'default'})).not.toBeNull();
  await owner.release(); await (await createImportDailyMemory(engine,opts))!.finish();
  expect((await batches()).some(row=>row.data.daily_memory_dates.includes('2026-09-23'))).toBe(true);
});

test('peer retirement paused across a page commit cannot erase the new mutation bank',async () => {
  const dir=root(),file=join(dir,'note.md');writeFileSync(file,markdown);
  await engine.putPage('note',{type:'note',title:'Prior synthetic fixture',compiled_truth:'Before',frontmatter:{},source_path:'note.md'});
  await engine.executeRaw("UPDATE pages SET effective_date=NULL,effective_date_source=NULL,updated_at='2026-09-23T12:00:00Z'::timestamptz WHERE slug='note'");
  const opts={sourceId:'default',dir},owner=(await createImportDailyMemory(engine,opts))!;
  const beforeCommit=await owner.before(file,'note.md'); await expireLiveLeases();
  const peer=(await createImportDailyMemory(engine,opts))!;
  let announce=()=>{},resume=()=>{};
  const paused=new Promise<void>(resolve=>{announce=resolve;});
  const released=new Promise<void>(resolve=>{resume=resolve;});
  const direct=engine.executeRawDirect;let intercepted=false;
  const retire=spyOn(engine,'executeRawDirect').mockImplementation(async function<T>(this:PGLiteEngine,sql:string,params?:unknown[],rawOpts?:{signal?:AbortSignal}):Promise<T[]> {
    if (!intercepted && sql.startsWith('DELETE FROM op_checkpoint_paths') && sql.includes('path=ANY')) {
      intercepted=true;announce();await released;
    }
    return direct.call(this,sql,params,rawOpts) as Promise<T[]>;
  });
  const finishing=peer.finish();
  try {
    await Promise.race([paused,finishing.then(()=>{throw new Error('Peer never reached retirement pause');})]);
    expect((await importFile(engine,file,'note.md',{noEmbed:true,beforeCommit})).status).toBe('imported');
  } finally {resume();try {await finishing;} finally {retire.mockRestore();}}
  const remaining=await engine.executeRaw<{path:string}>("SELECT path FROM op_checkpoint_paths WHERE op='import-daily-memory' AND path::jsonb->>'value' LIKE 'before:%'");
  expect(remaining).toHaveLength(1);
  expect(JSON.parse(JSON.parse(remaining[0]!.path).value.slice('before:'.length)).bankId).toEqual(expect.any(String));
  await owner.release();await (await createImportDailyMemory(engine,opts))!.finish();
  expect((await batches()).some(row=>row.data.daily_memory_dates.includes('2026-09-23')
    && row.data.daily_memory_dates.includes('2026-09-24'))).toBe(true);
});

test('same-revision date mutation survives stale slug retirement and later page deletion', async () => {
  const dir = root(), file = join(dir, 'note.md'); writeFileSync(file, 'Synthetic undated fixture');
  await engine.putPage('note', {type:'note', title:'Synthetic undated fixture', compiled_truth:'Before', frontmatter:{}, source_path:'note.md'});
  await engine.executeRaw("UPDATE pages SET effective_date=NULL,effective_date_source=NULL,updated_at='2026-09-23T12:00:00Z'::timestamptz WHERE slug='note'");
  const revision = (await engine.getPage('note'))!.knowledge_revision;
  const opts = {sourceId:'default',dir}, owner = (await createImportDailyMemory(engine,opts))!;
  const beforeCommit = await owner.before(file,'note.md');
  // A previous accepted write has already banked this exact origin/slug marker.
  await owner.imported('note'); await expireLiveLeases();
  const peer = (await createImportDailyMemory(engine,opts))!;
  let announce = () => {}, resume = () => {};
  const paused = new Promise<void>(resolve => { announce=resolve; });
  const released = new Promise<void>(resolve => { resume=resolve; });
  const direct = engine.executeRawDirect; let intercepted = false;
  const retire = spyOn(engine,'executeRawDirect').mockImplementation(async function<T>(this:PGLiteEngine,sql:string,params?:unknown[],rawOpts?:{signal?:AbortSignal}):Promise<T[]> {
    if (!intercepted && sql.startsWith('DELETE FROM op_checkpoint_paths') && sql.includes('path=ANY')) {
      intercepted=true; announce(); await released;
    }
    return direct.call(this,sql,params,rawOpts) as Promise<T[]>;
  });
  const finishing = peer.finish();
  try {
    await Promise.race([paused,finishing.then(() => {throw new Error('Peer never reached retirement pause');})]);
    await engine.transaction(async tx => {
      await tx.executeRaw("UPDATE pages SET updated_at='2026-09-24T12:00:00Z'::timestamptz WHERE source_id='default' AND slug='note'");
      await beforeCommit?.(tx,'note');
    });
    expect((await engine.getPage('note'))!.knowledge_revision).toBe(revision);
  } finally {resume(); try {await finishing;} finally {retire.mockRestore();}}
  expect(await engine.executeRaw("SELECT path FROM op_checkpoint_paths WHERE op='import-daily-memory' AND path::jsonb->>'value'='slug:note'")).toHaveLength(0);
  const remaining = await engine.executeRaw<{path:string}>("SELECT path FROM op_checkpoint_paths WHERE op='import-daily-memory' AND path::jsonb->>'value' LIKE 'before:%'");
  expect(remaining).toHaveLength(1);
  const mutation = JSON.parse(JSON.parse(remaining[0]!.path).value.slice('before:'.length));
  expect(mutation.bankId).toEqual(expect.any(String));
  expect(mutation.days).toEqual(expect.arrayContaining(['2026-09-23','2026-09-24']));
  // Recovery cannot rediscover either date from the canonical row now.
  await engine.executeRaw("DELETE FROM pages WHERE source_id='default' AND slug='note'");
  await owner.release(); await (await createImportDailyMemory(engine,opts))!.finish();
  expect((await batches()).some(row => row.data.daily_memory_dates.includes('2026-09-23')
    && row.data.daily_memory_dates.includes('2026-09-24'))).toBe(true);
});


test('renew and release skip legacy unwrapped import checkpoint rows without JSON cast errors', async () => {
  const { createHash } = await import('node:crypto');
  const dir = root();
  const fingerprint = createHash('sha256').update(JSON.stringify(['default', dir])).digest('hex').slice(0, 16);
  const legacyBefore = 'before:' + JSON.stringify({
    targets: [{ slug: 'notes/legacy-import-unwrapped', revision: null }],
    days: ['2026-01-09'],
  });
  await engine.executeRawDirect(
    `INSERT INTO op_checkpoints (op, fingerprint, completed_keys, updated_at)
     VALUES ('import-daily-memory', $1, $2::jsonb, now())
     ON CONFLICT (op, fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys, updated_at=now()`,
    [fingerprint, JSON.stringify([legacyBefore, 'slug:notes/legacy-import-unwrapped', 'day:2026-01-09'])]);
  await engine.executeRawDirect(
    `INSERT INTO op_checkpoint_paths (op, fingerprint, path) VALUES
       ('import-daily-memory', $1, $2),
       ('import-daily-memory', $1, 'slug:notes/legacy-import-unwrapped'),
       ('import-daily-memory', $1, 'day:2026-01-09')
     ON CONFLICT DO NOTHING`,
    [fingerprint, legacyBefore]);
  await engine.putPage('notes/legacy-import-unwrapped', {
    type: 'note', title: 'Legacy', compiled_truth: 'Synthetic fixture', frontmatter: { date: '2026-01-09' },
  });
  await engine.executeRaw(
    "UPDATE pages SET effective_date=$1::date::timestamptz,effective_date_source='date' WHERE slug=$2 AND source_id='default'",
    ['2026-01-09', 'notes/legacy-import-unwrapped']);
  // createImportDailyMemory calls touchLive(); unguarded casts used to abort here.
  const live = (await createImportDailyMemory(engine, { sourceId: 'default', dir }))!;
  await expect(live.renew()).resolves.toBeUndefined();
  await expect(live.release()).resolves.toBeUndefined();
  const [retainedLegacy] = await engine.executeRaw<{ completed_keys: string[] }>(
    "SELECT completed_keys FROM op_checkpoints WHERE op='import-daily-memory' AND fingerprint=$1", [fingerprint]);
  expect(retainedLegacy!.completed_keys).toContain(legacyBefore);
  expect(retainedLegacy!.completed_keys).toContain('slug:notes/legacy-import-unwrapped');
  expect(retainedLegacy!.completed_keys).toContain('day:2026-01-09');
  const recovery = (await createImportDailyMemory(engine, { sourceId: 'default', dir }))!;
  await recovery.finish();
  expect(await engine.executeRaw(
    "SELECT path FROM op_checkpoint_paths WHERE op='import-daily-memory' AND fingerprint=$1",
    [fingerprint])).toHaveLength(0);
  expect((await batches()).some(row => row.data.daily_memory_dates.includes('2026-01-09'))).toBe(true);
});

test('unchanged CODE projection repair rejects its commit hook and rolls back the seal', async () => {
  const dir = root(), relativePath = 'src/example.ts', file = join(dir,relativePath);
  const content = 'export function syntheticValue() { return 42; }\n';
  mkdirSync(join(file,'..'),{recursive:true}); writeFileSync(file,content);
  const {slug} = await importCodeFile(engine,relativePath,content,{noEmbed:true});
  await engine.executeRaw('UPDATE pages SET text_projection_revision=NULL WHERE source_id=$1 AND slug=$2',['default',slug]);
  const before = (await engine.getPage(slug))!;
  const chunks = await engine.executeRaw('SELECT * FROM content_chunks ORDER BY id');
  const owner = (await createImportDailyMemory(engine,{sourceId:'default',dir}))!;
  const bank = await owner.before(file,relativePath);
  const debt = await engine.executeRaw('SELECT path FROM op_checkpoint_paths ORDER BY path');
  let called = false;
  await expect(importFile(engine,file,relativePath,{noEmbed:true,beforeCommit:async (tx,actualSlug) => {
    called=true;
    expect((await tx.getPage(actualSlug))!.text_projection_revision).toBe(before.knowledge_revision);
    await bank?.(tx,actualSlug);
    throw new Error('Synthetic projection hook rejection');
  }})).rejects.toThrow('Synthetic projection hook rejection');
  expect(called).toBe(true);
  const after = (await engine.getPage(slug))!;
  expect(after.text_projection_revision).toBeNull();
  expect(after.knowledge_revision).toBe(before.knowledge_revision);
  expect(after.content_hash).toBe(before.content_hash);
  expect(await engine.executeRaw('SELECT * FROM content_chunks ORDER BY id')).toEqual(chunks);
  expect(await engine.executeRaw('SELECT path FROM op_checkpoint_paths ORDER BY path')).toEqual(debt);
  await owner.release();
});

test('pins one timezone across import finish discovery and enqueue after cycle.timezone flips', async () => {
  await engine.setConfig('cycle.timezone', 'Asia/Manila');
  const dir = root();
  mkdirSync(join(dir, 'notes'), { recursive: true });
  const relativePath = 'notes/import-tz-pin.md';
  const file = join(dir, relativePath);
  writeFileSync(file, `---\ntype: note\ntitle: Synthetic tz pin\ndate: "2026-09-30T16:30:00Z"\n---\n\nSynthetic fixture`);
  const owner = (await createImportDailyMemory(engine, { sourceId: 'default', dir, commit: 'import-tz-pin' }))!;
  const bank = await owner.before(file, relativePath);
  await importFile(engine, file, relativePath, {
    noEmbed: true,
    beforeCommit: async (tx, actualSlug) => { await bank?.(tx, actualSlug); },
  });
  await owner.imported('notes/import-tz-pin');
  await engine.setConfig('cycle.timezone', 'America/Los_Angeles');
  await owner.finish();
  const queued = await engine.executeRaw<{ data: { daily_memory_dates?: string[]; daily_memory_timezone?: string } }>(
    "SELECT data FROM minion_jobs WHERE name='autopilot-daily-memory'");
  expect(queued.some(row => row.data.daily_memory_timezone === 'Asia/Manila'
    && (row.data.daily_memory_dates ?? []).includes('2026-10-01'))).toBe(true);
  expect(queued.every(row => row.data.daily_memory_timezone !== 'America/Los_Angeles')).toBe(true);
});
