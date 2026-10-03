import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { loadLivePages } from '../src/commands/duplicates.ts';
import { buildDuplicateEvidenceManifest as build, buildDuplicateEvidenceManifestAsync, candidateHash } from '../src/core/duplicate-evidence.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { hasPendingMigrations } from '../src/core/migrate.ts';

const cli = resolve(import.meta.dir, '../src/cli.ts');
const pgUrl = process.env.DUPLICATES_TEST_DATABASE_URL;
if (pgUrl && !/^postgresql:\/\/[^@]+@127\.0\.0\.1:55462\/gbrain_dav6220_test$/.test(pgUrl)) throw new Error('Refusing non-dedicated test database');
const schema = [
  'CREATE TABLE IF NOT EXISTS sources (id text PRIMARY KEY)',
  `CREATE TABLE IF NOT EXISTS pages (id integer PRIMARY KEY, source_id text NOT NULL, slug text NOT NULL, title text NOT NULL, compiled_truth text NOT NULL, content_hash text, effective_date timestamptz, deleted_at timestamptz, source_kind text, source_uri text, ingested_via text, frontmatter jsonb, UNIQUE(source_id,slug))`,
  'CREATE TABLE IF NOT EXISTS schema_version (version integer PRIMARY KEY, applied_at timestamptz DEFAULT now())',
  'CREATE TABLE IF NOT EXISTS config (key text PRIMARY KEY, value text)',
  'CREATE TABLE IF NOT EXISTS readiness_sentinel (value text)',
];

test('157k near-match-heavy pages exercise title similarity and comparison budget refusal',async () => {
  const shared=Array.from({length:80},(_,i)=>`sharedword${i}`).join(' ');
  const pages=Array.from({length:157000},(_,i)=>({id:i+1,source_id:'synthetic',slug:`revision-${i}`,title:`Synthetic topic ${Math.floor(i/10)}`,compiled_truth:`${shared} revision${i}`}));
  const started=performance.now(); const result=await buildDuplicateEvidenceManifestAsync(pages);
  expect(result.clusters).toHaveLength(15700);
  expect(result.clusters.every((cluster)=>cluster.confidence==='medium' && cluster.pages.length===10 && cluster.relationships.length===9)).toBe(true);
  expect(result.skipped_similarity_groups).toHaveLength(0);
  console.log(JSON.stringify({benchmark:'157k-near-heavy-706500-candidate-pairs',elapsed_ms:Math.round(performance.now()-started),rss_bytes:process.memoryUsage().rss,clusters:result.clusters.length,relationships:result.clusters.reduce((n,c)=>n+c.relationships.length,0)}));
  const overloaded=Array.from({length:2002},(_,i)=>({id:i+1,source_id:'synthetic',slug:`different-${i}`,title:'Shared adversarial topic',compiled_truth:`uniquetoken${i}`}));
  await expect(buildDuplicateEvidenceManifestAsync(overloaded)).rejects.toThrow('Similarity comparison limit exceeded');
},120000);
async function seed(engine: BrainEngine) {
  for (const sql of schema) await engine.executeRaw(sql);
  await engine.executeRaw('TRUNCATE pages, sources, schema_version, config, readiness_sentinel');
  await engine.executeRaw("INSERT INTO config VALUES ('version', '126')");
  await engine.executeRaw("INSERT INTO sources VALUES ('source-a'), ('source-b')");
  await engine.executeRaw('INSERT INTO schema_version(version) VALUES (126)');
  await engine.executeRaw("INSERT INTO readiness_sentinel VALUES ('preserve')");
  await engine.executeRaw(`INSERT INTO pages(id, source_id, slug, title, compiled_truth) SELECT i, CASE WHEN i % 2 = 0 THEN 'source-a' ELSE 'source-b' END, 'note-' || (i / 2)::text, 'T', 'synthetic-body-' || (i / 2)::text FROM generate_series(1, 1102) i`);
}

