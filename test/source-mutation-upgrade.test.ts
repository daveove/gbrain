import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runPagedMeasure } from '../src/core/graph-usefulness/paged-runner.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { getPGLiteSchema } from '../src/core/pglite-schema.ts';
import { GRAPH_SOURCE_MUTATION_SCHEMA_SQL } from '../src/core/graph-usefulness/schema.ts';
import { MIGRATIONS, runMigrations } from '../src/core/migrate.ts';

async function initializeReal169(engine: PGLiteEngine): Promise<void> {
  const rendered = getPGLiteSchema();
  expect(rendered.split(GRAPH_SOURCE_MUTATION_SCHEMA_SQL)).toHaveLength(2);
  const schema169 = rendered.replace(GRAPH_SOURCE_MUTATION_SCHEMA_SQL, '');
  expect(schema169).not.toContain('source_mutation_generation');
  expect(schema169).not.toContain('migration.source_mutation_generation.modern.170');
  await engine.runMigration(1, schema169);
  const originalMigration = engine.runMigration;
  engine.runMigration = async function(this: PGLiteEngine, version: number, sql: string) {
    if (version === 170) throw new Error('synthetic-stop-before-graph-170');
    return originalMigration.call(this, version, sql);
  };
  try {
    await expect(runMigrations(engine)).rejects.toThrow('synthetic-stop-before-graph-170');
  } finally {
    engine.runMigration = originalMigration;
  }
  expect(await engine.getConfig('version')).toBe('169');
  expect((await engine.executeRaw<{ relation: string | null }>("SELECT to_regclass('public.takes')::text AS relation"))[0]!.relation).toBe('takes');
  expect((await engine.executeRaw<{ relation: string | null }>("SELECT to_regclass('public.source_mutation_generation')::text AS relation"))[0]!.relation).toBeNull();
  expect(await engine.getConfig('migration.source_mutation_generation.modern.170')).toBeNull();
}

