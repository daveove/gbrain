/** Durable date handoff before a standalone sync consumes its Git anchor. */
import { createHash } from 'node:crypto';
import type { BrainEngine } from './engine.ts';
import { currentSubmissionAuthority } from './minions/submission-authority.ts';
import { appendCompleted, clearOpCheckpoint } from './op-checkpoint.ts';
import { resolveCycleTimeZone } from './cycle/cycle-date.ts';
import { dailyMemoryDaysForSlugs, queueStandaloneSyncDailyMemory } from './cycle/daily-memory-followup.ts';

/** Source-scoped full-sync reporting includes tombstones retired by reconciliation. */
export async function readFullSyncAffectedSlugs(engine: BrainEngine, opts: {
  sourceId: string; scope: string; signal?: AbortSignal; paths?: string[];
  acceptsPath?: (path: string) => boolean;
}): Promise<string[]> {
  const slugs: string[] = [];
  let after = '';
  for (;;) {
    opts.signal?.throwIfAborted();
    const rows = await engine.executeRaw<{ slug: string; source_path: string }>(
      `SELECT slug, source_path FROM pages WHERE source_id = $1 AND slug > $2
        AND source_path IS NOT NULL AND ($3 = '' OR starts_with(source_path, $3))
        AND ($4::text[] IS NULL OR source_path = ANY($4::text[]))
        ORDER BY slug LIMIT 100`, [opts.sourceId, after, opts.scope, opts.paths ?? null]);
    for (const row of rows) if (!opts.acceptsPath || opts.acceptsPath(row.source_path)) slugs.push(row.slug);
    if (rows.length < 100) return slugs;
    after = rows[rows.length - 1]!.slug;
  }
}

export async function prepareSyncDailyMemory(engine: BrainEngine, opts: {
  sourceId: string; commit: string; scope: string; paths?: string[];
  acceptsPath?: (path: string) => boolean; signal?: AbortSignal;
  ownerJobId?: number;
  protect?: (key: { op: string; fingerprint: string; kind: 'manifest' }) => Promise<void>;
}) {
  // Retained remote jobs cannot submit descendant maintenance work.
  const authority = currentSubmissionAuthority();
  if (authority && authority.kind !== 'application') return undefined;
  if (opts.ownerJobId !== undefined && (!Number.isSafeInteger(opts.ownerJobId) || opts.ownerJobId <= 0)) {
    throw new Error('Invalid daily-memory cycle owner job');
  }
  const timezone = await resolveCycleTimeZone(engine);
  // Fingerprint is source+scope only. Including the target commit stranded
  // unfinished debt when HEAD moved before accept() (full sync retry).
  const key = { op: 'sync-daily-memory', fingerprint: createHash('sha256')
    .update(JSON.stringify([opts.sourceId, opts.scope])).digest('hex').slice(0, 16) };
  opts.signal?.throwIfAborted();
  await opts.protect?.({ ...key, kind: 'manifest' });
  // Unlike a work-skipping checkpoint, losing this metadata is not recoverable
  // from a hash-skipped retry. Read errors must propagate.
  const saved = await engine.executeRaw<{ path: string }>(
    'SELECT path FROM op_checkpoint_paths WHERE op = $1 AND fingerprint = $2', [key.op, key.fingerprint]);
  const entries = new Set(saved.map(row => row.path));
  const capture = async () => {
    const slugs = new Set([...entries].filter(s => s.startsWith('slug:')).map(s => s.slice(5)));
    for (const slug of await readFullSyncAffectedSlugs(engine, opts)) slugs.add(slug);
    const delta = [...slugs].map(slug => `slug:${slug}`);
    for (const day of await dailyMemoryDaysForSlugs(engine, opts.sourceId, [...slugs], { signal: opts.signal, timezone })) delta.push(`day:${day}`);
    opts.signal?.throwIfAborted();
    const fresh = delta.filter(value => !entries.has(value));
    if (!await appendCompleted(engine, key, fresh)) throw new Error('Daily-memory sync checkpoint unavailable; anchor retained');
    fresh.forEach(value => entries.add(value));
    if (opts.ownerJobId !== undefined) {
      const ownedDays = [...entries].filter(value => value.startsWith('day:'))
        .map(value => JSON.stringify({ jobId: opts.ownerJobId, day: value.slice(4) }));
      const ownerKey = { op: 'autopilot-sync-daily-memory', fingerprint: createHash('sha256')
        .update(opts.sourceId).digest('hex').slice(0, 16) };
      if (!await appendCompleted(engine, ownerKey, ownedDays)) throw new Error('Cycle daily-memory checkpoint unavailable; anchor retained');
    }
  };
  await capture();
  return {
    async accept() {
      await capture();
      opts.signal?.throwIfAborted();
      // The enclosing cycle consumes its source debt through its existing handoff.
      if (opts.ownerJobId !== undefined) return;
      const days = [...entries].filter(value => value.startsWith('day:')).map(value => value.slice(4)).sort();
      const accepted = await queueStandaloneSyncDailyMemory(engine, { sourceId: opts.sourceId, commit: opts.commit, days, timezone });
      opts.signal?.throwIfAborted();
      if (days.length && accepted === null) throw new Error('Daily-memory sync handoff rejected; anchor retained');
    },
    clear: () => clearOpCheckpoint(engine, key),
  };
}
