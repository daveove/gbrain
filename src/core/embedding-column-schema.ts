import type { BrainEngine } from './engine.ts';
import type { GBrainConfig } from './config.ts';
import type { EmbeddingColumnConfig, ResolvedColumn } from './types.ts';
import { quoteIdentifier, resolveEmbeddingColumn, getEmbeddingProvenanceColumns, embeddingColumnSignature, EmbeddingColumnConfigError } from './search/embedding-column.ts';
import { hnswIndexExpected } from './vector-index.ts';

/** Validate every present field before taking any schema-changing lock. */
async function independentLayoutComplete(engine: Pick<BrainEngine, 'executeRaw'>, column: ResolvedColumn, allowMissing = false): Promise<boolean> {
  if (!column.provenance) throw new Error(`Column ${column.name} does not have independent provenance`);
  const proof = getEmbeddingProvenanceColumns(column);
  const rows = await engine.executeRaw<{ relation: string; name: string; type: string }>(
    `SELECT c.relname AS relation,a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type
     FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname=current_schema() AND c.relname IN ('content_chunks','pages') AND a.attnum>0 AND NOT a.attisdropped`);
  const types = new Map(rows.map(row => [`${row.relation}.${row.name}`, row.type]));
  const expected = [
    ['content_chunks', column.name, `${column.type}(${column.dimensions})`],
    ['content_chunks', proof.model, 'text'], ['content_chunks', proof.textHash, 'text'],
    ['content_chunks', proof.inputHash, 'text'], ['content_chunks', proof.embeddedAt, 'timestamp with time zone'],
    ['content_chunks', proof.pendingSince, 'timestamp with time zone'], ['pages', proof.pageSignature, 'text'],
  ];
  let complete = true;
  for (const [relation, name, type] of expected) {
    const actual = types.get(`${relation}.${name}`);
    if (actual === undefined && allowMissing) { complete = false; continue; }
    if (actual !== type) {
      throw new Error(`Independent column ${column.name} is not initialized: ${relation}.${name} must be ${type}`);
    }
  }
  return complete;
}

/** Fail closed before inference if the persisted vector/provenance layout is incomplete. */
export async function assertIndependentColumnInitialized(engine: Pick<BrainEngine, 'executeRaw'>, column: ResolvedColumn): Promise<void> {
  await independentLayoutComplete(engine, column);
}

function parseRegistry(value: string): Record<string, EmbeddingColumnConfig> {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch { /* Report malformed JSON through the same registry error contract as invalid shapes. */ }
  throw new EmbeddingColumnConfigError('embedding_columns', 'registry', 'must be a valid JSON object');
}

async function persistedRegistry(engine: Pick<BrainEngine, 'executeRaw'>, value?: string): Promise<Record<string, EmbeddingColumnConfig>> {
  if (value === undefined) return {};
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch { /* Legacy malformed registries remain repairable when no private space exists. */ }
  const [layout] = await engine.executeRaw<{ independent: boolean }>(`SELECT EXISTS (
    SELECT 1 FROM pg_attribute a WHERE a.attrelid='content_chunks'::regclass AND NOT a.attisdropped
      AND a.attname ~ '^.+_embedding_input_hash$' AND EXISTS (
        SELECT 1 FROM pg_attribute p WHERE p.attrelid='pages'::regclass AND NOT p.attisdropped
          AND p.attname=left(a.attname,length(a.attname)-21)||'_signature')) AS independent`);
  if (layout?.independent !== false) throw new EmbeddingColumnConfigError('embedding_columns', 'registry',
    'cannot safely erase a corrupt registry with independent spaces; restore its recorded independent registrations first');
  return {};
}

function resolveIndependentRegistration(name: string, entry: EmbeddingColumnConfig,
  registry: Record<string, EmbeddingColumnConfig>): ResolvedColumn {
  if (entry.provenance !== 'independent') throw new Error('Initialization requires provenance: independent');
  const column = resolveEmbeddingColumn({ embeddingColumn: name }, { embedding_columns: { [name]: entry } } as GBrainConfig);
  if (Object.hasOwn(registry, name)) {
    const existing = resolveEmbeddingColumn({ embeddingColumn: name }, { embedding_columns: registry } as GBrainConfig);
    if (!existing.provenance || existing.type !== column.type || embeddingColumnSignature(existing) !== embeddingColumnSignature(column)
      || existing.queryPrefix !== column.queryPrefix) throw new Error(`Refusing to change existing embedding space ${name}`);
  }
  return column;
}

