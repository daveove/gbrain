import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import {
  buildIndexOnline, dropInvalidConcurrentIndex, OnlineIndexInProgressError,
  type OnlineIndexState,
} from '../src/core/schema-migrations/helpers.ts';
import { ensureFactsFtsIndex } from '../src/core/facts/fts-index.ts';
import { factsFtsIndexSql, getFtsLanguage } from '../src/core/fts-language.ts';
import type { Migration } from '../src/core/schema-migrations/types.ts';
import { v179 } from '../src/core/schema-migrations/v179-persistence-request-sync-run-indexes.ts';
import { v219 } from '../src/core/schema-migrations/v219-pages-reconcile-name-indexes.ts';
import { v222 } from '../src/core/schema-migrations/v222-persistence-consumers.ts';
import { v223 } from '../src/core/schema-migrations/v223-persistence-serve-loop-indexes.ts';
import { v231 } from '../src/core/schema-migrations/v231-fact-purge-lookup-indexes.ts';
import { v236 } from '../src/core/schema-migrations/v236-open-loops-counterparty-source.ts';
import { v237 } from '../src/core/schema-migrations/v237-facts-question-recall-indexes.ts';
import { v240 } from '../src/core/schema-migrations/v240-pages-name-lookup-indexes.ts';
import { v241 } from '../src/core/schema-migrations/v241-persistence-request-slug-intent-index.ts';
import { v243 } from '../src/core/schema-migrations/v243-nightly-memory-dependencies.ts';
import { requestIndexesRepair } from '../src/core/repair/request-indexes.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';

// Catalog snapshots exercise deterministic races without connecting to any DB.
const INDEX = { name: 'acceptance_idx', table: 'acceptance_rows', sql: 'CREATE INDEX IF NOT EXISTS acceptance_idx ON acceptance_rows (id)' };
const READY: OnlineIndexState = { valid: true, ready: true, building: false };
const INVALID: OnlineIndexState = { valid: false, ready: false, building: false };
const BUILDING: OnlineIndexState = { valid: false, ready: false, building: true };

function catalogEngine(
  states: Array<OnlineIndexState | undefined>,
  kind: BrainEngine['kind'] = 'postgres',
  onCreate?: () => void,
) {
  const probes: string[] = [];
  const ddl: string[] = [];
  const snapshots = [...states];
  const executeRaw = async <T>(sql: string): Promise<T[]> => {
    if (sql.includes('FROM pg_index')) {
      probes.push(sql);
      if (!snapshots.length) throw new Error('Unexpected catalog probe');
      const state = snapshots.shift();
      return (state ? [state] : []) as T[];
    }
    if (sql.includes('reltuples')) return [{ rows: 12 }] as T[];
    ddl.push(sql);
    onCreate?.();
    return [];
  };
  const engine = {
    kind, executeRaw,
    runMigration: async (_version: number, sql: string) => {
      ddl.push(sql);
      if (sql.startsWith('CREATE INDEX')) onCreate?.();
    },
    withReservedConnection: async <T>(fn: (conn: { executeRaw: typeof executeRaw }) => Promise<T>) => fn({ executeRaw }),
  } as unknown as BrainEngine;
  return { engine, probes, ddl };
}

for (const kind of ['postgres', 'pglite'] as const) {
  describe(`online index validity acceptance (${kind})`, () => {
    test('a VALID + READY present index is a no-op', async () => {
      const f = catalogEngine([READY], kind);
      expect(await buildIndexOnline(f.engine, 231, INDEX)).toBe('present');
      expect(f.ddl).toEqual([]);
      expect(f.probes[0]).toContain('i.indisready AS ready');
    });

    test('a missing index is created and checked for both flags', async () => {
      const f = catalogEngine([undefined, READY], kind);
      expect(await buildIndexOnline(f.engine, 231, INDEX)).toBe('created');
      expect(f.ddl).toEqual([kind === 'postgres' ? INDEX.sql.replace('CREATE INDEX', 'CREATE INDEX CONCURRENTLY') : INDEX.sql]);
      expect(f.probes).toHaveLength(2);
      expect(f.ddl.some(sql => /\b(?:SET|RESET|BEGIN)\b/.test(sql))).toBe(false);
    });

    for (const [valid, ready] of [[false, false], [false, true], [true, false]] as const) {
      test(`an inactive VALID=${valid}, READY=${ready} leftover is rebuilt`, async () => {
        const state = { valid, ready, building: false };
        const f = catalogEngine(kind === 'postgres' ? [state, state, READY] : [state, READY], kind);
        expect(await buildIndexOnline(f.engine, 231, INDEX)).toBe('rebuilt');
        expect(f.ddl[0]).toBe(`DROP INDEX ${kind === 'postgres' ? 'CONCURRENTLY ' : ''}IF EXISTS ${INDEX.name};`);
        expect(f.ddl[1]).toContain('CREATE INDEX');
      });
    }
  });
}

