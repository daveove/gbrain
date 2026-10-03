/**
 * Native PostgreSQL regression for pending-link JSONB binding and durable retry.
 * Uses the guarded shared helper's disposable database, an exact source scope,
 * and no ambient configuration changes. PostgreSQL must receive an object
 * envelope for the origin recordset, not a pre-stringified JSON array.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { extractStaleFromDB } from '../../src/commands/extract.ts';
import { loadPendingLinkReferences, pendingLinkReferenceBatches } from '../../src/core/pending-link-references.ts';

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
    const beforePreview = await engine.executeRaw('SELECT slug,knowledge_revision,updated_at,links_extracted_at FROM pages WHERE source_id=$1 ORDER BY slug', [sourceId]);
    expect(await extractStaleFromDB(engine, {
      dryRun: true, jsonMode: true, quiet: true, includeFrontmatter: false,
      sourceIdFilter: sourceId, catchUp: false,
    })).toMatchObject({ staleRemaining: 2, pagesProcessed: 0, linksCreated: 0, timelineCreated: 0 });
    expect(await loadPendingLinkReferences(engine, sourceId)).toEqual(pending);
    expect(await engine.executeRaw('SELECT slug,knowledge_revision,updated_at,links_extracted_at FROM pages WHERE source_id=$1 ORDER BY slug', [sourceId])).toEqual(beforePreview);
    const result = await drain();
    expect(result.pagesProcessed).toBe(2);
    expect(result.staleRemaining).toBe(0);
    expect((await engine.getLinks('people/origin-example', { sourceId }))
      .some(link => link.to_slug === 'people/later-example')).toBe(true);
    expect(await loadPendingLinkReferences(engine, sourceId)).toHaveLength(0);
    expect((await drain()).pagesProcessed).toBe(0);
  }, 60_000);

  for (const qualified of [true, false]) test(`a target-scoped drain wakes a foreign origin without reading its body (qualified=${qualified})`, async () => {
    const engine = fixture.engine;
    const originSource = `pending-origin-native-${qualified}`, targetSource = `pending-target-native-${qualified}`;
    const originSlug = `people/qualified-origin-${qualified}`, targetSlug = `people/qualified-later-${qualified}`;
    await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES($1,$1,'{\"federated\":true}'::jsonb),($2,$2,'{}'::jsonb)", [originSource, targetSource]);
    const scoped = (sourceId: string, dryRun = false) => extractStaleFromDB(engine, {
      dryRun, jsonMode: true, quiet: true, includeFrontmatter: false, sourceIdFilter: sourceId, catchUp: false,
    });
    if (!qualified) await engine.setConfig('sources.default', targetSource);
    await engine.putPage(originSlug, { type: 'person', title: 'Qualified origin fixture',
      compiled_truth: qualified ? `[[${targetSource}:${targetSlug}]]` : `[[${targetSlug}]]` }, { sourceId: originSource });
    await scoped(originSource);
    expect(await loadPendingLinkReferences(engine, originSource)).toHaveLength(1);
    await engine.putPage(targetSlug, { type: 'person', title: 'Qualified target fixture',
      compiled_truth: 'Synthetic fixture' }, { sourceId: targetSource });
    const pending = await loadPendingLinkReferences(engine, originSource);
    expect((await scoped(targetSource, true)).staleRemaining).toBe(2);
    expect(await loadPendingLinkReferences(engine, originSource)).toEqual(pending);
    expect(await engine.countStalePagesForExtraction({ sourceId: originSource })).toBe(0);
    const read = engine.readPageSnapshot;
    engine.readPageSnapshot = async function(...args) {
      if (args[1]?.sourceId === originSource) throw new Error('Target drain must not read foreign origin');
      return read.apply(this, args);
    };
    try { expect((await scoped(targetSource)).pagesProcessed).toBe(1); }
    finally { engine.readPageSnapshot = read; }
    const jobs = await engine.executeRaw<{ data: { sourceId?: string }; status: string }>("SELECT data,status FROM minion_jobs WHERE name='extract'");
    expect(jobs.some(job => job.data.sourceId === originSource && job.status === 'waiting')).toBe(true);
    expect(await engine.countStalePagesForExtraction({ sourceId: originSource })).toBe(1);
    expect(await loadPendingLinkReferences(engine, originSource)).toHaveLength(0);
    expect((await scoped(originSource)).pagesProcessed).toBe(1);
    expect((await engine.getLinks(originSlug, { sourceId: originSource })).some(link =>
      link.to_source_id === targetSource && link.to_slug === targetSlug)).toBe(true);
    expect((await scoped(originSource)).pagesProcessed).toBe(0);
  }, 60_000);

  test('an eager foreign extraction worker observes the stale origin before queue acceptance', async () => {
    const engine = fixture.engine, a = 'pending-eager-origin-native', b = 'pending-eager-target-native';
    await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES($1,$1,'{\"federated\":true}'::jsonb),($2,$2,'{}'::jsonb)", [a,b]);
    await engine.setConfig('link_resolution.cross_source', 'true');
    const scoped = (sourceId: string) => extractStaleFromDB(engine, {
      dryRun: false, jsonMode: true, quiet: true, includeFrontmatter: false, sourceIdFilter: sourceId, catchUp: false,
    });
    await engine.putPage('people/eager-origin', { type: 'person', title: 'Eager origin fixture',
      compiled_truth: '[[people/eager-later]]' }, { sourceId: a });
    await scoped(a);
    await engine.putPage('people/eager-later', { type: 'person', title: 'Eager target fixture',
      compiled_truth: '' }, { sourceId: b });
    const original = MinionQueue.prototype.add;
    let eagerProcessed = 0;
    const add = spyOn(MinionQueue.prototype, 'add').mockImplementation(async function(this: MinionQueue, ...args: Parameters<MinionQueue['add']>) {
      eagerProcessed += (await scoped(a)).pagesProcessed;
      return original.apply(this, args);
    });
    try { expect((await scoped(b)).pagesProcessed).toBe(1); }
    finally { add.mockRestore(); }
    expect(eagerProcessed).toBe(1);
    expect(await loadPendingLinkReferences(engine, a)).toHaveLength(0);
    expect(await engine.countStalePagesForExtraction({ sourceId: a })).toBe(0);
    expect((await engine.getLinks('people/eager-origin', { sourceId: a })).some(link =>
      link.to_source_id === b && link.to_slug === 'people/eager-later')).toBe(true);
  }, 60_000);

  test('registry keyset batches exclude unrelated source origins on PostgreSQL', async () => {
    const engine = fixture.engine;
    const rows = Array.from({ length: 310 }, (_, i) => ({
      key: `internal.pending-links.native-batch-${String(i).padStart(4, '0')}`,
      value: JSON.stringify({ slug: `people/native-fixture-${i}`,
        sourceId: i < 205 ? 'unrelated-native-fixture' : sourceId,
        revision: 'fixture-revision', sourceIncarnation: 'fixture-incarnation', candidates: [] }),
    }));
    await engine.executeRaw(`INSERT INTO config(key,value)
      SELECT key,value FROM jsonb_to_recordset(($1::jsonb)->'rows') AS r(key text,value text)`, [{ rows }]);
    await engine.setConfig('internal.pending-links.native-malformed-text', '{broken');
    await engine.setConfig('internal.pending-links.native-malformed-shape', JSON.stringify({ sourceId, candidates: [] }));
    try {
      const batches = [];
      for await (const batch of pendingLinkReferenceBatches(engine, sourceId)) batches.push(batch);
      expect(batches.flat()).toHaveLength(105);
      expect(batches.every(batch => batch.length <= 100)).toBe(true);
      expect(batches.flat().every(row => row.reference.sourceId === sourceId)).toBe(true);
      expect(new Set(batches.flat().map(row => row.key)).size).toBe(105);
      const expired = pendingLinkReferenceBatches(engine, sourceId, { deadline: Date.now() - 1 });
      expect(await expired.next()).toEqual({ value: { incomplete: true, after: '' }, done: true });
    } finally {
      await engine.executeRaw('DELETE FROM config WHERE key=ANY($1::text[])', [[...rows.map(row => row.key),
        'internal.pending-links.native-malformed-text', 'internal.pending-links.native-malformed-shape']]);
    }
  }, 60_000);

});