for (const kind of ['pglite', 'postgres'] as const) {
  test.skipIf(kind === 'postgres' && !pgUrl)(`full ${kind} schema with pending migrations preserves assets, vectors, jobs, verdicts and definitions`, async () => {
    const home = mkdtempSync(join(tmpdir(), `duplicates-full-${kind}-`)); mkdirSync(join(home, '.gbrain'));
    const config = kind === 'pglite' ? { engine: 'pglite' as const, database_path: join(home, 'db') } : { engine: 'postgres' as const, database_url: pgUrl!.replace('gbrain_dav6220_test', 'gbrain_dav6220_readiness_test') };
    const connect = async () => { const e = kind === 'pglite' ? new PGLiteEngine() : new PostgresEngine(); await e.connect({ ...config, poolSize: 2 }); return e; };
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify(config));
    let engine = await connect();
    await engine.initSchema();
    const a = await engine.putPage('readiness-a', { type: 'note', title: 'Readiness synthetic copy', compiled_truth: 'Synthetic retained content with ![](https://example.com/asset.png)' });
    const b = await engine.putPage('readiness-b', { type: 'note', title: 'Readiness synthetic copy', compiled_truth: 'Synthetic retained content with ![](https://example.com/asset.png)' });
    await engine.executeRaw('INSERT INTO links(from_page_id,to_page_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [a.id,b.id]);
    await engine.executeRaw("INSERT INTO content_chunks(page_id,chunk_index,chunk_text) VALUES ($1,0,'synthetic chunk') ON CONFLICT DO NOTHING", [a.id]);
    const dims = await engine.executeRaw<{ atttypmod: number }>("SELECT atttypmod FROM pg_attribute WHERE attrelid='content_chunks'::regclass AND attname='embedding'");
    await engine.executeRaw("UPDATE content_chunks SET embedding = ('[' || repeat('0,',$2 - 1) || '0]')::vector WHERE page_id=$1", [a.id,dims[0].atttypmod]);
    await engine.executeRaw("INSERT INTO files(page_id,filename,storage_path,content_hash) VALUES ($1,'synthetic.png','readiness/synthetic.png','synthetic-asset') ON CONFLICT DO NOTHING", [a.id]);
    await engine.executeRaw("INSERT INTO minion_jobs(name,status) VALUES ('readiness-synthetic','completed')");
    await engine.executeRaw("INSERT INTO dream_verdicts(file_path,content_hash,worth_processing) VALUES ('readiness/synthetic','synthetic',true) ON CONFLICT DO NOTHING");
    await engine.setConfig('version','126');
    expect(await hasPendingMigrations(engine)).toBe(true);
    const live = await loadLivePages(engine);
    const manifest = build(live);
    const cluster = manifest.clusters.find((cluster) => cluster.pages.some((row) => row.page_id === b.id))!;
    const row = cluster.pages.find((row) => row.page_id !== cluster.canonical_display.page_id)!;
    const candidates = [{ ...row, cluster_id: cluster.cluster_id, approved: true }];
    const handoff = { schema_version: 2, input_snapshot_hash: manifest.input_snapshot_hash, evidence_manifest_hash: manifest.manifest_hash, candidate_hash: candidateHash(candidates), approved_by:'reviewer-example', candidates };
    const before = await fingerprint(engine);
    await engine.disconnect();
    const good = await invoke(home,['evidence','--json']); expect(good.code,good.stderr).toBe(0);
    expect(JSON.parse(good.stdout).manifest_hash).toBe(manifest.manifest_hash);
    for (const [index,input] of [handoff,null,[],{ ...handoff,input_snapshot_hash:'stale' }].entries()) {
      const path = join(home,`audit-${index}.json`); writeFileSync(path,JSON.stringify(input));
      const result = await invoke(home,['verify-audit',path,'--json']);
      expect(result.code,result.stderr).toBe(index === 0 ? 0 : 1);
      expect(JSON.parse(result.stdout).authorized_for_mutation).toBe(false);
    }
    const mounts = join(home,'mounts.json'); writeFileSync(mounts,JSON.stringify({ version:1,mounts:[{ id:'synthetic',path:join(home,'mount'),...config }] }));
    const routed = await invoke(home,['evidence','--brain','synthetic','--json'], { GBRAIN_MOUNTS_PATH:mounts,DATABASE_URL:'postgresql://invalid@127.0.0.1:1/tripwire' });
    expect(routed.code,routed.stderr).toBe(0);
    expect(JSON.parse(routed.stdout).manifest_hash).toBe(manifest.manifest_hash);
    engine = await connect(); expect(await fingerprint(engine)).toBe(before); await engine.disconnect();
  },180000);
}

