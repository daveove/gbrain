/** Durable daily-memory refresh handoff for transcript ingest (and connectors that reuse it). */
import { createHash, randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { appendCompleted, type OpCheckpointKey } from '../op-checkpoint.ts';
import { DAILY_MEMORY_SOURCE_ID } from '../cycle/daily-memory.ts';
import { dailyMemoryDaysForSlugs, queueStandaloneSyncDailyMemory } from '../cycle/daily-memory-followup.ts';

type Prior = { targets: Array<{ slug: string; revision: string | null }>; days: string[] };

/** Bank prior/current days around session writes, then accept refresh work before a clean scan. */
export async function createTranscriptIngestDailyMemory(engine: BrainEngine, opts: {
  sourceId: string; runKey: string; signal?: AbortSignal;
  protect?: (key: OpCheckpointKey) => Promise<void>;
}) {
  if (opts.sourceId === DAILY_MEMORY_SOURCE_ID) return undefined;
  const key = { op: 'transcript-ingest-daily-memory', fingerprint: createHash('sha256')
    .update(JSON.stringify([opts.sourceId])).digest('hex').slice(0, 16) };
  const legacyFingerprint = createHash('sha256').update(JSON.stringify([opts.sourceId, opts.runKey])).digest('hex').slice(0, 16);
  const origin = randomUUID();
  await opts.protect?.(key);
  const bank = async (entries: string[]) => {
    opts.signal?.throwIfAborted();
    const wrapped = entries.map(value => JSON.stringify({ origin, value }));
    if (wrapped.length && !await appendCompleted(engine, key, wrapped)) {
      throw new Error('Daily-memory transcript ingest checkpoint unavailable');
    }
    return wrapped;
  };
  // Mark this origin active so a concurrent finish preserves our before:/slug banks.
  await bank(['running']);
  const clearRunning = async () => {
    const marker = JSON.stringify({ origin, value: 'running' });
    for (const fingerprint of new Set([key.fingerprint, legacyFingerprint])) {
      await engine.executeRawDirect(
        'DELETE FROM op_checkpoint_paths WHERE op=$1 AND fingerprint=$2 AND path=$3',
        [key.op, fingerprint, marker]);
      await engine.executeRawDirect(
        'UPDATE op_checkpoints SET completed_keys=completed_keys-$3::text[] WHERE op=$1 AND fingerprint=$2',
        [key.op, fingerprint, [marker]]);
    }
  };
  return {
    /** Drop the running marker without settling debt (abort / early exit). */
    async release() { await clearRunning(); },
    async before(slugs: string[]) {
      opts.signal?.throwIfAborted();
      const names = new Set(slugs.filter(Boolean));
      if (!names.size) return;
      const existing = await engine.executeRaw<{ slug: string; revision: string }>(
        'SELECT slug,knowledge_revision AS revision FROM pages WHERE source_id=$1 AND slug=ANY($2::text[])',
        [opts.sourceId, [...names]]);
      for (const row of existing) names.add(row.slug);
      const unique = [...names];
      const prior: Prior = {
        targets: unique.map(slug => ({
          slug,
          revision: existing.find(row => row.slug === slug)?.revision ?? null,
        })),
        days: await dailyMemoryDaysForSlugs(engine, opts.sourceId, unique, { signal: opts.signal }),
      };
      await bank([`before:${JSON.stringify(prior)}`]);
    },
    async touched(slugs: string[]) {
      const unique = [...new Set(slugs.filter(Boolean))];
      if (unique.length) await bank(unique.map(slug => `slug:${slug}`));
    },
    async finish() {
      try {
        opts.signal?.throwIfAborted();
        const rows: Array<{ fingerprint: string; value: string }> = [];
        for (const fingerprint of new Set([key.fingerprint, legacyFingerprint])) {
          let cursor = '';
          for (;;) {
            opts.signal?.throwIfAborted();
            const batch = await engine.executeRaw<{ value: string }>(
              `SELECT value FROM (
                 SELECT path AS value FROM op_checkpoint_paths WHERE op=$1 AND fingerprint=$2
                 UNION SELECT jsonb_array_elements_text(completed_keys) FROM op_checkpoints WHERE op=$1 AND fingerprint=$2
               ) debt WHERE value>$3 ORDER BY value LIMIT 100`, [key.op, fingerprint, cursor]);
            rows.push(...batch.map(row => ({ ...row, fingerprint })));
            if (batch.length < 100) break;
            cursor = batch[batch.length - 1]!.value;
          }
        }
        const activeForeign = new Set<string>();
        for (const row of rows) {
          if (!row.value.startsWith('{')) continue;
          let wrapped: { origin?: unknown; value?: unknown };
          try { wrapped = JSON.parse(row.value); } catch { continue; }
          if (wrapped && typeof wrapped.origin === 'string' && wrapped.origin && wrapped.origin !== origin
            && wrapped.value === 'running') {
            activeForeign.add(wrapped.origin);
          }
        }
        const slugs = new Set<string>(), days = new Set<string>();
        const prior: Prior[] = [];
        // Preserve still-running foreign origins. Adopt abandoned origins (no
        // running marker) so a retry after a rejected handoff can recover debt.
        const mine: Array<{ fingerprint: string; value: string }> = [];
        for (const row of rows) {
          let value = row.value;
          let rowOrigin: string | null = null;
          if (value.startsWith('{')) {
            const wrapped = JSON.parse(value);
            if (!wrapped || typeof wrapped.origin !== 'string' || !wrapped.origin || typeof wrapped.value !== 'string') throw new Error('Invalid daily-memory transcript origin');
            rowOrigin = wrapped.origin;
            value = wrapped.value;
          }
          if (rowOrigin !== null && activeForeign.has(rowOrigin)) continue;
          mine.push(row);
          if (value === 'running') continue;
          if (value.startsWith('slug:')) slugs.add(value.slice(5));
          else if (value.startsWith('day:')) days.add(value.slice(4));
          else if (value.startsWith('before:')) {
            const parsed = JSON.parse(value.slice(7)) as Prior;
            if (!parsed || !Array.isArray(parsed.targets) || !Array.isArray(parsed.days)
              || !parsed.targets.every(target => target && typeof target.slug === 'string' && target.slug.length > 0
                && (target.revision === null || typeof target.revision === 'string'))
              || !parsed.days.every(day => typeof day === 'string')) {
              throw new Error('Invalid daily-memory transcript ingest checkpoint');
            }
            prior.push(parsed);
          } else throw new Error('Invalid daily-memory transcript checkpoint entry');
        }
        for (const record of prior) {
          opts.signal?.throwIfAborted();
          const current = await engine.executeRaw<{ slug: string; revision: string }>(
            'SELECT slug,knowledge_revision AS revision FROM pages WHERE source_id=$1 AND slug=ANY($2::text[])',
            [opts.sourceId, record.targets.map(target => target.slug)]);
          if (record.targets.some(target => slugs.has(target.slug)
            || (current.find(row => row.slug === target.slug)?.revision ?? null) !== target.revision)) {
            for (const target of record.targets) slugs.add(target.slug);
            for (const day of record.days) days.add(day);
          }
        }
        const recovery = await bank([...slugs].map(slug => `slug:${slug}`));
        for (const day of await dailyMemoryDaysForSlugs(engine, opts.sourceId, [...slugs], { signal: opts.signal })) {
          days.add(day);
        }
        recovery.push(...await bank([...days].map(day => `day:${day}`)));
        mine.push(...recovery.map(value => ({ fingerprint: key.fingerprint, value })));
        if (days.size) {
          const accepted = await queueStandaloneSyncDailyMemory(engine, {
            sourceId: opts.sourceId,
            commit: 'transcripts-ingest',
            days: [...days],
          });
          if (accepted === null) throw new Error('Daily-memory transcript ingest handoff rejected');
        }
        // Retire accepted snapshot/recovery entries for this origin and any
        // abandoned origins we adopted; leave still-running peers alone.
        for (const fingerprint of new Set(mine.map(row => row.fingerprint))) {
          const values = mine.filter(row => row.fingerprint === fingerprint).map(row => row.value);
          for (let start = 0; start < values.length; start += 100) {
            const chunk = values.slice(start, start + 100);
            await engine.executeRawDirect('DELETE FROM op_checkpoint_paths WHERE op=$1 AND fingerprint=$2 AND path=ANY($3::text[])', [key.op, fingerprint, chunk]);
            await engine.executeRawDirect('UPDATE op_checkpoints SET completed_keys=completed_keys-$3::text[] WHERE op=$1 AND fingerprint=$2', [key.op, fingerprint, chunk]);
          }
        }
      } finally {
        // Drop our running marker even when handoff throws so a retry can adopt.
        await clearRunning();
      }
    },
  };
}
