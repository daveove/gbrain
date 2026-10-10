import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { authorizeStoredRequest, ownRequestAccessible, submissionAuthority } from '../src/core/persistence/authority.ts';
import { getWriteRequest, admitWrite } from '../src/core/persistence/journal.ts';
import { operationsByName } from '../src/core/operations.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { serializeMarkdown } from '../src/core/markdown.ts';
import { withEnv } from './helpers/with-env.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { requireWritablePage } from '../src/core/ops/context.ts';
import { listWriteRequests, cancelWriteRequest } from '../src/core/persistence/control.ts';

const engines: BrainEngine[] = [];
const roots: string[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const sourceId = 'page-authority-test';
const context = (engine: BrainEngine): OperationContext => ({ engine, config: { engine: engine.kind }, sourceId,
  remote: true, dryRun: false, logger: { info() {}, warn() {}, error() {} } });
const page = (visibility = 'world') => ({ type: 'note', title: 'Example', compiled_truth: 'Example prose', timeline: '', frontmatter: { visibility } });
beforeAll(async () => {
  const local = new PGLiteEngine(); await local.connect({}); await local.initSchema(); engines.push(local);
  if (process.env.DATABASE_URL) {
    const isolated = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(isolated.engine); closePostgres = isolated.close;
  }
  for (const engine of engines) await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test('remote force cannot overwrite a private target or learn its revision', async () => {
  for (const engine of engines) {
    const original = await engine.putPage('private', page('private'), { sourceId });
    await expect(submitPageMutation(context(engine), { operation: 'put_page', params: {
      slug: 'private', content: 'Replacement', force: true, request_id: randomUUID(),
    } })).rejects.toMatchObject({ code: 'page_not_found' });
    expect((await engine.getPage('private', { sourceId }))!.knowledge_revision).toBe(original.knowledge_revision);
  }
});

test('replay and receipt enumeration hide targets that become inaccessible', async () => {
  for (const engine of engines) {
    const request_id = randomUUID(), params = { slug: 'receipt', content: 'Example prose', request_id };
    await submitPageMutation(context(engine), { operation: 'put_page', params });
    const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [sourceId]);
    const auth = await submissionAuthority(context(engine), 'put_page', sourceId, source.incarnation, 'receipt');
    const row = (await getWriteRequest(engine, auth.principal, request_id))!;
    expect(await ownRequestAccessible(context(engine), row)).toBe(true);
    await engine.putPage('receipt', page('private'), { sourceId });
    expect(await ownRequestAccessible(context(engine), row)).toBe(false);
    expect((await listWriteRequests(engine, auth.principal, { sourceId })).requests.some(r => r.id === row.id)).toBe(false);
    await expect(submitPageMutation(context(engine), { operation: 'put_page', params })).rejects.toMatchObject({ code: 'page_not_found' });
  }
});

test('accepted visibility is an immutable ceiling and current policy can narrow it', async () => {
  for (const engine of engines) {
    await engine.putPage('ceiling', page(), { sourceId });
    const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [sourceId]);
    const authority = await submissionAuthority(context(engine), 'put_page', sourceId, source.incarnation, 'ceiling');
    const row = await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId,
      sourceIncarnation: source.incarnation, slug: 'ceiling', requestId: randomUUID(), callerIntent: {}, intent: {} });
    await engine.putPage('ceiling', page('private'), { sourceId });
    await engine.setConfig('search.remote_private_pages', 'visible');
    try {
      await expect(authorizeStoredRequest(engine, row)).rejects.toMatchObject({ code: 'page_not_found' });
      const optedIn = await submissionAuthority(context(engine), 'put_page', sourceId, source.incarnation, 'ceiling');
      expect(optedIn.excludePrivate).toBe(false);
      await engine.setConfig('search.remote_private_pages', 'false');
      await expect(authorizeStoredRequest(engine, { ...row, authority: optedIn })).rejects.toMatchObject({ code: 'page_not_found' });
    } finally {
      await engine.executeRaw("DELETE FROM config WHERE key='search.remote_private_pages'");
      await engine.putPage('ceiling', page(), { sourceId });
      await cancelWriteRequest(engine, authority.principal, row.request_id);
    }
  }
});

