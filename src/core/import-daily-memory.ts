/** Standalone imports bank prior dates before writes and accept refresh work before bookmarks. */
import { createHash } from 'node:crypto';
import { readFileSync, lstatSync } from 'node:fs';
import type { BrainEngine } from './engine.ts';
import { parseMarkdown } from './markdown.ts';
import { MAX_FILE_SIZE } from './import-file.ts';
import { isMarkdownFilePath, isCodeFilePath, slugifyPath, slugifyCodePath } from './sync.ts';
import { appendCompleted, clearOpCheckpoint, type OpCheckpointKey } from './op-checkpoint.ts';
import { DAILY_MEMORY_SOURCE_ID } from './cycle/daily-memory.ts';
import { dailyMemoryDaysForSlugs, queueStandaloneSyncDailyMemory } from './cycle/daily-memory-followup.ts';

type Prior = { targets: Array<{ slug: string; revision: string | null }>; days: string[] };
export async function createImportDailyMemory(engine: BrainEngine, opts: {
  sourceId: string; dir: string; commit?: string; signal?: AbortSignal;
  protect?: (key: OpCheckpointKey) => Promise<void>;
}) {
  if (opts.sourceId === DAILY_MEMORY_SOURCE_ID) return undefined;
  const key = { op: 'import-daily-memory', fingerprint: createHash('sha256')
    .update(JSON.stringify([opts.sourceId, opts.dir])).digest('hex').slice(0, 16) };
  await opts.protect?.(key);
  const bank = async (entries: string[]) => {
    opts.signal?.throwIfAborted();
    if (entries.length && !await appendCompleted(engine, key, entries)) throw new Error('Daily-memory import checkpoint unavailable');
  };
  return {
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
      await bank([`before:${JSON.stringify(prior)}`]);
    },
    async imported(slug: string) { await bank([`slug:${slug}`]); },
    async finish() {
      opts.signal?.throwIfAborted();
      // Unlike loadOpCheckpoint's best-effort resume contract, lost daily debt must fail closed.
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
      await bank([...slugs].map(slug => `slug:${slug}`));
      for (const day of await dailyMemoryDaysForSlugs(engine, opts.sourceId, [...slugs], { signal: opts.signal })) days.add(day);
      await bank([...days].map(day => `day:${day}`));
      if (days.size) {
        const accepted = await queueStandaloneSyncDailyMemory(engine, { sourceId: opts.sourceId, commit: opts.commit ?? 'import', days: [...days] });
        if (accepted === null) throw new Error('Daily-memory import handoff rejected');
      }
      await clearOpCheckpoint(engine, key);
    },
  };
}