async function initializeIndependentLayout(engine: Pick<BrainEngine, 'executeRaw'>, column: ResolvedColumn): Promise<void> {
  if (!await independentLayoutComplete(engine, column, true)) {
    const proof = getEmbeddingProvenanceColumns(column);
    await engine.executeRaw(`ALTER TABLE content_chunks
      ADD COLUMN IF NOT EXISTS ${quoteIdentifier(column.name)} ${column.type}(${column.dimensions}),
      ADD COLUMN IF NOT EXISTS ${quoteIdentifier(proof.model)} text,
      ADD COLUMN IF NOT EXISTS ${quoteIdentifier(proof.textHash)} text,
      ADD COLUMN IF NOT EXISTS ${quoteIdentifier(proof.inputHash)} text,
      ADD COLUMN IF NOT EXISTS ${quoteIdentifier(proof.embeddedAt)} timestamptz,
      ADD COLUMN IF NOT EXISTS ${quoteIdentifier(proof.pendingSince)} timestamptz`);
    await engine.executeRaw(`ALTER TABLE pages ADD COLUMN IF NOT EXISTS ${quoteIdentifier(proof.pageSignature)} text`);
    await assertIndependentColumnInitialized(engine, column);
  }
  if (hnswIndexExpected(column.type, column.dimensions)) {
    const indexName = `idx_chunks_${column.name}`;
    const [index] = await engine.executeRaw<{ indexed: boolean }>(`SELECT EXISTS (
      SELECT 1 FROM pg_indexes WHERE schemaname=current_schema() AND tablename='content_chunks' AND indexname=$1) AS indexed`, [indexName]);
    if (!index?.indexed) await engine.executeRaw(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(indexName)}
      ON content_chunks USING hnsw (${quoteIdentifier(column.name)} ${column.type}_cosine_ops)`);
  }
}

/** Add a separate space atomically; never migrate, rebuild, or select the primary space. */
export async function initializeIndependentEmbeddingColumn(engine: BrainEngine, name: string, entry: EmbeddingColumnConfig): Promise<ResolvedColumn> {
  return engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('lock_timeout','2000ms',true),set_config('statement_timeout','60s',true)");
    await tx.executeRaw('LOCK TABLE config IN SHARE ROW EXCLUSIVE MODE');
    const rows = await tx.executeRaw<{ value: string }>("SELECT value FROM config WHERE key='embedding_columns'");
    const registry = await persistedRegistry(tx, rows[0]?.value);
    const column = resolveIndependentRegistration(name, entry, registry);
    await initializeIndependentLayout(tx, column);
    registry[name] = entry;
    await tx.executeRaw(`INSERT INTO config(key,value) VALUES ('embedding_columns',$1)
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`, [JSON.stringify(registry)]);
    return column;
  });
}

/** Registry replacement cannot erase or relabel an initialized independent space. */
export async function replaceEmbeddingColumnRegistry(engine: BrainEngine, value: string | null): Promise<number> {
  return engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('lock_timeout','2000ms',true),set_config('statement_timeout','60s',true)");
    await tx.executeRaw('LOCK TABLE config IN SHARE ROW EXCLUSIVE MODE');
    const rows = await tx.executeRaw<{ value: string }>("SELECT value FROM config WHERE key='embedding_columns'");
    const previous = await persistedRegistry(tx, rows[0]?.value);
    const next = value === null ? {} : parseRegistry(value);
    for (const [name, entry] of Object.entries(previous)) {
      if (entry?.provenance === 'independent' && (!Object.hasOwn(next, name) || next[name]?.provenance !== 'independent')) {
        throw new Error(`Refusing to remove independent provenance for ${name}`);
      }
    }
    for (const [name, entry] of Object.entries(next)) {
      if (entry?.provenance !== 'independent') continue;
      await initializeIndependentLayout(tx, resolveIndependentRegistration(name, entry, previous));
    }
    if (value === null) {
      await tx.executeRaw("DELETE FROM config WHERE key='embedding_columns'");
      return rows.length;
    }
    await tx.executeRaw(`INSERT INTO config(key,value) VALUES ('embedding_columns',$1)
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`, [value]);
    return 1;
  });
}
