import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildBasenameIndex, extractPageLinks, makeResolver, type SlugResolver } from '../src/core/link-extraction.ts';
import { buildLinkManifest, buildManifestContext } from '../src/core/cycle/link-manifest.ts';
import { runPhaseSynthesize, TRIAGE_VERSION } from '../src/core/cycle/synthesize.ts';
import { TIER_DEFAULTS } from '../src/core/model-config.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
let schemaVersion: string;
const sourceId = 'residual-source';
const names = Array.from({ length: 300 }, (_, i) => `name-${i}`);
const content = names.map(name => `[[${name}]]`).join('\n');

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  schemaVersion = (await engine.getConfig('version'))!;
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', schemaVersion);
  await engine.executeRaw(`INSERT INTO sources(id, name, config) VALUES($1, $1, '{}')`, [sourceId]);
  await engine.executeRaw(`INSERT INTO pages(source_id, slug, type, title, compiled_truth)
    SELECT $1, 'topics/name-' || i, 'note', 'Name ' || i, 'A useful topic.' FROM generate_series(0, 299) i`, [sourceId]);
}, 60_000);

afterAll(async () => { await engine.disconnect(); });

function observeReads() {
  const raw = spyOn(engine, 'executeRaw');
  const all = spyOn(engine, 'getAllSlugs');
  return {
    fullReads: () => all.mock.calls.length + raw.mock.calls.filter(([sql]) => /AS slugs FROM pages/.test(String(sql))).length,
    targetedReads: () => raw.mock.calls.filter(([sql]) => /SELECT slug FROM pages WHERE source_id=\$1 AND/.test(String(sql))).length,
    allReads: () => all.mock.calls.length,
    clear() { raw.mockClear(); all.mockClear(); },
    restore() { raw.mockRestore(); all.mockRestore(); },
  };
}

const extract = (resolver: SlugResolver) =>
  extractPageLinks('notes/origin', content, {}, 'note', resolver, { globalBasename: true });

