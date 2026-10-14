/**
 * #4618: dream discovery reads a session's `.seat.json` sidecar for every
 * corpus file of that session (session-end file, checkpoint segment), never
 * ingests the sidecar as a transcript, and ignores a sidecar whose seat is not
 * a valid label (it would otherwise reach page frontmatter verbatim).
 *
 * Authoring gate: protects the discovery half of the seat contract; the
 * end-to-end stamp test only covers whole-session `.txt` files. No seam.
 */
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { discoverTranscripts } from '../src/core/cycle/transcript-discovery.ts';
import { detectAdapter, type HarnessRoot } from '../src/core/transcripts/detect.ts';
import { buildStatusRows, discoverTranscriptFiles } from '../src/core/transcripts/discover.ts';
import type { SkippedTranscriptRoot } from '../src/core/transcripts/discover.ts';
import { runTranscriptsIngest } from '../src/core/transcripts/ingest.ts';
import { withEnv } from './helpers/with-env.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gb-seat-disc-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const body = (topic: string) => `[user]\nLet us talk about ${topic}.\n\n${'[assistant]\nA long and useful answer.\n\n'.repeat(10)}`;
const sidecar = (sid: string, seat: string) =>
  writeFileSync(join(dir, `${sid}.seat.json`), JSON.stringify({ version: 1, seat, seat_source: 'env', hook_lane: 'workspace', harness: 'claude-code', first_seen: '2026-09-20T00:00:00.000Z' }));

test('every corpus file of a session carries its seat; the sidecar is never a transcript; an invalid seat is ignored', () => {
  writeFileSync(join(dir, 'sess-a.txt'), body('the storage plan'));
  writeFileSync(join(dir, 'sess-a.seg-0123456789abcdef01234567.txt'), body('an earlier window'));
  sidecar('sess-a', 'alice-desk');
  writeFileSync(join(dir, 'sess-b.txt'), body('the budget'));
  sidecar('sess-b', '../Not A Seat');
  writeFileSync(join(dir, 'sess-c.txt'), body('the garden'));

  const found = discoverTranscripts({ corpusDir: dir, minChars: 50 });
  expect(found.map((t) => basename(t.filePath))).toEqual([
    'sess-a.seg-0123456789abcdef01234567.txt', 'sess-a.txt', 'sess-b.txt', 'sess-c.txt',
  ]);
  expect(found.map((t) => t.seat)).toEqual(['alice-desk', 'alice-desk', undefined, undefined]);
});

// Public synthetic sessions: no real home, harness history, engine or provider.
function writeHarnessSession(path: string, format: 'pi' | 'omp' | 'cursor', id: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const timestamp = '2026-10-01T00:00:00.000Z';
  const rows = format === 'cursor'
    ? [
      { role: 'user', message: { content: [{ type: 'text', text: '<timestamp>Thursday, Oct 1, 2026, 12:00 AM (UTC)</timestamp><user_query>Describe a public example.</user_query>' }] } },
      { role: 'assistant', message: { content: [{ type: 'text', text: 'A synthetic example.' }] } },
    ]
    : [
      ...(format === 'omp' ? [{ type: 'title', v: 1, title: 'Public example' }] : []),
      { type: 'session', version: 3, id, timestamp, cwd: '/public/example' },
      { type: 'message', timestamp, message: { role: 'user', content: [{ type: 'text', text: 'Describe a public example.' }] } },
      { type: 'message', timestamp, message: { role: 'assistant', content: [{ type: 'text', text: 'A synthetic example.' }] } },
    ];
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
}

// Bun caches os.homedir() at process start; changing HOME in-process cannot
// exercise canonical roots. Resolve the real defaults in a fresh synthetic HOME.
function rootsInFreshHome(): HarnessRoot[] {
  const child = Bun.spawnSync([process.execPath, '-e',
    `import { harnessRoots } from './src/core/transcripts/detect.ts'; process.stdout.write(JSON.stringify(harnessRoots()));`], {
    cwd: join(import.meta.dir, '..'), env: process.env, stdout: 'pipe', stderr: 'pipe',
  });
  expect(child.exitCode).toBe(0);
  return JSON.parse(Buffer.from(child.stdout).toString());
}

