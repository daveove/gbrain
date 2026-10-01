/** Durable daily-memory refresh handoff for transcript ingest (and connectors that reuse it). */
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { appendCompleted, clearOpCheckpoint, type OpCheckpointKey } from '../op-checkpoint.ts';
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
    .update(JSON.stringify([opts.sourceId, opts.runKey])).digest('hex').slice(0, 16) };
  await opts.protect?.(key);
  const bank = async (entries: string[]) => {
    opts.signal?.throwIfAborted();
    if (entries.length && !await appendCompleted(engine, key, entries)) {
      throw new Error('Daily-memory transcript ingest checkpoint unavailable');
    }
  };
  return {
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
      opts.signal?.throwIfAborted();
      const rows = await engine.executeRaw<{ value: string }>(
        `SELECT path AS value FROM op_checkpoint_paths WHERE op=$1 AND fingerprint=$2
         UNION ALL SELECT jsonb_array_elements_text(completed_keys) FROM op_checkpoints WHERE op=$1 AND fingerprint=$2`,
        [key.op, key.fingerprint]);
      const slugs = new Set<string>(), days = new Set<string>();
      const prior: Prior[] = [];
      for (const row of rows) {
        if (row.value.startsWith('slug:')) slugs.add(row.value.slice(5));
        else if (row.value.startsWith('day:')) days.add(row.value.slice(4));
        else if (row.value.startsWith('before:')) {
          const parsed = JSON.parse(row.value.slice(7)) as Prior;
          if (!parsed || !Array.isArray(parsed.targets) || !Array.isArray(parsed.days)
            || !parsed.targets.every(target => target && typeof target.slug === 'string' && target.slug.length > 0
              && (target.revision === null || typeof target.revision === 'string'))
            || !parsed.days.every(day => typeof day === 'string')) {
            throw new Error('Invalid daily-memory transcript ingest checkpoint');
          }
          prior.push(parsed);
        }
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
      await bank([...slugs].map(slug => `slug:${slug}`));
      for (const day of await dailyMemoryDaysForSlugs(engine, opts.sourceId, [...slugs], { signal: opts.signal })) {
        days.add(day);
      }
      await bank([...days].map(day => `day:${day}`));
      if (days.size) {
        const accepted = await queueStandaloneSyncDailyMemory(engine, {
          sourceId: opts.sourceId,
          commit: 'transcripts-ingest',
          days: [...days],
        });
        if (accepted === null) throw new Error('Daily-memory transcript ingest handoff rejected');
      }
      await clearOpCheckpoint(engine, key);
    },
  };
}