describe('legacy graph trigger upgrade', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
  });
  afterAll(async () => {
    await engine.disconnect();
  });

  test('a modern169 brain with legacy graph triggers receives additive170 repair', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'graph-upgrade-'));
    const checkpointPath = join(dir, 'checkpoint.json');
    try {
      await initializeReal169(engine);
      await engine.runMigration(169, readFileSync(new URL('./fixtures/source-mutation-v146.sql', import.meta.url), 'utf8'));
      for (const source of ['upgrade-a', 'upgrade-b']) {
        await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [source]);
        await engine.putPage('notes/endpoint', { type: 'note', title: 'Synthetic endpoint', compiled_truth: 'Synthetic content' }, { sourceId: source });
      }
      await engine.executeRaw("INSERT INTO sources(id,name) VALUES('upgrade-empty','upgrade-empty')");
      const emptyCheckpointPath = join(dir, 'empty-checkpoint.json');
      await runPagedMeasure(engine, { sourceId: 'upgrade-empty', cursor: 0, limit: 1, checkpointPath: emptyCheckpointPath });
      await engine.executeRaw(`INSERT INTO links(from_page_id,to_page_id,link_type,link_source)
        SELECT a.id,b.id,'related_to','manual' FROM pages a,pages b WHERE a.source_id='upgrade-a' AND b.source_id='upgrade-b'`);
      const generation = async (source: string) => BigInt((await engine.executeRaw<{ generation: string }>('SELECT generation FROM source_mutation_generation WHERE source_id=$1', [source]))[0].generation);
      let before = await generation('upgrade-a');
      await engine.executeRaw("UPDATE pages SET last_retrieved_at=now() WHERE source_id='upgrade-a'");
      expect(await generation('upgrade-a')).toBeGreaterThan(before);
      before = await generation('upgrade-a');
      await runPagedMeasure(engine, { sourceId: 'upgrade-a', cursor: 0, limit: 1, checkpointPath });
      await engine.executeRaw("UPDATE pages SET slug='notes/before-upgrade' WHERE source_id='upgrade-b'");
      expect(await generation('upgrade-a')).toBe(before);
      await runPagedMeasure(engine, { sourceId: 'upgrade-a', cursor: 0, limit: 1, checkpointPath });

      expect(await runMigrations(engine)).toEqual({ applied: 1, current: 170 });
      expect(await engine.getConfig('version')).toBe('170');
      await expect(runPagedMeasure(engine, { sourceId: 'upgrade-a', cursor: 0, limit: 1, checkpointPath })).rejects.toThrow(/Corpus mutated/);
      expect(await generation('upgrade-empty')).toBe(1n);
      await expect(runPagedMeasure(engine, { sourceId: 'upgrade-empty', cursor: 0, limit: 1, checkpointPath: emptyCheckpointPath })).rejects.toThrow(/Corpus mutated/);
      before = await generation('upgrade-a');
      await engine.executeRaw("UPDATE pages SET last_retrieved_at=now() WHERE source_id='upgrade-a'");
      expect(await generation('upgrade-a')).toBe(before);
      await engine.executeRaw("UPDATE pages SET slug='notes/after-upgrade' WHERE source_id='upgrade-b'");
      expect(await generation('upgrade-a')).toBe(before + 1n);
      before = await generation('upgrade-a');
      await engine.executeRaw("UPDATE sources SET archived=true WHERE id='upgrade-b'");
      expect(await generation('upgrade-a')).toBe(before + 1n);
      before = await generation('upgrade-a');
      await engine.transaction(async tx => {
        await tx.executeRaw("UPDATE pages SET compiled_truth='Synthetic revised content' WHERE source_id='upgrade-a'");
        await tx.executeRaw("UPDATE pages SET compiled_truth='Synthetic revised again' WHERE source_id='upgrade-a'");
      });
      expect(await generation('upgrade-a')).toBe(before + 1n);
      expect(await engine.executeRaw('SELECT id FROM source_mutation_pending')).toHaveLength(0);
      expect(await runMigrations(engine)).toEqual({ applied: 0, current: 170 });
      before = await generation('upgrade-a');
      await engine.runMigration(170, MIGRATIONS.find(m => m.version === 170)!.sql);
      expect(await generation('upgrade-a')).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});


describe('fresh corrected schema replay', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
  });
  afterAll(async () => {
    await engine.disconnect();
  });

  test('fresh corrected schema does not fabricate a legacy expiry on migration replay', async () => {
    await engine.initSchema();
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES('fresh-empty','fresh-empty')");
    const rowsBefore = await engine.executeRaw('SELECT source_id,generation FROM source_mutation_generation ORDER BY source_id');
    await engine.setConfig('version', '169');
    expect(await runMigrations(engine)).toEqual({ applied: 1, current: 170 });
    expect(await engine.executeRaw('SELECT source_id,generation FROM source_mutation_generation ORDER BY source_id')).toEqual(rowsBefore);
    expect(await engine.getConfig('migration.source_mutation_generation.modern.170')).toBe('installed');
    expect(await runMigrations(engine)).toEqual({ applied: 0, current: 170 });
  }, 30000);
});


