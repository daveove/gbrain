/**
 * A conflicted coordinated write keeps PageRevisionConflictError's own
 * message, so a caller that never supplied expected_revision is not told its
 * revision went stale (#5659), and since #5385 it also gets its own code
 * (`revision_required`) while a stale revision stays `revision_conflict`.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { OperationError, type OperationContext } from '../src/core/ops/contract.ts';
import { rethrowNamingRevisionSource } from '../src/core/ops/put-page-revision-source.ts';
import { __resetPrivateVisibilityCacheForTests, REMOTE_PRIVATE_PAGES_KEY } from '../src/core/search/private-visibility.ts';

let engine: PGLiteEngine;
const ctx = { remote: true, transport: 'stdio' as const, sourceId: 'default' };
const page = (body: string) => `---\ntitle: Revision example\ntype: note\n---\n${body}`;
const body = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0].text);

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig('schema_pack', 'gbrain-base');
});
afterAll(async () => { await engine.disconnect(); });

test('a missing expected_revision and a stale one report different conflicts', async () => {
  const slug = 'notes/revision-message-example';
  const created = await dispatchToolCall(engine, 'put_page', { slug, content: page('first body') }, ctx);
  expect(created.isError ?? false).toBe(false);
  const before = await engine.readPageSnapshot(slug, { sourceId: 'default' });

  const missing = await dispatchToolCall(engine, 'put_page', { slug, content: page('second body') }, ctx);
  expect(missing.isError).toBe(true);
  // #5385: the missing precondition is the caller's omission, not a race, so it carries its own code.
  expect(body(missing)).toMatchObject({ write_error: 'revision_required',
    message: 'The page already exists; an expected revision is required.' });

  const stale = await dispatchToolCall(engine, 'put_page', { slug, content: page('second body'),
    expected_revision: '11111111-1111-1111-1111-111111111111' }, ctx);
  expect(stale.isError).toBe(true);
  expect(body(stale)).toMatchObject({ write_error: 'revision_conflict',
    message: 'The page changed after it was read. Read its current revision before retrying.' });

  expect(await engine.readPageSnapshot(slug, { sourceId: 'default' })).toEqual(before);
});

// Owner-only is a readable private-page opt-out, not a blanket private filter.
// The dispatch conflict test above does not cover cross-source hints. Exercise
// the existing helper against real snapshots, without another production seam.
test.each([
  { slug: 'notes/private-revision-hint', frontmatter: { visibility: 'private' }, visible: true },
  { slug: 'daily-memory/2026-10-14', frontmatter: { dream_generated: true }, visible: false },
  { slug: 'source-records/revision-example', frontmatter: { dream_generated: true,
    source_record_id: 'synthetic-record', source_record_type: 'meeting', source_record_ref: 'synthetic-ref' }, visible: false },
])('owner-only revision hints disclose only readable sources for $slug', async ({ slug, frontmatter, visible }) => {
  const previous = await engine.getConfig(REMOTE_PRIVATE_PAGES_KEY);
  await engine.setConfig(REMOTE_PRIVATE_PAGES_KEY, 'visible');
  __resetPrivateVisibilityCacheForTests();
  try {
    await engine.putPage(slug, { type: 'note', title: 'Synthetic revision hint', compiled_truth: 'Synthetic body', frontmatter });
    const snapshot = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
    const error = new OperationError('revision_conflict', 'Synthetic revision conflict', 'Original suggestion');
    const hintContext: OperationContext = {
      engine, remote: true, sourceId: 'revision-write-example', config: { engine: engine.kind }, dryRun: false,
      logger: { info() {}, warn() {}, error() {} },
      auth: { token: 'synthetic-token', clientId: 'synthetic-revision-client', scopes: ['read'], sourceId: 'revision-write-example',
        allowedSources: ['revision-write-example', 'default'] },
    };
    await expect(rethrowNamingRevisionSource(hintContext, 'revision-write-example',
      { slug, expected_revision: snapshot.revision }, error)).rejects.toBe(error);
    if (visible) {
      expect(error.suggestion).toContain('in source default');
      expect(error.fix).toMatchObject({ mcp: { tool: 'get_page', arguments: { slug, source_id: 'default', include_content: true } } });
    } else {
      expect(error.suggestion).toBe('Original suggestion');
      expect(error.fix).toBeUndefined();
    }
  } finally {
    if (previous === null) await engine.unsetConfig(REMOTE_PRIVATE_PAGES_KEY);
    else await engine.setConfig(REMOTE_PRIVATE_PAGES_KEY, previous);
    __resetPrivateVisibilityCacheForTests();
  }
});
