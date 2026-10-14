/** Standalone sync preserves affected dates across a rejected queue handoff. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dailyMemoryDaysForSlugs, queueStandaloneSyncDailyMemory } from '../src/core/cycle/daily-memory-followup.ts';
import { prepareSyncDailyMemory } from '../src/core/sync-daily-memory.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { performSync } from '../src/commands/sync.ts';
import * as checkpoints from '../src/core/op-checkpoint.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';
import { DAILY_MEMORY_PAGE_CAP, DAILY_MEMORY_SOURCE_ID, writeDailyMemoryFromSources } from '../src/core/cycle/daily-memory.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let repo: string;
let version: string | null;
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString().trim();
const write = (file: string, day: string) => writeFileSync(join(repo, file), `---\ntitle: Fixture\ndate: ${day}\n---\nFixture body.\n`);
const anchor = async () => (await engine.executeRaw<{ last_commit: string }>("SELECT last_commit FROM sources WHERE id='default'"))[0]?.last_commit;
const opts = () => ({ repoPath: repo, sourceId: 'default', noPull: true, noEmbed: true, noExtract: true, dailyMemoryFollowup: true });

describe('standalone sync daily-memory durable handoff', () => {
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    version = await engine.getConfig('version');
  });
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => {
    await resetPgliteState(engine);
    if (version) await engine.setConfig('version', version);
    repo = mkdtempSync(join(tmpdir(), 'gbrain-sync-days-'));
    git('init'); git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'user.name', 'Fixture'); git('config', 'commit.gpgsign', 'false');
    mkdirSync(join(repo, 'notes'));
    write('notes/old.md', '2026-01-03'); write('notes/remove.md', '2026-01-04');
    git('add', '-A'); git('commit', '-m', 'seed');
    await performSync(engine, { ...opts(), full: true, dailyMemoryFollowup: false });
  });
  afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

  for (const mode of ['filesystem-sync', 'database-only', 'no-sync-phase'] as const) {
    test(`legacy unregistered checkout drains default debt only after filesystem sync: ${mode}`, async () => {
      const home = mkdtempSync(join(tmpdir(), 'gbrain-legacy-debt-home-'));
      try { await withEnv({ GBRAIN_HOME: home }, async () => {
        await engine.executeRaw('UPDATE sources SET local_path=NULL');
        const queue = new MinionQueue(engine);
        const queued = await queue.add('autopilot-cycle', {
          repoPath: mode === 'database-only' ? null : repo,
          phases: mode === 'no-sync-phase' ? ['lint'] : ['sync'], pull: false,
        });
        const job = (await queue.claim('legacy-default-debt-owner', 60_000, 'default', ['autopilot-cycle']))!;
        expect(job.id).toBe(queued.id);
        const key = { op: 'autopilot-sync-daily-memory', fingerprint: createHash('sha256').update('default').digest('hex').slice(0, 16) };
        const day = '2025-12-20';
        const debt = JSON.stringify({ jobId: job.id, day });
        expect(await checkpoints.appendCompleted(engine, key, [debt])).toBe(true);
        const handlers = new Map<string, (job: any) => Promise<any>>();
        await registerBuiltinHandlers({ register(name: string, handler: (job: any) => Promise<any>) { handlers.set(name, handler); } } as never, engine, { quiet: true });
        const previousAnchor = await anchor();
        const result = await handlers.get('autopilot-cycle')!(job);
        const batches = await engine.executeRaw<{ data: { daily_memory_dates?: string[]; daily_memory_source_job_id?: number } }>(
          "SELECT data FROM minion_jobs WHERE name='autopilot-daily-memory' AND data ? 'daily_memory_dates'");
        const retained = await engine.executeRaw<{ path: string }>('SELECT path FROM op_checkpoint_paths WHERE op=$1 AND fingerprint=$2', [key.op, key.fingerprint]);
        if (mode === 'filesystem-sync') {
          expect(result.report.phases.some((phase: { phase: string; status: string }) => phase.phase === 'sync' && phase.status !== 'skipped')).toBe(true);
          expect(batches).toHaveLength(1);
          expect(batches[0]!.data.daily_memory_dates).toEqual([day, '2026-01-03', '2026-01-04']);
          expect(batches[0]!.data.daily_memory_source_job_id).toBe(job.id);
          expect(retained).toHaveLength(0);
        } else {
          expect(batches).toHaveLength(0);
          expect(retained).toEqual([{ path: debt }]);
        }
        expect(await anchor()).toBe(previousAnchor);
      }); } finally { rmSync(home, { recursive: true, force: true }); }
    });
  }

  test('standalone sync pins initial final capture and queued writer to one timezone', async () => {
    await engine.setConfig('cycle.timezone', 'Asia/Manila');
    const slug = 'notes/near-midnight-pin';
    await engine.putPage(slug, { type: 'note', title: 'Synthetic midnight fixture', compiled_truth: 'Synthetic content',
      frontmatter: { date: '2026-09-30T16:30:00Z' }, effective_date: new Date('2026-09-30T16:30:00Z'), effective_date_source: 'date' });
    await engine.executeRaw('UPDATE pages SET source_path=$1 WHERE source_id=$2 AND slug=$3', ['notes/near-midnight-pin.md', 'default', slug]);
    const append = checkpoints.appendCompleted;
    let captures = 0;
    const flip = spyOn(checkpoints, 'appendCompleted').mockImplementation(async (...args) => {
      const accepted = await append(...args);
      if (args[1].op === 'sync-daily-memory') {
        captures++;
        if (captures === 1) await engine.setConfig('cycle.timezone', 'UTC');
        if (captures === 2) await engine.setConfig('cycle.timezone', 'America/Los_Angeles');
      }
      return accepted;
    });
    try {
      const followup = (await prepareSyncDailyMemory(engine, { sourceId: 'default', commit: 'synthetic-zone-pin', scope: 'notes/', paths: ['notes/near-midnight-pin.md'] }))!;
      await followup.accept();
      expect(captures).toBe(2);
      expect(await engine.getConfig('cycle.timezone')).toBe('America/Los_Angeles');
      const queue = new MinionQueue(engine);
      const jobs = await engine.executeRaw<{ id: number; data: Record<string, unknown> }>("SELECT id,data FROM minion_jobs WHERE name='autopilot-daily-memory' ORDER BY id");
      expect(jobs.length).toBeGreaterThan(0);
      for (const job of jobs) {
        expect(job.data.daily_memory_date).toBe('2026-10-01');
        expect(job.data.daily_memory_timezone).toBe('Asia/Manila');
      }
      const handlers = new Map<string, (job: any) => Promise<any>>();
      await registerBuiltinHandlers({ register(name: string, handler: (job: any) => Promise<any>) { handlers.set(name, handler); } } as never, engine);
      const job = (await queue.claim('synthetic-zone-worker', 60_000, 'default', ['autopilot-daily-memory']))!;
      await handlers.get('autopilot-daily-memory')!(job);
      await queue.completeJob(job.id, 'synthetic-zone-worker', {});
      expect((await engine.getPage('daily-memory/2026-10-01', { sourceId: DAILY_MEMORY_SOURCE_ID }))!.compiled_truth)
        .toContain('[[default:notes/near-midnight-pin]]');
      expect(await engine.getPage('daily-memory/2026-09-30', { sourceId: DAILY_MEMORY_SOURCE_ID })).toBeNull();
      expect(await engine.getConfig('cycle.timezone')).toBe('America/Los_Angeles');
    } finally { flip.mockRestore(); }
  });

  async function filenameCycleFixture(sourceScoped=true) {
    const from='notes/2026-01-06-zz-fixture.md',to='notes/2026-01-07-zz-fixture.md';
    const oldSlug=from.slice(0,-3),newSlug=to.slice(0,-3);
    const body='---\ntitle: Synthetic filename fixture\n---\n\n'+Array.from({length:20},(_,i)=>`Synthetic unchanged paragraph ${i}.`).join('\n');
    writeFileSync(join(repo,from),body); git('add','-A');git('commit','-m','seed filename date');
    await performSync(engine,{...opts(),dailyMemoryFollowup:false});
    const seed=git('rev-parse','HEAD');
    expect(await dailyMemoryDaysForSlugs(engine,'default',[oldSlug])).toContain('2026-01-06');
    for(let i=0;i<DAILY_MEMORY_PAGE_CAP;i++) await engine.putPage(`aaa-cap-${String(i).padStart(2,'0')}`,{
      type:'note',title:'Synthetic cap fixture',compiled_truth:'Synthetic body',frontmatter:{date:'2026-01-06'},
      effective_date:new Date('2026-01-06T00:00:00Z'),effective_date_source:'date',
    });
    await writeDailyMemoryFromSources(engine,{date:'2026-01-06'});
    expect((await engine.getPage('daily-memory/2026-01-06',{sourceId:DAILY_MEMORY_SOURCE_ID}))!.compiled_truth).not.toContain(`[[default:${oldSlug}]]`);
    renameSync(join(repo,from),join(repo,to));writeFileSync(join(repo,to),body+'\nSynthetic new paragraph.\n');
    git('add','-A');git('commit','-m','rename filename day');
    const target=git('rev-parse','HEAD');
    expect(git('diff','--name-status','-M',seed,target)).toMatch(/^R\d+\s/);
    await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'",[repo]);
    const handlers=new Map<string,(job:any)=>Promise<any>>();
    await registerBuiltinHandlers({register(name:string,fn:(job:any)=>Promise<any>){handlers.set(name,fn);}} as never,engine,{quiet:true});
    const queue=new MinionQueue(engine);
    await queue.add('autopilot-cycle',{...(sourceScoped?{source_id:'default'}:{repoPath:repo}),phases:['sync'],pull:false});
    const job=(await queue.claim('synthetic-cycle-owner',60_000,'default',['autopilot-cycle']))!;
    expect(job).not.toBeNull();
    return {seed,target,oldSlug,newSlug,job,handler:handlers.get('autopilot-cycle')!};
  }

  test('queued filename-only rename retains the capped old day through a rejected post-cycle handoff',async () => {
    const home=mkdtempSync(join(tmpdir(),'gbrain-cycle-days-home-'));
    try {await withEnv({GBRAIN_HOME:home},async () => {
      const fixture=await filenameCycleFixture();
      const add=MinionQueue.prototype.add;
      const failure=spyOn(MinionQueue.prototype,'add').mockImplementation(async function(this:MinionQueue,name,data,options){
        if(name==='autopilot-daily-memory') throw new Error('Synthetic cycle handoff rejection');
        return add.call(this,name,data,options);
      });
      try {await expect(fixture.handler(fixture.job)).rejects.toThrow('Synthetic cycle handoff rejection');}
      finally {failure.mockRestore();}
      expect(await anchor()).toBe(fixture.target);
      expect(await engine.getPage(fixture.oldSlug)).toBeNull();
      expect(await dailyMemoryDaysForSlugs(engine,'default',[fixture.newSlug])).not.toContain('2026-01-06');
      const debt=await engine.executeRaw<{path:string}>("SELECT path FROM op_checkpoint_paths WHERE op='autopilot-sync-daily-memory'");
      expect(debt.some(row=>JSON.parse(row.path).day==='2026-01-06')).toBe(true);
      await fixture.handler(fixture.job);
      const batches=await engine.executeRaw<{data:{daily_memory_dates:string[];daily_memory_source_job_id:number}}>("SELECT data FROM minion_jobs WHERE name='autopilot-daily-memory' AND data ? 'daily_memory_dates'");
      expect(batches).toHaveLength(1);
      expect(batches[0]!.data.daily_memory_source_job_id).toBe(fixture.job.id);
      expect(batches[0]!.data.daily_memory_dates).toEqual(expect.arrayContaining(['2026-01-06','2026-01-07']));
      expect(await engine.executeRaw("SELECT path FROM op_checkpoint_paths WHERE op IN ('sync-daily-memory','autopilot-sync-daily-memory')")).toHaveLength(0);
    });} finally {rmSync(home,{recursive:true,force:true});}
  });

  test('rejected cycle pre-write date bank keeps canonical rename and sync anchor untouched',async () => {
    const home=mkdtempSync(join(tmpdir(),'gbrain-cycle-days-home-'));
    try {await withEnv({GBRAIN_HOME:home},async () => {
      const fixture=await filenameCycleFixture();const direct=engine.executeRawDirect;
      const failure=spyOn(engine,'executeRawDirect').mockImplementation(async function<T>(this:PGLiteEngine,sql:string,params?:unknown[],rawOpts?:{signal?:AbortSignal}):Promise<T[]>{
        if(sql.includes('INSERT INTO op_checkpoint_paths')&&params?.[0]==='autopilot-sync-daily-memory') throw new Error('Synthetic cycle date bank rejection');
        return direct.call(this,sql,params,rawOpts) as Promise<T[]>;
      });
      try {expect((await fixture.handler(fixture.job)).partial).toBe(true);} finally {failure.mockRestore();}
      expect(await anchor()).toBe(fixture.seed);
      expect(await engine.getPage(fixture.oldSlug)).not.toBeNull();expect(await engine.getPage(fixture.newSlug)).toBeNull();
      await fixture.handler(fixture.job);
      expect(await anchor()).toBe(fixture.target);
      const batches=await engine.executeRaw<{data:{daily_memory_dates:string[]}}>("SELECT data FROM minion_jobs WHERE name='autopilot-daily-memory' AND data ? 'daily_memory_dates'");
      expect(batches.some(row=>['2026-01-06','2026-01-07'].every(day=>row.data.daily_memory_dates.includes(day)))).toBe(true);
    });} finally {rmSync(home,{recursive:true,force:true});}
  });

  test('legacy queued cycle owns one handoff for old and new filename days',async () => {
    const home=mkdtempSync(join(tmpdir(),'gbrain-cycle-days-home-'));
    try {await withEnv({GBRAIN_HOME:home},async () => {
      const fixture=await filenameCycleFixture(false);
      expect((await fixture.handler(fixture.job)).partial).toBe(false);
      expect(await anchor()).toBe(fixture.target);
      const batches=await engine.executeRaw<{data:{daily_memory_dates:string[];daily_memory_source_job_id:number}}>("SELECT data FROM minion_jobs WHERE name='autopilot-daily-memory' AND data ? 'daily_memory_dates'");
      expect(batches).toHaveLength(1);
      expect(batches[0]!.data.daily_memory_dates).toEqual(expect.arrayContaining(['2026-01-06','2026-01-07']));
      expect(batches[0]!.data.daily_memory_source_job_id).toBe(fixture.job.id);
      expect(await engine.executeRaw("SELECT path FROM op_checkpoint_paths WHERE op IN ('sync-daily-memory','autopilot-sync-daily-memory')")).toHaveLength(0);
    });} finally {rmSync(home,{recursive:true,force:true});}
  });

  for (const full of [false, true]) {
    test(`${full ? 'full reconciliation' : 'incremental rename'} retries old and new days before consuming anchor`, async () => {
      const seed = git('rev-parse', 'HEAD');
      renameSync(join(repo, 'notes/old.md'), join(repo, 'notes/new.md'));
      write('notes/new.md', '2026-01-05');
      rmSync(join(repo, 'notes/remove.md'));
      git('add', '-A'); git('commit', '-m', 'rename date and remove');
      const target = git('rev-parse', 'HEAD');
      const failure = spyOn(MinionQueue.prototype, 'add').mockRejectedValueOnce(new Error('fixture queue unavailable'));
      try {
        await expect(performSync(engine, { ...opts(), full })).rejects.toThrow('fixture queue unavailable');
      } finally { failure.mockRestore(); }
      expect(await anchor()).toBe(seed);
      const removed = await engine.executeRaw<{ deleted_at: string | null }>(
        "SELECT deleted_at FROM pages WHERE source_id='default' AND slug='notes/remove'");
      expect(removed[0]?.deleted_at).not.toBeNull();
      expect(removed).toHaveLength(1);
      const saved = await engine.executeRaw<{ path: string }>(
        "SELECT path FROM op_checkpoint_paths WHERE op='sync-daily-memory'");
      expect(saved.map(row => row.path)).toContain('day:2026-01-03');
      expect(saved.map(row => row.path)).toContain('day:2026-01-04');
      // Retry may hash-skip imported pages and skip banked deletion paths.
      await performSync(engine, { ...opts(), full });
      expect(await anchor()).toBe(target);
      const batches = await engine.executeRaw<{ data: { daily_memory_dates?: string[] } }>(
        "SELECT data FROM minion_jobs WHERE name='autopilot-daily-memory'");
      expect(batches.some(row => ['2026-01-03', '2026-01-04', '2026-01-05']
        .every(day => row.data.daily_memory_dates?.includes(day)))).toBe(true);
      expect(await engine.executeRaw("SELECT path FROM op_checkpoint_paths WHERE op='sync-daily-memory'")).toHaveLength(0);
    });
  }
  test('queued-cycle full sync reports imported and retired dates without duplicate standalone jobs', async () => {
    renameSync(join(repo, 'notes/old.md'), join(repo, 'notes/new.md'));
    write('notes/new.md', '2026-01-05');
    rmSync(join(repo, 'notes/remove.md'));
    git('add', '-A'); git('commit', '-m', 'full cycle changes');
    const result = await performSync(engine, { ...opts(), full: true, dailyMemoryFollowup: false });
    expect(result.pagesAffected).toEqual(expect.arrayContaining(['notes/old', 'notes/new', 'notes/remove']));
    expect(await engine.executeRaw('SELECT id FROM minion_jobs')).toHaveLength(0);
    const days = await dailyMemoryDaysForSlugs(engine, 'default', result.pagesAffected);
    expect(days).toEqual(expect.arrayContaining(['2026-01-03', '2026-01-04', '2026-01-05']));
    await queueStandaloneSyncDailyMemory(engine, { sourceId: 'default', commit: result.toCommit!, days });
    const batches = await engine.executeRaw<{ data: { daily_memory_dates?: string[] } }>(
      "SELECT data FROM minion_jobs WHERE name='autopilot-daily-memory'");
    expect(batches.some(row => days.every(day => row.data.daily_memory_dates?.includes(day)))).toBe(true);
  });

  test('pins one timezone across sync date capture and enqueue after cycle.timezone flips', async () => {
    await engine.setConfig('cycle.timezone', 'Asia/Manila');
    // 02:00Z is 2026-09-30 in Asia/Manila and 2026-09-29 in America/Los_Angeles.
    writeFileSync(join(repo, 'notes/tz-pin.md'), '---\ntitle: Timezone pin fixture\n---\nSynthetic fixture.\n');
    git('add', '-A'); git('commit', '-m', 'timezone pin page');
    await performSync(engine, { ...opts(), dailyMemoryFollowup: false });
    await engine.executeRaw(
      "UPDATE pages SET effective_date=NULL, effective_date_source=NULL, updated_at='2026-09-30T02:00:00Z' WHERE source_id='default' AND slug='notes/tz-pin'");
    expect(await dailyMemoryDaysForSlugs(engine, 'default', ['notes/tz-pin'], { timezone: 'Asia/Manila' })).toContain('2026-09-30');
    const handoff = await prepareSyncDailyMemory(engine, {
      sourceId: 'default', commit: git('rev-parse', 'HEAD'), scope: '',
    });
    expect(handoff).toBeDefined();
    await engine.setConfig('cycle.timezone', 'America/Los_Angeles');
    await handoff!.accept();
    const batches = await engine.executeRaw<{ data: { daily_memory_dates?: string[]; daily_memory_timezone?: string } }>(
      "SELECT data FROM minion_jobs WHERE name='autopilot-daily-memory' AND data ? 'daily_memory_dates'");
    expect(batches.some(row => row.data.daily_memory_timezone === 'Asia/Manila'
      && row.data.daily_memory_dates?.includes('2026-09-30'))).toBe(true);
    expect(batches.every(row => row.data.daily_memory_timezone !== 'America/Los_Angeles')).toBe(true);
  });

  test('a second working-tree edit at the same HEAD receives fresh maintenance after completed jobs', async () => {
    const head = git('rev-parse', 'HEAD');
    write('notes/old.md', '2026-01-05');
    await performSync(engine, { ...opts(), workingTree: true });
    const queue = new MinionQueue(engine);
    const completed: number[] = [];
    for (let i = 0; i < 10; i++) {
      const token = `fixture-daily-${i}`;
      const job = await queue.claim(token, 60_000, 'default', ['autopilot-daily-memory']);
      if (!job) break;
      expect(await queue.completeJob(job.id, token, {})).not.toBeNull();
      completed.push(job.id);
    }
    expect(completed.length).toBeGreaterThan(0);
    write('notes/old.md', '2026-01-06');
    await performSync(engine, { ...opts(), workingTree: true });
    expect(git('rev-parse', 'HEAD')).toBe(head);
    const fresh = await engine.executeRaw<{ id: number; status: string; data: { daily_memory_dates?: string[] } }>(
      "SELECT id,status,data FROM minion_jobs WHERE name='autopilot-daily-memory'");
    expect(fresh.some(row => !completed.includes(row.id) && ['waiting', 'delayed'].includes(row.status)
      && row.data.daily_memory_dates?.includes('2026-01-06'))).toBe(true);
  });

});