test('default canonical Pi, OMP and Cursor discovery feeds ingest and status without subagent phantoms', async () => {
  await withEnv({
    HOME: dir, HERMES_HOME: undefined, GROK_HOME: undefined,
    GBRAIN_DAILY_MEMORY_PI_ROOT: undefined,
    GBRAIN_DAILY_MEMORY_OMP_ROOT: undefined,
    GBRAIN_DAILY_MEMORY_CURSOR_ROOT: undefined,
  }, async () => {
    const piRoot = join(dir, '.pi', 'agent', 'sessions');
    const ompRoot = join(dir, '.omp', 'agent', 'sessions');
    const cursorRoot = join(dir, '.cursor', 'projects');
    const pi = join(piRoot, 'subagents', '2026-10-01_pi-public.jsonl');
    const omp = join(ompRoot, 'subagents', '2026-10-01_omp-public.jsonl');
    const cursor = join(cursorRoot, 'subagents', 'agent-transcripts', 'cursor-public', 'cursor-public.jsonl');
    writeHarnessSession(pi, 'pi', 'pi-public');
    writeHarnessSession(omp, 'omp', 'omp-public');
    writeHarnessSession(cursor, 'cursor', 'cursor-public');
    writeHarnessSession(join(piRoot, 'subagents', 'pi-public', 'Researcher.jsonl'), 'pi', 'pi-child');
    writeHarnessSession(join(ompRoot, 'subagents', 'omp-public', 'Researcher.jsonl'), 'omp', 'omp-child');
    writeHarnessSession(join(dirname(cursor), 'subagents', 'worker.jsonl'), 'cursor', 'cursor-child');
    writeHarnessSession(join(cursorRoot, 'project-cache.jsonl'), 'cursor', 'not-a-session');
    writeHarnessSession(join(dirname(cursor), 'bookkeeping.jsonl'), 'cursor', 'not-a-session');
    const outside = join(dir, 'unrelated', 'outside.jsonl');
    writeHarnessSession(outside, 'pi', 'outside');
    for (const root of [piRoot, ompRoot]) {
      symlinkSync(outside, join(root, 'subagents', 'linked.jsonl'));
      symlinkSync(dirname(outside), join(root, 'linked-project'));
    }
    const cursorLink = join(cursorRoot, 'subagents', 'agent-transcripts', 'linked-session', 'linked-session.jsonl');
    mkdirSync(dirname(cursorLink), { recursive: true });
    symlinkSync(outside, cursorLink);
    symlinkSync(join(cursorRoot, 'subagents'), join(cursorRoot, 'linked-project'));

    const files = discoverTranscriptFiles(rootsInFreshHome());
    expect(files.map((file) => file.path).sort()).toEqual([pi, omp, cursor].sort());
    const empty = { byHarness: new Map<string, Set<string>>(), pagesScanned: 0 };
    const before = buildStatusRows(files, empty);
    for (const format of ['pi', 'omp', 'cursor'] as const) {
      expect(before.find((row) => row.format === format)).toEqual({
        format, found: 1, importedSessions: 0, gapFiles: 1,
      });
    }
    // Same discovered paths and auto-detection as `transcripts ingest --all`.
    const ingest = await runTranscriptsIngest({} as never, {
      paths: files.map((file) => file.path), sourceId: 'default', dryRun: true,
      userPatternsPath: join(dir, 'no-user-patterns.json'),
    });
    expect(ingest.sessionsSeen).toBe(3);
    expect(ingest.erroredFiles).toBe(0);
    expect(ingest.sessionsErrored).toBe(0);
    expect(ingest.driftFiles).toBe(0);
    expect(ingest.pages.planned).toBe(3);
    const sessions = ingest.files.flatMap((file) => file.sessions);
    expect(sessions.map((session) => session.harness).sort()).toEqual(['cursor', 'omp', 'pi']);
    const imported = {
      byHarness: new Map(sessions.map((session) => [session.harness, new Set([session.sessionId])])),
      pagesScanned: 3,
    };
    for (const row of buildStatusRows(files, imported).filter((row) => ['pi', 'omp', 'cursor'].includes(row.format))) {
      expect([row.found, row.importedSessions, row.gapFiles]).toEqual([1, 1, 0]);
    }
  });
});