test('157k-page synthetic corpus and large title groups have measured bounded output; computation aborts', async () => {
  const pages = Array.from({ length:157000 },(_,i) => ({ id:i+1,source_id:'synthetic',slug:`page-${i}`,title:'T',compiled_truth:`${i}:`+'x'.repeat(1024) }));
  const started = performance.now(); const result = await buildDuplicateEvidenceManifestAsync(pages);
  expect(result.pages_scanned).toBe(157000);
  expect(result.clusters).toHaveLength(0);
  console.log(JSON.stringify({ benchmark:'157k-160MB', elapsed_ms:Math.round(performance.now()-started),rss_bytes:process.memoryUsage().rss }));
  const exact = pages.map((page) => ({ ...page,compiled_truth:'same synthetic body' }));
  const group = build(exact).clusters[0]; expect(group.relationships).toHaveLength(156999);
  const diverse = pages.slice(0,1000).map((page) => ({ ...page,title:'Shared synthetic long title',compiled_truth:`${page.id} `+'alpha beta gamma delta '.repeat(25) }));
  const controller = new AbortController(); setImmediate(() => controller.abort());
  await expect(buildDuplicateEvidenceManifestAsync(diverse,controller.signal)).rejects.toThrow();
},120000);
async function fingerprint(engine: BrainEngine) {
  const tables = await engine.executeRaw<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`);
  const columns = await engine.executeRaw(`SELECT table_name,column_name,data_type,column_default,is_nullable FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name,ordinal_position`);
  const indexes = await engine.executeRaw("SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname");
  const constraints = await engine.executeRaw("SELECT c.relname, con.conname, pg_get_constraintdef(con.oid) AS definition FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.relname,con.conname");
  const triggers = await engine.executeRaw("SELECT c.relname,t.tgname,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.relname,t.tgname");
  const functions = await engine.executeRaw("SELECT p.oid::regprocedure::text AS name,pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind IN ('f','p') ORDER BY p.oid::regprocedure::text");
  const sequences = await engine.executeRaw("SELECT * FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename");
  const rows = await Promise.all(tables.map(({ tablename }) => engine.executeRaw(`SELECT row_to_json(t)::text AS row FROM "${tablename.replaceAll('"','""')}" t ORDER BY row_to_json(t)::text`)));
  return JSON.stringify({ tables, columns, indexes, constraints, triggers, functions, sequences, rows }, (_,value) => typeof value === 'bigint' ? value.toString() : value);
}
async function invoke(home: string, args: string[], extra: Record<string,string> = {}) {
  const child = Bun.spawn([process.execPath, '--no-env-file', cli, 'duplicates', ...args], { cwd: home, env: { PATH: process.env.PATH!, GBRAIN_HOME: home, GBRAIN_NO_RETRY_CONNECT: '1', ...extra }, stdout: 'pipe', stderr: 'pipe' });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 30000);
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timeout);
  return { stdout, stderr, code, resourceUsage: child.resourceUsage() };
}

test.skipIf(!pgUrl)('actual Postgres CLI scans 157k pages with 160MB bodies within resource bounds',async () => {
  const home = mkdtempSync(join(tmpdir(),'duplicates-scale-')); mkdirSync(join(home,'.gbrain'));
  const config = { engine:'postgres' as const,database_url:pgUrl! }; writeFileSync(join(home,'.gbrain','config.json'),JSON.stringify(config));
  const engine = new PostgresEngine(); await engine.connect({ ...config,poolSize:2 });
  await seed(engine);
  await engine.executeRaw('TRUNCATE pages');
  await engine.executeRaw("INSERT INTO pages(id,source_id,slug,title,compiled_truth) SELECT i,'source-a','page-'||i::text,'T',i::text||repeat('x',1024) FROM generate_series(1,157000)i");
  const started = performance.now(); const result = await invoke(home,['evidence','--json']);
  expect(result.code,result.stderr).toBe(0); expect(JSON.parse(result.stdout).pages_scanned).toBe(157000);
  expect(result.stdout.length).toBeLessThan(10000);
  console.log(JSON.stringify({ benchmark:'native-cli-157k-160MB',elapsed_ms:Math.round(performance.now()-started),max_rss_bytes:result.resourceUsage?.maxRSS }));
  await engine.executeRaw("UPDATE pages SET title='Synthetic topic '||((id-1)/10)::text,compiled_truth=repeat('alpha beta gamma delta epsilon zeta eta theta iota kappa lambda omega ',15)||id::text");
  const nearStarted=performance.now(); const near=await invoke(home,['evidence','--json']);
  expect(near.code,near.stderr).toBe(0);
  const nearManifest=JSON.parse(near.stdout);
  expect(nearManifest.clusters).toHaveLength(15700);
  expect(nearManifest.clusters.every((cluster:{confidence:string;relationships:unknown[]})=>cluster.confidence==='medium' && cluster.relationships.length===9)).toBe(true);
  console.log(JSON.stringify({benchmark:'native-cli-157k-near-heavy',elapsed_ms:Math.round(performance.now()-nearStarted),max_rss_bytes:near.resourceUsage?.maxRSS,json_bytes:Buffer.byteLength(near.stdout)}));
  expect((await engine.executeRaw<{ value:string }>("SELECT value FROM config WHERE key='version'"))[0].value).toBe('126');
  await engine.disconnect();
},120000);

