import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import type { PreparedMutation } from '../../src/core/persistence/coordinator.ts';
import { publishMutation } from '../../src/core/persistence/coordinator.ts';
import { publishGroup } from '../../src/core/persistence/group-publish.ts';
import { submissionAuthority } from '../../src/core/persistence/authority.ts';
import { admitWrite, claimNextWrite, LOCK_COUNTERS_SQL } from '../../src/core/persistence/journal.ts';
import { claimWorktree, getWorktreeBinding } from '../../src/core/persistence/ownership.ts';
import { localHostId, registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { refreshDailyMemoryAfterPageMutation } from '../../src/core/cycle/daily-memory-followup.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { withEnv } from '../helpers/with-env.ts';

// Only a disposable test DB, never the operator's configured brain.
const pgTest = process.env.DATABASE_URL ? test : test.skip;
pgTest('group and single publishers take counters before globally sorted day jobs without 40P01', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-day-locks-'));
  const isolated = await isolatedPersistencePostgres(process.env.DATABASE_URL!, 'instance', 4);
  const engine = isolated.engine;
  try {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      await registerLocalWriter(engine, 'cli');
      await engine.setConfig('cycle.timezone', 'UTC');
      const groupedSource = `group-${randomUUID()}`, singleSource = `single-${randomUUID()}`;
      const root = join(home, 'checkout'); mkdirSync(root);
      execFileSync('git', ['init', '-q', root]);
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2),($3,$3,NULL)', [groupedSource, root, singleSource]);
      await claimWorktree(engine, groupedSource, root);
      const binding = (await getWorktreeBinding(engine, groupedSource))!;
      const days = ['2026-01-03', '2026-01-01', '2026-01-02'];
      for (const [i, day] of days.entries()) {
        await engine.putPage(`notes/n${i}`, { type: 'note', title: 'Synthetic lock fixture', compiled_truth: 'Before',
          frontmatter: { date: day }, effective_date: new Date(`${day}T00:00:00Z`), effective_date_source: 'date' }, { sourceId: groupedSource });
      }
      await engine.putPage('notes/single', { type: 'note', title: 'Synthetic single fixture', compiled_truth: 'Before',
        frontmatter: { date: days[0] }, effective_date: new Date(`${days[0]}T00:00:00Z`), effective_date_source: 'date' }, { sourceId: singleSource });
      // Make coalesced waiting rows exist before either publication transaction.
      for (const [i] of days.entries()) await refreshDailyMemoryAfterPageMutation(engine, { sourceId: groupedSource, slug: `notes/n${i}`, operation: 'put_page' });
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const batchId = randomUUID();
      async function claimed(sourceId: string, slug: string, grouped: boolean) {
        const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
        const ctx = { engine, sourceId, config: { engine: 'postgres', embedding_disabled: true }, remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } } as OperationContext;
        const authority = await submissionAuthority(ctx, 'put_page', sourceId, snapshot.sourceIncarnation, slug);
        const admitted = await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId,
          sourceIncarnation: snapshot.sourceIncarnation, slug, pageId: snapshot.page.id, requestId: randomUUID(),
          worktreeId: grouped ? binding.worktree_id : null, topologyGeneration: grouped ? binding.topology_generation : null,
          callerIntent: { content: 'After' }, intent: grouped ? { page_batch: { id: batchId, size: 3 }, content: 'After' } : { content: 'After' } });
        // Model a consumer's already-claimed group without starting a background consumer.
        const row = grouped ? (await engine.executeRaw<typeof admitted>(`UPDATE persistence_requests SET
          state='running',execution_token=gen_random_uuid(),claim_expires_at=now()+interval '5 minutes'
          WHERE id=$1::uuid RETURNING *`, [admitted.id]))[0]! : (await claimNextWrite(engine, localHostId()))!;
        expect(row.id).toBe(admitted.id);
        const prepared: PreparedMutation = { observedRevision: snapshot.revision,
          apply: async tx => {
            await tx.putPage(slug, { type: 'note', title: 'Synthetic lock fixture', compiled_truth: 'After',
              frontmatter: snapshot.page.frontmatter, effective_date: snapshot.page.effective_date, effective_date_source: snapshot.page.effective_date_source }, { sourceId });
            return {};
          } };
        return { row, prepared };
      }
      const group = [];
      for (let i = 0; i < days.length; i++) group.push(await claimed(groupedSource, `notes/n${i}`, true));
      const single = await claimed(singleSource, 'notes/single', false);
      const singleLocked = Promise.withResolvers<void>(), groupAtCounter = Promise.withResolvers<void>();
      const codes: string[] = [], lockedDays: string[] = [];
      function instrument(tx: BrainEngine, role: 'single' | 'group'): BrainEngine {
        return new Proxy(tx, { get(target, key) {
          if (key === 'executeRaw') return async (sql: string, params?: unknown[]) => {
            try {
              if (role === 'group' && sql === LOCK_COUNTERS_SQL) groupAtCounter.resolve();
              const result = await target.executeRaw(sql, params);
              if (role === 'single' && sql === LOCK_COUNTERS_SQL) {
                singleLocked.resolve(); await groupAtCounter.promise;
              }
              if (role === 'group' && sql === 'SELECT id,status,data FROM minion_jobs WHERE id=$1 FOR UPDATE') {
                const job = result[0] as { data: { daily_memory_date: string } }; // Owned fixture query's result.
                lockedDays.push(job.data.daily_memory_date);
              }
              return result;
            } catch (error) {
              if (error && typeof error === 'object' && 'code' in error) codes.push(String(error.code));
              throw error;
            }
          };
          if (key === 'transaction') return <T>(fn: (nested: BrainEngine) => Promise<T>) =>
            target.transaction(nested => fn(instrument(nested, role)));
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        } });
      }
      const singleEngine = new Proxy(engine, { get(target, key) {
        if (key === 'transaction') return <T>(fn: (tx: BrainEngine) => Promise<T>) => target.transaction(async tx => {
          // Detect the cycle before the publisher's short lock_timeout expires.
          await tx.executeRaw("SET LOCAL deadlock_timeout='10ms'");
          return fn(instrument(tx, 'single'));
        });
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      // The single path holds the brain counter before the group reaches its
      // counter lock. Old code already holds Jan 3's day row at this point:
      // single -> day -> group -> counter -> single is a real PG deadlock.
      const singleRun = publishMutation(singleEngine, single.row, single.prepared, localHostId());
      await Promise.race([singleLocked.promise, singleRun.then(result => {
        throw new Error(`Single publisher exited before taking counters: ${JSON.stringify(result)}`);
      })]);
      const groupRun = publishGroup(engine, group.map(m => m.row), group.map(m => m.prepared), localHostId(), {}, null,
        fn => engine.transaction(async tx => {
          await tx.executeRaw("SET LOCAL deadlock_timeout='10ms'");
          return fn(instrument(tx, 'group'));
        })).finally(() => groupAtCounter.resolve());
      const [one, many] = await Promise.all([singleRun, groupRun]);
      console.log(JSON.stringify({ regression: 'DAV-6958', sqlstates: codes, single: one.state, group: many.done?.map(row => row.state), lockedDays }));
      expect(codes).not.toContain('40P01');
      expect(one.state).toBe('committed');
      expect(many.done?.map(row => row.state)).toEqual(['committed', 'committed', 'committed']);
      expect(lockedDays).toEqual([...days].sort());
      for (const member of many.done!) expect(member.outcome?.daily_memory_affected_dates).toHaveLength(1);
    });
  } finally {
    await isolated.close();
    rmSync(home, { recursive: true, force: true });
  }
}, 120_000);