describe('residual source slug reads', () => {
  test('300 bare names preserve extracted links and reuse the full source read across batch runs', async () => {
    const index = buildBasenameIndex(await engine.getAllSlugs({ sourceId }));
    const expected = await extract(makeResolver(engine, { mode: 'batch', sourceId, basenameIndex: async () => index }));
    expect(expected.candidates.filter(candidate => candidate.linkType === 'wikilink_basename').map(candidate => candidate.targetSlug))
      .toEqual(names.map(name => `topics/${name}`));
    const reads = observeReads();
    try {
      expect(await extract(makeResolver(engine, { mode: 'batch', sourceId }))).toEqual(expected);
      expect(reads.targetedReads()).toBe(257);
      expect(reads.fullReads()).toBe(1);
      reads.clear();
      expect(await extract(makeResolver(engine, { mode: 'batch', sourceId }))).toEqual(expected);
      expect(reads.fullReads()).toBe(0);
    } finally { reads.restore(); }
  }, 60_000);

  test('manifest output is byte equal to the full slug build and shares the resolver cache', async () => {
    const slugs = await engine.getAllSlugs({ sourceId });
    const verdict = { entities: ['name-299', 'name-0'], segments: [] };
    const opts = { sourceId, outputRoot: 'wiki' };
    const expected = await buildLinkManifest(engine, { slugs, basenameIndex: buildBasenameIndex(slugs) }, verdict, 'chat.txt', opts);
    const resolver = makeResolver(engine, { mode: 'batch', sourceId });
    for (const name of names) await resolver.resolveBasenameMatches!(name);
    expect(expected.slugs).toEqual(['topics/name-299', 'topics/name-0']);
    const reads = observeReads();
    try {
      for (let run = 0; run < 2; run++) {
        const ctx = await buildManifestContext(engine, sourceId);
        expect(await buildLinkManifest(engine, ctx, verdict, 'chat.txt', opts)).toEqual(expected);
      }
      expect(reads.allReads()).toBe(0);
      expect(reads.fullReads()).toBe(0);
    } finally { reads.restore(); }
  }, 60_000);

  test('the next batch and manifest see inserts and renames made outside the page writer', async () => {
    await buildManifestContext(engine, sourceId);
    await engine.executeRaw(`INSERT INTO pages(source_id, slug, type, title) VALUES($1, 'topics/inserted-name', 'note', 'Inserted')`, [sourceId]);
    await engine.executeRaw(`UPDATE pages SET slug='topics/renamed-name' WHERE source_id=$1 AND slug='topics/name-299'`, [sourceId]);
    const slugs = await engine.getAllSlugs({ sourceId });
    const expected = buildBasenameIndex(slugs);
    const reads = observeReads();
    try {
      const resolver = makeResolver(engine, { mode: 'batch', sourceId });
      for (const name of names.slice(0, 256)) await resolver.resolveBasenameMatches!(name);
      expect(await resolver.resolveBasenameMatches!('inserted-name')).toEqual(['topics/inserted-name']);
      expect(await resolver.resolveBasenameMatches!('name-299')).toEqual([]);
      expect(await resolver.resolveBasenameMatches!('renamed-name')).toEqual(['topics/renamed-name']);
      expect(reads.fullReads()).toBe(1);
      reads.clear();
      const ctx = await buildManifestContext(engine, sourceId);
      expect(ctx.slugs).toEqual(slugs);
      expect(ctx.basenameIndex).toEqual(expected);
      expect(reads.fullReads()).toBe(0);
    } finally { reads.restore(); }
  }, 60_000);

  test('two synthesis phases retain the manifest bytes without another full slug read', async () => {
    const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-residual-brain-'));
    const corpusDir = mkdtempSync(join(tmpdir(), 'gbrain-residual-corpus-'));
    const filePath = join(corpusDir, '2026-08-01-example.txt');
    const transcript = 'User: We discussed name-0 and name-1 and their useful topics.\n'.repeat(100);
    writeFileSync(filePath, transcript);
    const verdict = {
      worth_processing: true, reasons: ['fixture'], score: 0.9, content_type: null,
      segments: [], entities: ['name-0', 'name-1'], model: TIER_DEFAULTS.utility, triage_version: TRIAGE_VERSION,
    };
    await engine.putDreamVerdict(filePath, createHash('sha256').update(transcript).digest('hex'), verdict);
    await engine.setConfig('dream.synthesize.enabled', 'true');
    await engine.setConfig('dream.synthesize.session_corpus_dir', corpusDir);
    await engine.setConfig('dream.synthesize.link_manifest', 'true');
    await engine.setConfig('dream.synthesize.cooldown_hours', '0');
    const slugs = await engine.getAllSlugs({ sourceId });
    const expected = await buildLinkManifest(engine, { slugs, basenameIndex: buildBasenameIndex(slugs) },
      verdict, '2026-08-01-example.txt', { sourceId, outputRoot: 'wiki' });
    const reads = observeReads();
    const add = MinionQueue.prototype.add;
    const cancel = spyOn(MinionQueue.prototype, 'add').mockImplementation(async function (this: MinionQueue, ...args) {
      const job = await add.apply(this, args);
      if (args[0] === 'subagent') {
        await engine.executeRaw(`UPDATE minion_jobs SET status='cancelled', finished_at=now() WHERE id=$1`, [job.id]);
      }
      return job;
    });
    try {
      for (let run = 0; run < 2; run++) {
        const result = await runPhaseSynthesize(engine, { brainDir, sourceId, dryRun: false });
        expect(result.details).toMatchObject({ children_submitted: 1 });
        const jobs = await engine.executeRaw<{ prompt: string }>(
          `SELECT data->>'prompt' AS prompt FROM minion_jobs WHERE name='subagent' ORDER BY id DESC LIMIT 1`);
        expect(jobs[0]!.prompt).toContain(expected.block);
        expect(reads.allReads()).toBe(0);
        if (run === 1) expect(reads.fullReads()).toBe(0);
        reads.clear();
      }
    } finally {
      cancel.mockRestore();
      reads.restore();
    }
  }, 60_000);
});