describe('foreign builders and postconditions', () => {
  for (const state of [BUILDING, { ...READY, ready: false, building: true }]) {
    test(`a foreign builder (VALID=${state.valid}) throws a named, actionable error without DDL`, async () => {
      const f = catalogEngine([state]);
      const pending = buildIndexOnline(f.engine, 231, INDEX);
      await expect(pending).rejects.toBeInstanceOf(OnlineIndexInProgressError);
      await expect(pending).rejects.toMatchObject({ name: 'OnlineIndexInProgressError', indexName: INDEX.name });
      await expect(pending).rejects.toThrow(`Index ${INDEX.name}`);
      await expect(pending).rejects.toThrow('rerun after the builder completes: gbrain init --migrate-only');
      expect(f.ddl).toEqual([]);
      expect(f.probes[0]).toContain('p.index_relid IN (i.indexrelid, 0)');
      expect(f.probes[0]).toContain('p.pid <> pg_backend_pid()');
    });
  }

  test('a VALID + READY target is a no-op despite conservative same-table progress', async () => {
    const f = catalogEngine([{ ...READY, building: true }]);
    expect(await buildIndexOnline(f.engine, 231, INDEX)).toBe('present');
    expect(f.ddl).toEqual([]);
  });

  test('a VALID + READY pre-drop target is a no-op despite same-table progress', async () => {
    const f = catalogEngine([INVALID, { ...READY, building: true }]);
    expect(await buildIndexOnline(f.engine, 231, INDEX)).toBe('present');
    expect(f.ddl).toEqual([]);
  });

  test('a VALID + READY post-create target succeeds despite same-table progress', async () => {
    const f = catalogEngine([undefined, { ...READY, building: true }]);
    expect(await buildIndexOnline(f.engine, 231, INDEX)).toBe('created');
    expect(f.ddl).toHaveLength(1);
  });

  test('the pre-drop probe catches a builder that started after the initial probe', async () => {
    const f = catalogEngine([INVALID, BUILDING]);
    await expect(buildIndexOnline(f.engine, 231, INDEX)).rejects.toBeInstanceOf(OnlineIndexInProgressError);
    expect(f.ddl).toEqual([]);
  });

  test('the shared invalid-drop helper never drops a foreign active build', async () => {
    const f = catalogEngine([BUILDING]);
    await expect(dropInvalidConcurrentIndex(f.engine, 231, INDEX.name)).rejects.toBeInstanceOf(OnlineIndexInProgressError);
    expect(f.ddl).toEqual([]);
  });

  test('an index removed before the pre-drop probe is created, not reported as rebuilt', async () => {
    const f = catalogEngine([INVALID, undefined, READY]);
    expect(await buildIndexOnline(f.engine, 231, INDEX)).toBe('created');
    expect(f.ddl).toEqual([INDEX.sql.replace('CREATE INDEX', 'CREATE INDEX CONCURRENTLY')]);
  });

  test('a foreign builder that finishes before the pre-drop probe is a valid no-op', async () => {
    const f = catalogEngine([INVALID, READY]);
    expect(await buildIndexOnline(f.engine, 231, INDEX)).toBe('present');
    expect(f.ddl).toEqual([]);
  });

  test('IF NOT EXISTS losing to a competing builder throws after create, without a cleanup drop', async () => {
    const f = catalogEngine([undefined, BUILDING]);
    await expect(buildIndexOnline(f.engine, 231, INDEX)).rejects.toBeInstanceOf(OnlineIndexInProgressError);
    expect(f.ddl).toEqual([INDEX.sql.replace('CREATE INDEX', 'CREATE INDEX CONCURRENTLY')]);
  });

  for (const state of [undefined, INVALID, { ...READY, ready: false }]) {
    test(`post-create ${state ? `VALID=${state.valid}, READY=${state.ready}` : 'missing'} never succeeds`, async () => {
      const f = catalogEngine([undefined, state]);
      await expect(buildIndexOnline(f.engine, 231, INDEX)).rejects.toThrow('requires VALID and READY');
      const second = catalogEngine([undefined, state]);
      await expect(buildIndexOnline(second.engine, 231, INDEX)).rejects.toThrow('rerun: gbrain init --migrate-only');
      expect(f.ddl).toHaveLength(1);
    });
  }

  test('an owned failed create propagates its error, and its inactive leftover is rebuildable', async () => {
    const failure = new Error('owned build interrupted');
    const failed = catalogEngine([undefined], 'postgres', () => { throw failure; });
    await expect(buildIndexOnline(failed.engine, 231, INDEX)).rejects.toBe(failure);
    const resumed = catalogEngine([INVALID, INVALID, READY]);
    expect(await buildIndexOnline(resumed.engine, 231, INDEX)).toBe('rebuilt');
    expect(resumed.ddl[0]).toStartWith('DROP INDEX CONCURRENTLY');
  });

  test('a caller-supplied native repair hint replaces the fallback on both error paths', async () => {
    const repairCommand = 'gbrain repair request-indexes --apply';
    for (const states of [[BUILDING], [undefined, INVALID]]) {
      const f = catalogEngine(states);
      await expect(buildIndexOnline(f.engine, 241, INDEX, { repairCommand })).rejects.toThrow(repairCommand);
    }
  });
});