test('sandboxed subagents keep intentional database-only writes despite a configured canonical root', async () => {
  for (const engine of engines) {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-subagent-writer-')); roots.push(root);
    const sandboxSource = `sandbox-${randomUUID()}`;
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sandboxSource, root]);
    const result = await submitPageMutation({ ...context(engine), sourceId: sandboxSource, viaSubagent: true, subagentId: 7 }, {
      operation: 'put_page', params: { slug: 'wiki/agents/7/example', content: 'Sandbox example', request_id: randomUUID() },
    });
    expect(result.state).toBe('committed');
    expect(result.persistence).toEqual({ mode: 'database' });
    expect(existsSync(join(root, 'wiki/agents/7/example.md'))).toBe(false);
    const bindings = await engine.executeRaw('SELECT source_id FROM persistence_source_bindings WHERE source_id=$1', [sandboxSource]);
    expect(bindings).toHaveLength(0);
  }
});


test('owner aggregates remain inaccessible under both private opt-outs while local and ordinary private access remain', async () => {
  for (const engine of engines) {
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES('dream','Dream fixture') ON CONFLICT DO NOTHING");
    for (const ownerSource of ['default', 'dream']) {
      const remote = { ...context(engine), sourceId: ownerSource,
        auth: { token: 'fixture', clientId: 'fixture', scopes: ['read', 'write'], allowedSources: [ownerSource] } } as OperationContext;
      const local = { ...remote, remote: false };
      const day = 'daily-memory/2026-09-30', ref = 'source-records/gmail/fixture';
      for (const slug of [day, ref]) {
        const frontmatter = { visibility: 'world', dream_generated: true,
          ...(slug === ref ? { source_record_id: 'fixture', source_record_type: 'gmail', source_record_ref: 'fixture' } : {}) };
        await importFromContent(engine, slug, serializeMarkdown(frontmatter, 'Aggregate fixture evidence', '', {
          type: 'note', title: 'Aggregate fixture', tags: [],
        }), { sourceId: ownerSource, noEmbed: true, forceRechunk: true });
        await engine.createVersion(slug, { sourceId: ownerSource });
        expect((await engine.getVersions(slug, { sourceId: ownerSource })).length).toBeGreaterThan(0);
      }
      await engine.putPage('notes/ordinary-private', page('private'), { sourceId: ownerSource });
      await engine.putPage('daily-memory/2026-09-28', { ...page(), frontmatter: { dream_generated: 'true' } }, { sourceId: ownerSource });
      await engine.setConfig('search.mcp_keyword_only', 'true');
      for (const policy of ['config', 'env']) {
        await engine.setConfig('search.remote_private_pages', policy === 'config' ? 'visible' : 'false');
        await withEnv({ GBRAIN_REMOTE_PRIVATE_PAGES: policy === 'env' ? '1' : undefined }, async () => {
          __resetPrivateVisibilityCacheForTests();
          for (const slug of [day, ref]) {
            await expect(operationsByName.get_page.handler(remote, { slug })).rejects.toMatchObject({ code: 'page_not_found' });
            expect((await operationsByName.get_page.handler(local, { slug }) as { slug: string }).slug).toBe(slug);
            await expect(submitPageMutation(remote, { operation: 'put_page', params: {
              slug, content: 'Marker removed', force: true, request_id: randomUUID(),
            } })).rejects.toMatchObject({ code: 'page_not_found' });
            expect((await engine.getPage(slug, { sourceId: ownerSource }))!.frontmatter.dream_generated).toBe(true);
            expect(await engine.getVersions(slug, { sourceId: ownerSource, excludePrivate: 'owner-only' })).toEqual([]);
          }
          const remoteRows = await operationsByName.list_pages.handler(remote, { limit: 100 }) as { slug: string }[];
          expect(remoteRows.some(row => row.slug === day || row.slug === ref)).toBe(false);
          expect(remoteRows.some(row => row.slug === 'notes/ordinary-private')).toBe(true);
          expect(remoteRows.some(row => row.slug === 'daily-memory/2026-09-28')).toBe(true);
          const searched = await operationsByName.search.handler(remote, { query: 'Aggregate fixture' }) as { slug: string }[];
          expect(searched.some(row => row.slug === day || row.slug === ref)).toBe(false);
          const localSearch = await operationsByName.search.handler(local, { query: 'Aggregate fixture' }) as { slug: string }[];
          expect(localSearch.some(row => row.slug === day)).toBe(true);
          const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [ownerSource]);
          const ordinary = await submissionAuthority(remote, 'put_page', ownerSource, source.incarnation, 'notes/ordinary-private');
          expect(ordinary.excludePrivate).toBe(false);
          const ordinaryWrite = await submitPageMutation(remote, { operation: 'put_page', params: {
            slug: 'notes/ordinary-private', content: '---\nvisibility: private\n---\nOrdinary replacement', force: true, request_id: randomUUID(),
          } });
          expect(ordinaryWrite.state).toBe('committed');
          expect((await operationsByName.get_page.handler(remote, { slug: 'notes/ordinary-privat', fuzzy: true }) as { slug: string }).slug).toBe('notes/ordinary-private');
        });
      }
    }
    await engine.executeRaw("DELETE FROM config WHERE key='search.remote_private_pages'");
    __resetPrivateVisibilityCacheForTests();
  }
}, 120_000);