test('nightly root overrides relocate discovery and Pi auto-detection without claiming other stores', async () => {
  const piRoot = join(dir, 'relocated-pi');
  const ompRoot = join(dir, 'relocated-omp');
  const cursorRoot = join(dir, 'relocated-cursor');
  await withEnv({
    HOME: dir, HERMES_HOME: undefined, GROK_HOME: undefined,
    GBRAIN_DAILY_MEMORY_PI_ROOT: piRoot,
    GBRAIN_DAILY_MEMORY_OMP_ROOT: ompRoot,
    GBRAIN_DAILY_MEMORY_CURSOR_ROOT: cursorRoot,
  }, async () => {
    const pi = join(piRoot, 'project', 'pi-relocated.jsonl');
    const omp = join(ompRoot, 'project', 'omp-relocated.jsonl');
    const cursor = join(cursorRoot, 'project', 'agent-transcripts', 'cursor-relocated', 'cursor-relocated.jsonl');
    writeHarnessSession(pi, 'pi', 'pi-relocated');
    writeHarnessSession(omp, 'omp', 'omp-relocated');
    writeHarnessSession(cursor, 'cursor', 'cursor-relocated');
    writeHarnessSession(join(dir, '.pi', 'agent', 'sessions', 'project', 'not-selected.jsonl'), 'pi', 'not-selected');
    const files = discoverTranscriptFiles();
    expect(files.map((file) => file.path).sort()).toEqual([pi, omp, cursor].sort());
    for (const file of files) {
      const detected = detectAdapter(file.path);
      expect(detected.ok).toBe(true);
      if (detected.ok) expect(detected.adapter.format).toBe(file.format);
    }
    const openclaw = join(dir, 'other-store', 'project', 'openclaw.jsonl');
    writeHarnessSession(openclaw, 'pi', 'openclaw-public');
    const detected = detectAdapter(openclaw);
    expect(detected.ok && detected.adapter.format).toBe('openclaw');
  });
});

test('empty nightly root overrides retain canonical home roots', async () => {
  await withEnv({
    HOME: dir,
    GBRAIN_DAILY_MEMORY_PI_ROOT: '',
    GBRAIN_DAILY_MEMORY_OMP_ROOT: '',
    GBRAIN_DAILY_MEMORY_CURSOR_ROOT: '',
  }, async () => {
    const roots = rootsInFreshHome();
    expect(roots.find((root) => root.format === 'pi')?.root).toBe(join(dir, '.pi', 'agent', 'sessions'));
    expect(roots.find((root) => root.format === 'omp')?.root).toBe(join(dir, '.omp', 'agent', 'sessions'));
    expect(roots.find((root) => root.format === 'cursor')?.root).toBe(join(dir, '.cursor', 'projects'));
  });
});

test('seat layout exclusions are harness-scoped and reject symlinked discovery roots', () => {
  const root = join(dir, 'sessions');
  const nested = join(root, 'project', 'session', 'subagents', 'agent-valid.jsonl');
  writeHarnessSession(nested, 'pi', 'other-harness-session');
  expect(discoverTranscriptFiles([{ format: 'codex', root, extension: '.jsonl' }]).map((file) => file.path)).toEqual([nested]);
  expect(discoverTranscriptFiles([{ format: 'pi', root, extension: '.jsonl' }])).toEqual([]);
  expect(discoverTranscriptFiles([{ format: 'omp', root, extension: '.jsonl' }])).toEqual([]);
  expect(discoverTranscriptFiles([{ format: 'cursor', root, extension: '.jsonl' }])).toEqual([]);

  for (const format of ['pi', 'omp', 'cursor'] as const) {
    const store = join(dir, `${format}-store`);
    const path = format === 'cursor'
      ? join(store, 'project', 'agent-transcripts', 'public', 'public.jsonl')
      : join(store, 'project', 'public.jsonl');
    writeHarnessSession(path, format, 'public');
    const link = join(dir, `${format}-link`);
    symlinkSync(store, link);
    expect(discoverTranscriptFiles([{ format, root: link, extension: '.jsonl' }])).toEqual([]);
    expect(discoverTranscriptFiles([{ format, root: store, extension: '.jsonl' }]).map((file) => file.path)).toEqual([path]);
  }
});

