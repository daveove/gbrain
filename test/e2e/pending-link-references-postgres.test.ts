/**
 * Native PostgreSQL regression for pending-link JSONB binding and durable retry.
 * Uses the guarded shared helper's disposable database, an exact source scope,
 * and no ambient configuration changes. PostgreSQL must receive an object
 * envelope for the origin recordset, not a pre-stringified JSON array.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { extractStaleFromDB } from '../../src/commands/extract.ts';
import { loadPendingLinkReferences } from '../../src/core/pending-link-references.ts';

(process.env.DATABASE_URL ? describe : describe.skip)('pending link references on PostgreSQL', () => {
  let fixture: Awaited<ReturnType<typeof isolatedPersistencePostgres>>;
  const sourceId = 'pending-link-native-example';
  beforeAll(async () => {
    fixture = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    await fixture.engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
  }, 120_000);
  afterAll(async () => {
    if (!fixture) return;
    try {
      await disposePersistenceConsumer(fixture.engine);
      for (const row of await loadPendingLinkReferences(fixture.engine, sourceId))
        await fixture.engine.executeRaw('DELETE FROM config WHERE key=$1 AND value=$2', [row.key, row.value]);
      await fixture.engine.executeRaw('DELETE FROM sources WHERE id=$1', [sourceId]);
    } finally { await fixture.close(); }
  });

  test('missing targets stamp, survive reconnect, resolve once, and stop retrying', async () => {
    const engine = fixture.engine;
    const drain = () => extractStaleFromDB(engine, {
      dryRun: false, jsonMode: true, quiet: true, includeFrontmatter: false,
      sourceIdFilter: sourceId, catchUp: false,
    });
    await engine.putPage('people/origin-example', {
      type: 'person', title: 'Origin example', compiled_truth: '[[people/later-example]]',
    }, { sourceId });
    expect((await drain()).staleRemaining).toBe(0);
    const pending = await loadPendingLinkReferences(engine, sourceId);
    expect(pending).toHaveLength(1);

    await engine.disconnect();
    await engine.connect({ database_url: fixture.databaseUrl, poolSize: 2 });
    expect(await loadPendingLinkReferences(engine, sourceId)).toEqual(pending);
    // This dormant drain executes the native JSONB origin recordset query.
    expect((await drain()).pagesProcessed).toBe(0);

    await engine.putPage('people/later-example', {
      type: 'person', title: 'Later example', compiled_truth: 'A later target.',
    }, { sourceId });
    const result = await drain();
    expect(result.pagesProcessed).toBe(2);
    expect(result.staleRemaining).toBe(0);
    expect((await engine.getLinks('people/origin-example', { sourceId }))
      .some(link => link.to_slug === 'people/later-example')).toBe(true);
    expect(await loadPendingLinkReferences(engine, sourceId)).toHaveLength(0);
    expect((await drain()).pagesProcessed).toBe(0);
  }, 60_000);
});