describe('modern169 state preservation', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
  });
  afterAll(async () => {
    await engine.disconnect();
  });

  test('real modern169 schema without graph tables upgrades without changing transcript OAuth or persistence state', async () => {
    await initializeReal169(engine);
    await engine.executeRaw(`INSERT INTO extract_atoms_transcript_state(source_id,file_path,content_hash,fail_count,tombstoned)
      VALUES('default','synthetic/transcript.jsonl','synthetic-hash',3,true)`);
    await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_name,source_id,allowed_operations,grant_revision)
      VALUES('synthetic-upgrade-client','Synthetic client','default',ARRAY['query'],7)`);
    await engine.executeRaw("INSERT INTO persistence_counters(key,outstanding_count,intent_bytes,lifetime_ids,terminal_bytes) VALUES('synthetic-upgrade',2,16,4,8)");
    const snapshot = async () => ({
      transcripts: await engine.executeRaw('SELECT * FROM extract_atoms_transcript_state'),
      oauth: await engine.executeRaw('SELECT * FROM oauth_clients'),
      brain: await engine.executeRaw('SELECT * FROM persistence_brain'),
      counters: await engine.executeRaw('SELECT * FROM persistence_counters'),
    });
    const before = await snapshot();
    expect(await runMigrations(engine)).toEqual({ applied: 1, current: 170 });
    expect(await snapshot()).toEqual(before);
    expect((await engine.executeRaw<{ relation: string | null }>("SELECT to_regclass('public.source_mutation_generation')::text AS relation"))[0]!.relation).toBe('source_mutation_generation');
    expect(await engine.getConfig('migration.source_mutation_generation.modern.170')).toBe('installed');
    expect(await runMigrations(engine)).toEqual({ applied: 0, current: 170 });
    expect(await snapshot()).toEqual(before);
  }, 30000);
});


describe('fresh bootstrap before alias migrations', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
  });
  afterAll(async () => {
    await engine.disconnect();
  });

  test('bootstrap tolerates absent alias tables and additive170 installs their mutation guards', async () => {
    let bootstrap = getPGLiteSchema();
    for (const table of ['page_aliases', 'slug_aliases']) {
      const tableSql = new RegExp(String.raw`CREATE TABLE IF NOT EXISTS ${table} \([\s\S]*?\n\);`, 'g');
      expect(bootstrap.match(tableSql)).toHaveLength(1);
      bootstrap = bootstrap.replace(tableSql, '');
      const indexSql = new RegExp(String.raw`CREATE INDEX IF NOT EXISTS ${table}_[a-z_]+\n  ON ${table}[^;]+;`, 'g');
      expect(bootstrap.match(indexSql)?.length).toBe(table === 'page_aliases' ? 2 : 1);
      bootstrap = bootstrap.replace(indexSql, '');
    }
    await engine.runMigration(1, bootstrap);
    expect(await engine.executeRaw("SELECT to_regclass('public.page_aliases')::text AS page_aliases, to_regclass('public.slug_aliases')::text AS slug_aliases"))
      .toEqual([{ page_aliases: null, slug_aliases: null }]);
    const report = await runMigrations(engine);
    expect(report.current).toBe(170);
    expect(report.applied).toBeGreaterThan(0);
    const triggers = await engine.executeRaw<{ name: string }>("SELECT tgname AS name FROM pg_trigger WHERE tgname LIKE 'source_mutation_%aliases_%' ORDER BY tgname");
    expect(triggers.map(row => row.name)).toEqual(['page_aliases', 'slug_aliases'].flatMap(table => ['delete', 'insert', 'update'].map(kind => `source_mutation_${table}_${kind}`)));
    await engine.putPage('notes/target', { type: 'note', title: 'Synthetic target', compiled_truth: 'Synthetic content' });
    const generation = async () => BigInt((await engine.executeRaw<{ generation: string }>("SELECT COALESCE((SELECT generation FROM source_mutation_generation WHERE source_id='default'),0)::text AS generation"))[0]!.generation);
    let before = await generation();
    await engine.executeRaw("INSERT INTO page_aliases(source_id,alias_norm,slug) VALUES('default','synthetic alias','notes/target')");
    expect(await generation()).toBe(before + 1n);
    before = await generation();
    await engine.executeRaw("INSERT INTO slug_aliases(source_id,alias_slug,canonical_slug) VALUES('default','notes/old','notes/target')");
    expect(await generation()).toBe(before + 1n);
    expect(await runMigrations(engine)).toEqual({ applied: 0, current: 170 });
  }, 30000);
});