for (const kind of ['pglite', 'postgres'] as const) {
  test.skipIf(kind === 'postgres' && !pgUrl)(`actual ${kind} CLI preserves pending schema and all rows across success and invalid input`, async () => {
    const home = mkdtempSync(join(tmpdir(), `duplicates-${kind}-`));
    const config = kind === 'pglite' ? { engine: 'pglite' as const, database_path: join(home, 'db') } : { engine: 'postgres' as const, database_url: pgUrl! };
    const connect = async () => { const engine = kind === 'pglite' ? new PGLiteEngine() : new PostgresEngine(); await engine.connect({ ...config, poolSize: 2 }); return engine; };
    mkdirSync(join(home, '.gbrain'));
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify(config));
    let engine = await connect();
    await seed(engine);
    expect(await hasPendingMigrations(engine)).toBe(true);
    const before = await fingerprint(engine);
    const pages = await loadLivePages(engine);
    expect(pages).toHaveLength(1102);
    expect(build(pages).source_counts).toEqual({ 'source-a': 551, 'source-b': 551 });
    if (kind === 'postgres') {
      const writer = new PostgresEngine(); await writer.connect({ ...config, poolSize: 2 });
      let changed = false;
      const proxy = Object.create(engine) as BrainEngine;
      proxy.transaction = (fn) => engine.transaction((tx) => {
        const reader = Object.create(tx) as BrainEngine;
        reader.executeRaw = async (sql, params, opts) => {
          const rows = await tx.executeRaw(sql, params, opts);
          if (!changed && sql.startsWith('SELECT id,')) {
            changed = true;
            await writer.executeRaw("UPDATE pages SET compiled_truth = 'concurrent revision' WHERE id = 1102");
          }
          return rows as never;
        };
        return fn(reader);
      });
      const snapshot = await loadLivePages(proxy);
      expect(snapshot.find((page) => page.id === 1102)!.compiled_truth).toBe('synthetic-body-551');
      expect((await loadLivePages(engine)).find((page) => page.id === 1102)!.compiled_truth).toBe('concurrent revision');
      await writer.executeRaw("UPDATE pages SET compiled_truth = 'synthetic-body-551' WHERE id = 1102");
      await writer.disconnect();
      await engine.executeRaw("DO $$ BEGIN CREATE ROLE duplicates_reader LOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$");
      await engine.executeRaw('GRANT USAGE ON SCHEMA public TO duplicates_reader');
      await engine.executeRaw('GRANT SELECT ON ALL TABLES IN SCHEMA public TO duplicates_reader');
      const readHome = mkdtempSync(join(tmpdir(), 'duplicates-reader-')); mkdirSync(join(readHome, '.gbrain'));
      writeFileSync(join(readHome, '.gbrain', 'config.json'), JSON.stringify({ engine: 'postgres', database_url: pgUrl!.replace(/\/\/[^@]+@/, '//duplicates_reader@') }));
      const readOnly = await invoke(readHome, ['evidence', '--json']);
      expect(readOnly.code, readOnly.stderr).toBe(0);
      expect(JSON.parse(readOnly.stdout).pages_scanned).toBe(1102);
      writeFileSync(join(readHome,'invalid.json'),'null');
      expect((await invoke(readHome,['verify-audit',join(readHome,'invalid.json'),'--json'])).code).toBe(1);
      const reader = new PostgresEngine(); await reader.connect({ engine: 'postgres', poolSize: 2, database_url: pgUrl!.replace(/\/\/[^@]+@/, '//duplicates_reader@') });
      await expect(reader.executeRaw("UPDATE pages SET title = 'forbidden' WHERE id = 1")).rejects.toThrow();
      await reader.disconnect();
      const locker = new PostgresEngine(); await locker.connect({ ...config, poolSize: 2 });
      let unlock!: () => void;
      let locked!: () => void;
      const lockReady = new Promise<void>((resolve) => { locked = resolve; });
      const releaseLock = new Promise<void>((resolve) => { unlock = resolve; });
      const held = locker.transaction(async (tx) => { await tx.executeRaw('LOCK TABLE pages IN ACCESS EXCLUSIVE MODE'); locked(); await releaseLock; });
      await lockReady;
      const child = Bun.spawn([process.execPath, '--no-env-file', cli, 'duplicates', 'evidence', '--json'], { cwd: readHome, env: { PATH: process.env.PATH!, GBRAIN_HOME: readHome, GBRAIN_NO_RETRY_CONNECT: '1' }, stdout: 'pipe', stderr: 'pipe' });
      const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
      try {
        let waiting = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const active = await engine.executeRaw<{ count: number }>("SELECT count(*)::integer AS count FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE '%FROM pages WHERE%'");
          if (active[0].count > 0) { waiting = true; break; }
          await Bun.sleep(50);
        }
        expect(waiting).toBe(true);
        child.kill('SIGINT');
        const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
        const code = await child.exited; clearTimeout(timeout);
        expect(code).not.toBe(0);
        expect(code).not.toBe(137);
        expect((await output)[0]).toBe('');
        const disconnected = Bun.spawn([process.execPath,'--no-env-file',cli,'duplicates','evidence','--json'], { cwd:readHome,env:{ PATH:process.env.PATH!,GBRAIN_HOME:readHome,GBRAIN_NO_RETRY_CONNECT:'1' },stdout:'pipe',stderr:'pipe' });
        const disconnectedOutput = Promise.all([new Response(disconnected.stdout).text(),new Response(disconnected.stderr).text()]);
        let terminated = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const active = await engine.executeRaw<{ pid:number }>("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%FROM pages WHERE%'");
          if (active.length) { await engine.executeRaw('SELECT pg_terminate_backend($1)',[active[0].pid]); terminated = true; break; }
          await Bun.sleep(50);
        }
        const disconnectTimeout = setTimeout(() => disconnected.kill('SIGKILL'),5000);
        const disconnectCode = await disconnected.exited; clearTimeout(disconnectTimeout);
        expect(terminated).toBe(true); expect(disconnectCode).not.toBe(0); expect(disconnectCode).not.toBe(137);
        expect((await disconnectedOutput)[0]).toBe('');
      } finally { child.kill(); unlock(); await held; await locker.disconnect(); }
    }
    await engine.disconnect();
    const success = await invoke(home, ['evidence', '--json']);
    expect(success.code, success.stderr).toBe(0);
    expect(JSON.parse(success.stdout).pages_scanned).toBe(1102);
    const scoped = await invoke(home, ['evidence', '--source=source-a', '--json'], { GBRAIN_SOURCE: 'source-b' });
    expect(scoped.code, scoped.stderr).toBe(0);
    expect(JSON.parse(scoped.stdout).source_counts).toEqual({ 'source-a': 551 });
    const ambient = await invoke(home, ['evidence', '--json'], { GBRAIN_SOURCE: 'source-b' });
    expect(JSON.parse(ambient.stdout).source_counts).toEqual({ 'source-b': 551 });
    const all = await invoke(home, ['evidence', '--source', '__all__', '--json'], { GBRAIN_SOURCE: 'source-b' });
    expect(JSON.parse(all.stdout).pages_scanned).toBe(1102);
    expect((await invoke(home, ['--help'])).code).toBe(0);
    for (const args of [['evidence', '--source'], ['evidence', '--unknown'], ['verify-audit', '--source', 'source-a'], ['nonsense']]) {
      const result = await invoke(home, args);
      expect(result.code, JSON.stringify(result)).not.toBe(0);
    }
    writeFileSync(join(home, 'invalid.json'), '{}');
    expect((await invoke(home, ['verify-audit', '--json', join(home, 'invalid.json')])).code).not.toBe(0);
    engine = await connect();
    expect(await fingerprint(engine)).toBe(before);
    const cancelled = new AbortController(); cancelled.abort();
    await expect(loadLivePages(engine, undefined, cancelled.signal)).rejects.toThrow();
    expect(await fingerprint(engine)).toBe(before);
    await engine.disconnect();
  }, 180000);
}