test('legacy harness roots may be symlinks but descendant links remain excluded', () => {
  for (const format of ['claude-code', 'codex', 'openclaw', 'grok', 'hermes'] as const) {
    const store = join(dir, `${format}-store`), root = join(dir, `${format}-root`);
    const relativePath = format === 'hermes' ? 'state.db'
      : format === 'grok' ? 'project/12345678-1234-1234-1234-123456789abc/chat_history.jsonl'
      : 'project/public.jsonl';
    const path = join(store, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'synthetic');
    symlinkSync(store, root);
    symlinkSync(path, join(store, format === 'hermes' ? 'other.db' : 'linked.jsonl'));
    const skippedRoots: SkippedTranscriptRoot[] = [];
    expect(discoverTranscriptFiles([{ format, root, extension: format === 'hermes' ? '.db' : '.jsonl' }], { skippedRoots })
      .map(file => file.path)).toEqual([join(root, relativePath)]);
    expect(skippedRoots).toEqual([]);
  }
});

test('status reports rejected new-harness override roots in JSON and text from an isolated home', () => {
  const root = join(dir, 'linked-root'), store = join(dir, 'store');
  mkdirSync(store); symlinkSync(store, root);
  const formats = ['pi', 'omp', 'cursor'] as const;
  const expected: SkippedTranscriptRoot[] = formats.map(format => ({ format, root, reason: 'symlink' }));
  const skippedRoots: SkippedTranscriptRoot[] = [];
  discoverTranscriptFiles(formats.map(format => ({ format, root, extension: '.jsonl' })), { skippedRoots });
  expect(skippedRoots).toEqual(expected);
  // Bun caches homedir at startup. Do not let default status discovery enumerate
  // the parent process's legacy stores, even when this test runs outside CI.
  const child = Bun.spawnSync([process.execPath, '-e', `
    import { runTranscripts } from './src/commands/transcripts.ts';
    const logs = [];
    console.log = (...values) => logs.push(values.join(' '));
    const engine = { executeRaw: async () => [] };
    await runTranscripts(engine, ['status', '--json']);
    const json = JSON.parse(logs.join('\\n'));
    logs.length = 0;
    await runTranscripts(engine, ['status']);
    process.stdout.write(JSON.stringify({ json, text: logs }));
  `], {
    cwd: join(import.meta.dir, '..'),
    env: {
      HOME: dir, PATH: process.env.PATH ?? '', TMPDIR: tmpdir(), GBRAIN_HOME: join(dir, 'brain'),
      GBRAIN_DAILY_MEMORY_PI_ROOT: root, GBRAIN_DAILY_MEMORY_OMP_ROOT: root, GBRAIN_DAILY_MEMORY_CURSOR_ROOT: root,
    },
    stdout: 'pipe', stderr: 'pipe',
  });
  expect(child.exitCode).toBe(0);
  const status = JSON.parse(Buffer.from(child.stdout).toString());
  expect(status.json.skipped_roots).toEqual(expected);
  for (const { format } of expected) expect(status.text).toContain(`  skipped root (${format}, symlink): ${root}`);
});

test('an enumeration-denied root is reported while inaccessible descendants remain skipped', () => {
  const root = join(dir, 'sessions'), nested = join(root, 'denied');
  mkdirSync(nested, { recursive: true });
  const publicFile = join(root, 'public.jsonl'); writeFileSync(publicFile, 'synthetic');
  const roots: HarnessRoot[] = [{ format: 'codex', root, extension: '.jsonl' }];
  let denied = root;
  const original = fs.readdirSync;
  // Inject the filesystem EACCES boundary: mode bits alone do not deny root on CI.
  const listing = spyOn(fs, 'readdirSync').mockImplementation(path => {
    if (path === denied) throw Object.assign(new Error('Synthetic permission denial'), { code: 'EACCES' });
    return original(path);
  });
  try {
    const skippedRoots: SkippedTranscriptRoot[] = [];
    expect(discoverTranscriptFiles(roots, { skippedRoots })).toEqual([]);
    expect(skippedRoots).toEqual([{ format: 'codex', root, reason: 'unreadable' }]);
    skippedRoots.length = 0; denied = nested;
    expect(discoverTranscriptFiles(roots, { skippedRoots }).map(file => file.path)).toEqual([publicFile]);
    expect(skippedRoots).toEqual([]);
  } finally { listing.mockRestore(); }
});