test('opt-out cannot expose a stored receipt after its target becomes an owner aggregate', async () => {
  for (const engine of engines) {
    const ctx = { ...context(engine), sourceId: 'default' };
    const slug = 'daily-memory/2026-09-27';
    await engine.setConfig('search.remote_private_pages', 'visible');
    try {
      await engine.putPage(slug, page(), { sourceId: 'default' });
      const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation FROM sources WHERE id='default'");
      const authority = await submissionAuthority(ctx, 'put_page', 'default', source.incarnation, slug);
      expect(authority.excludePrivate).toBe(false);
      const row = await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page',
        sourceId: 'default', sourceIncarnation: source.incarnation, slug, requestId: randomUUID(), callerIntent: {}, intent: {} });
      await engine.putPage(slug, { ...page(), frontmatter: { dream_generated: true } }, { sourceId: 'default' });
      expect(await ownRequestAccessible(ctx, row)).toBe(false);
      await expect(authorizeStoredRequest(engine, row)).rejects.toMatchObject({ code: 'page_not_found' });
      expect((await listWriteRequests(engine, authority.principal, { sourceId: 'default' })).requests.some(r => r.id === row.id)).toBe(false);
    } finally {
      await engine.executeRaw("DELETE FROM config WHERE key='search.remote_private_pages'");
    }
  }
});


test('remote create at reserved owner-aggregate identities is rejected; generated path still protected', async () => {
  for (const engine of engines) {
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES('dream','Dream fixture') ON CONFLICT DO NOTHING");
    for (const ownerSource of ['default', 'dream']) {
      const remote = { ...context(engine), sourceId: ownerSource,
        auth: { token: 'fixture', clientId: 'fixture', scopes: ['read', 'write'], allowedSources: [ownerSource] } } as OperationContext;
      const day = `daily-memory/2026-10-02`;
      const ref = 'source-records/gmail/create-block';
      for (const slug of [day, ref]) {
        await expect(submitPageMutation(remote, { operation: 'put_page', params: {
          slug, content: 'Remote mint attempt', request_id: randomUUID(),
        } })).rejects.toMatchObject({ code: 'page_not_found' });
        expect(await engine.getPage(slug, { sourceId: ownerSource })).toBeNull();
      }
      await expect(requireWritablePage(remote, day, 'put_page', 'page', true)).rejects.toMatchObject({ code: 'page_not_found' });
      await expect(requireWritablePage({ ...remote, remote: false }, day, 'put_page', 'page', true)).resolves.toBeUndefined();
      await engine.putPage(day, { ...page(), frontmatter: { dream_generated: true } }, { sourceId: ownerSource });
      await expect(submitPageMutation(remote, { operation: 'put_page', params: {
        slug: day, content: 'Overwrite generated', force: true, request_id: randomUUID(),
      } })).rejects.toMatchObject({ code: 'page_not_found' });
      expect((await engine.getPage(day, { sourceId: ownerSource }))!.frontmatter.dream_generated).toBe(true);
      const ordinarySlug = `notes/remote-ordinary-${randomUUID().slice(0, 8)}`;
      const ordinary = await submitPageMutation(remote, { operation: 'put_page', params: {
        slug: ordinarySlug, content: 'Ordinary remote create', request_id: randomUUID(),
      } });
      expect(ordinary.state).toBe('committed');
    }
  }
}, 120_000);