function foreignCallerEngine(target: string) {
  const ddl: string[] = [];
  const lang = getFtsLanguage();
  const executeRaw = async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
    if (!sql.includes('FROM pg_index')) throw new Error(`Unexpected query: ${sql}`);
    const name = String(params?.[0]);
    if (name === 'idx_facts_fts' && target === 'idx_facts_fts_next') return [];
    return [{ ...(name === target ? BUILDING : READY), def: factsFtsIndexSql(name, lang) }] as T[];
  };
  const engine = {
    kind: 'postgres', executeRaw,
    runMigration: async (_version: number, sql: string) => { ddl.push(sql); },
    withReservedConnection: async () => { throw new Error('Foreign index must not be rebuilt'); },
    transaction: async () => { throw new Error('Foreign index must not be renamed'); },
  } as unknown as BrainEngine;
  return { engine, ddl };
}

// Every numbered buildIndexOnline caller, including each index in a multi-index
// handler. Rejection is the runner's prerequisite for leaving version unstamped.
const CALLERS: Array<{ migration: Migration; names: string[]; repair?: string }> = [
  { migration: v179, names: ['persistence_requests_sync_run_open', 'persistence_requests_sync_run_committed'], repair: 'request-indexes' },
  { migration: v219, names: ['pages_source_path_name_idx', 'pages_file_uri_name_idx'] },
  { migration: v222, names: ['persistence_requests_committed_watermark'] },
  { migration: v223, names: ['persistence_requests_sync_watermark', 'persistence_requests_compactable'] },
  { migration: v231, names: ['fact_purges_subject_idx', 'fact_purges_all_subjects_idx'] },
  { migration: v236, names: ['open_loops_counterparty_source_idx'] },
  { migration: v237, names: ['idx_facts_fts_next', 'idx_facts_unembedded', 'idx_facts_embedding_model'] },
  { migration: v240, names: ['idx_pages_source_title_lower', 'idx_pages_slug_trgm'], repair: 'page-indexes' },
  { migration: v241, names: ['persistence_requests_slug_intent'], repair: 'request-indexes' },
  { migration: v243, names: ['idx_pages_title_lower_trgm'], repair: 'page-indexes' },
];

for (const { migration, names, repair } of CALLERS) {
  for (const name of names) {
    test(`v${migration.version} cannot resolve while ${name} has a foreign builder`, async () => {
      const f = foreignCallerEngine(name);
      const pending = migration.handler!(f.engine);
      await expect(pending).rejects.toBeInstanceOf(OnlineIndexInProgressError);
      await expect(pending).rejects.toThrow(repair ? `gbrain repair ${repair} --apply` : 'gbrain init --migrate-only');
      expect(f.ddl.some(sql => sql.includes(name) && /(?:DROP|CREATE|ALTER) INDEX/.test(sql))).toBe(false);
    });
  }
}

test('native request repair also rejects a foreign builder with its own command', async () => {
  const name = 'persistence_requests_slug_intent';
  const f = foreignCallerEngine(name);
  const ctx = { engine: f.engine, logger: { info() {} } } as unknown as OperationContext;
  await expect(requestIndexesRepair.apply(ctx, {
    cursor: { phase: 0, id: 1 }, source_id: '(brain)', slug: name, chars: 0, action: 'build',
  })).rejects.toThrow('rerun after the builder completes: gbrain repair request-indexes --apply');
  expect(f.ddl).toEqual([]);
});

test('facts FTS pre-drop protects a builder that starts after its stale-definition probe', async () => {
  const f = catalogEngine([undefined, INVALID, BUILDING]);
  await expect(ensureFactsFtsIndex(f.engine, { lang: getFtsLanguage(), version: 237 }))
    .rejects.toBeInstanceOf(OnlineIndexInProgressError);
  expect(f.ddl).toEqual([]);
});

test('facts FTS never advances the swap when post-create finds a competing builder', async () => {
  const f = catalogEngine([undefined, undefined, undefined, BUILDING]);
  const steps: string[] = [];
  await expect(ensureFactsFtsIndex(f.engine, {
    lang: getFtsLanguage(), version: 237, onStep: async step => { steps.push(step); },
  })).rejects.toBeInstanceOf(OnlineIndexInProgressError);
  expect(steps).toEqual([]);
  expect(f.ddl).toHaveLength(1);
  expect(f.ddl[0]).toStartWith('CREATE INDEX CONCURRENTLY');
});

for (const name of ['idx_facts_fts', 'idx_facts_fts_next', 'idx_facts_fts_old']) {
  test(`facts FTS refuses to drop or swap a foreign ${name} builder`, async () => {
    const f = foreignCallerEngine(name);
    const steps: string[] = [];
    await expect(ensureFactsFtsIndex(f.engine, {
      lang: getFtsLanguage(), version: 237, onStep: async step => { steps.push(step); },
    })).rejects.toBeInstanceOf(OnlineIndexInProgressError);
    expect(f.ddl.some(sql => sql.includes(name))).toBe(false);
    expect(steps).toEqual([]);
  });
}
