/** Standalone imports bank prior dates before writes and accept refresh work before bookmarks. */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, lstatSync } from 'node:fs';
import type { BrainEngine } from './engine.ts';
import { parseMarkdown } from './markdown.ts';
import { MAX_FILE_SIZE } from './import-file.ts';
import { isMarkdownFilePath, isCodeFilePath, slugifyPath, slugifyCodePath } from './sync.ts';
import { appendCompleted, type OpCheckpointKey } from './op-checkpoint.ts';
import { DAILY_MEMORY_SOURCE_ID } from './cycle/daily-memory.ts';
import { dailyMemoryDaysForSlugs, queueStandaloneSyncDailyMemory } from './cycle/daily-memory-followup.ts';

type Prior = { targets: Array<{ slug: string; revision: string | null }>; days: string[] };

/** Active-origin lease window; empty finishes adopt foreign debt only after expiry. */
const LIVE_TTL_MS = 30 * 60 * 1000;

export async function createImportDailyMemory(engine: BrainEngine, opts: {
  sourceId: string; dir: string; commit?: string; signal?: AbortSignal;
  protect?: (key: OpCheckpointKey) => Promise<void>;
}) {
  if (opts.sourceId === DAILY_MEMORY_SOURCE_ID) return undefined;
  const key = { op: 'import-daily-memory', fingerprint: createHash('sha256')
    .update(JSON.stringify([opts.sourceId, opts.dir])).digest('hex').slice(0, 16) };
  // Per-invocation origin so identical before:/slug: values from concurrent
  // imports do not collapse under appendCompleted's ON CONFLICT DO NOTHING.
  const origin = randomUUID();
  await opts.protect?.(key);
  const bank = async (entries: string[]) => {
    opts.signal?.throwIfAborted();
    const wrapped = entries.map(value => JSON.stringify({ origin, value }));
    if (wrapped.length && !await appendCompleted(engine, key, wrapped)) {
      throw new Error('Daily-memory import checkpoint unavailable');
    }
    return wrapped;
  };
  const clearOwnLive = async () => {
    await engine.executeRawDirect(
      `DELETE FROM op_checkpoint_paths WHERE op=$1 AND fingerprint=$2
         AND path::jsonb->>'origin'=$3 AND path::jsonb->>'value' LIKE 'live:%'`,
      [key.op, key.fingerprint, origin]);
    await engine.executeRawDirect(
      `UPDATE op_checkpoints SET completed_keys=(
         SELECT COALESCE(jsonb_agg(to_jsonb(elem)), '[]'::jsonb)
         FROM jsonb_array_elements_text(COALESCE(completed_keys, '[]'::jsonb)) AS elem
         WHERE NOT (elem::jsonb->>'origin'=$3 AND elem::jsonb->>'value' LIKE 'live:%')
       ), updated_at=now()
       WHERE op=$1 AND fingerprint=$2`,
      [key.op, key.fingerprint, origin]);
  };
  const touchLive = async () => {
    opts.signal?.throwIfAborted();
    await clearOwnLive();
    const wrapped = JSON.stringify({ origin, value: `live:${new Date().toISOString()}` });
    if (!await appendCompleted(engine, key, [wrapped])) {
      throw new Error('Daily-memory import checkpoint unavailable');
    }
  };
  // Lease marks this origin live so an empty peer finish cannot retire our banks.
  await touchLive();
  return {
    /** Refresh the live lease so peers keep treating this origin as active. */
    async renew() { await touchLive(); },
    /** Drop the live lease without settling debt (abort / early exit). */
    async release() { await clearOwnLive(); },
    async before(filePath: string, relativePath: string) {
      opts.signal?.throwIfAborted();
      const expected = isCodeFilePath(relativePath) ? slugifyCodePath(relativePath) : slugifyPath(relativePath);
      const names = new Set(expected ? [expected] : []);
      if (isMarkdownFilePath(relativePath)) {
        // Match importFromFile: skip oversized bodies so prior-slug discovery cannot stall workers.
        const file = lstatSync(filePath);
        if (file.isFile() && !file.isSymbolicLink() && file.size <= MAX_FILE_SIZE) {
          const parsed = parseMarkdown(readFileSync(filePath, 'utf8'), relativePath);
          if (parsed.slug && (!expected || slugifyPath(parsed.slug) === expected)) names.add(parsed.slug);
        }
      }
      const existing = await engine.executeRaw<{ slug: string; revision: string }>(
        'SELECT slug,knowledge_revision AS revision FROM pages WHERE source_id=$1 AND (slug=ANY($2::text[]) OR source_path=$3)',
        [opts.sourceId, [...names], relativePath]);
      for (const row of existing) names.add(row.slug);
      const prior: Prior = { targets: [...names].map(slug => ({ slug,
        revision: existing.find(row => row.slug === slug)?.revision ?? null })),
        days: await dailyMemoryDaysForSlugs(engine, opts.sourceId, [...names], { signal: opts.signal }) };
      await touchLive();
      await bank([`before:${JSON.stringify(prior)}`]);
    },
    async imported(slug: string) {
      await touchLive();
      await bank([`slug:${slug}`]);
    },
    async finish() {
      opts.signal?.throwIfAborted();
      try {
        // Unlike loadOpCheckpoint's best-effort resume contract, lost daily debt must fail closed.
        // Keyset batches: a large import can bank one before: per file.
        const rows: Array<{ value: string }> = [];
        let cursor = '';
        for (;;) {
          opts.signal?.throwIfAborted();
          const batch = await engine.executeRaw<{ value: string }>(
            `SELECT value FROM (
               SELECT path AS value FROM op_checkpoint_paths WHERE op=$1 AND fingerprint=$2
               UNION SELECT jsonb_array_elements_text(completed_keys) FROM op_checkpoints WHERE op=$1 AND fingerprint=$2
             ) debt WHERE value>$3 ORDER BY value LIMIT 100`,
            [key.op, key.fingerprint, cursor]);
          rows.push(...batch);
          if (batch.length < 100) break;
          cursor = batch[batch.length - 1]!.value;
        }
        // Snapshot before recovery banks. Retire only snapshot∪recovery so a
        // concurrent import's later origin-tagged banks survive.
        const slugs = new Set<string>(), days = new Set<string>();
        const prior: Prior[] = [];
        const mine: string[] = [];
        const foreign: string[] = [];
        const liveByOrigin = new Map<string, number>();
        for (const row of rows) {
          let value = row.value;
          let rowOrigin: string | null = null;
          if (value.startsWith('{')) {
            let wrapped: { origin?: unknown; value?: unknown };
            try { wrapped = JSON.parse(value); } catch { throw new Error('Invalid daily-memory import checkpoint'); }
            if (!wrapped || typeof wrapped.origin !== 'string' || !wrapped.origin || typeof wrapped.value !== 'string') {
              throw new Error('Invalid daily-memory import origin');
            }
            rowOrigin = wrapped.origin;
            value = wrapped.value;
          }
          if (value.startsWith('live:')) {
            const stamped = Date.parse(value.slice(5));
            if (!Number.isNaN(stamped) && rowOrigin) {
              const prev = liveByOrigin.get(rowOrigin) ?? 0;
              if (stamped > prev) liveByOrigin.set(rowOrigin, stamped);
            }
            if (rowOrigin === null || rowOrigin === origin) mine.push(row.value);
            else foreign.push(row.value);
            continue;
          }
          // Track own vs foreign; day discovery uses every origin.
          if (rowOrigin === null || rowOrigin === origin) mine.push(row.value);
          else foreign.push(row.value);
          if (value.startsWith('slug:')) slugs.add(value.slice(5));
          else if (value.startsWith('day:')) days.add(value.slice(4));
          else if (value.startsWith('before:')) {
            const parsed = JSON.parse(value.slice(7)) as Prior;
            if (!parsed || !Array.isArray(parsed.targets) || !Array.isArray(parsed.days)
              || !parsed.targets.every(target => target && typeof target.slug === 'string' && target.slug.length > 0 && (target.revision === null || typeof target.revision === 'string'))
              || !parsed.days.every(day => typeof day === 'string')) throw new Error('Invalid daily-memory import checkpoint');
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
        // Bank concrete slugs before discovery, so a discovery outage survives hash-skipped retries.
        const recovery = await bank([...slugs].map(slug => `slug:${slug}`));
        for (const day of await dailyMemoryDaysForSlugs(engine, opts.sourceId, [...slugs], { signal: opts.signal })) days.add(day);
        recovery.push(...await bank([...days].map(day => `day:${day}`)));
        if (days.size) {
          const accepted = await queueStandaloneSyncDailyMemory(engine, { sourceId: opts.sourceId, commit: opts.commit ?? 'import', days: [...days] });
          if (accepted === null) throw new Error('Daily-memory import handoff rejected');
        }
        const unwrap = (path: string) => {
          if (!path.startsWith('{')) return { origin: null as string | null, value: path };
          try {
            const wrapped = JSON.parse(path) as { origin?: unknown; value?: unknown };
            if (typeof wrapped.origin === 'string' && typeof wrapped.value === 'string') {
              return { origin: wrapped.origin, value: wrapped.value };
            }
          } catch { /* fall through */ }
          return { origin: null as string | null, value: path };
        };
        const ownDebt = mine.some(path => {
          const value = unwrap(path).value;
          return value.startsWith('before:') || value.startsWith('slug:') || value.startsWith('day:');
        });
        const now = Date.now();
        const abandonedForeign = foreign.filter(path => {
          const rowOrigin = unwrap(path).origin;
          if (!rowOrigin) return true;
          const stamped = liveByOrigin.get(rowOrigin);
          if (stamped == null) return true;
          return now - stamped > LIVE_TTL_MS;
        });
        // Own debt: retire only this origin. Empty finish: adopt foreign only when its live lease expired.
        const retire = [...new Set([...(ownDebt ? mine : [...mine, ...abandonedForeign]), ...recovery])];
        for (let start = 0; start < retire.length; start += 100) {
          const chunk = retire.slice(start, start + 100);
          await engine.executeRawDirect(
            'DELETE FROM op_checkpoint_paths WHERE op=$1 AND fingerprint=$2 AND path=ANY($3::text[])',
            [key.op, key.fingerprint, chunk]);
          await engine.executeRawDirect(
            'UPDATE op_checkpoints SET completed_keys=completed_keys-$3::text[] WHERE op=$1 AND fingerprint=$2',
            [key.op, key.fingerprint, chunk]);
        }
        const left = await engine.executeRaw<{ n: number }>(
          `SELECT COUNT(*)::int AS n FROM (
             SELECT path FROM op_checkpoint_paths WHERE op=$1 AND fingerprint=$2
             UNION ALL SELECT jsonb_array_elements_text(completed_keys) FROM op_checkpoints WHERE op=$1 AND fingerprint=$2
           ) debt`, [key.op, key.fingerprint]);
        if ((left[0]?.n ?? 0) === 0) {
          await engine.executeRawDirect('DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [key.op, key.fingerprint]);
        }
      } catch (error) {
        // Drop our live lease on failure so a peer/retry can adopt remaining debt.
        try { await clearOwnLive(); } catch { /* prefer original error */ }
        throw error;
      }
    },
  };
}
