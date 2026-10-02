import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const repo = resolve(import.meta.dir, '../..');
const launcher = join(repo, 'scripts/gbrain-daily-memory.sh');
const selector = join(repo, 'scripts/daily-memory-codex-files.py');
const homes: string[] = [];
type Call = { kind: string; args: string[]; url: string | null; tz?: string | null; zone?: string | null; lookback?: string | null };

function fixture(configExtra: Record<string, unknown> = { 'cycle.timezone': 'Asia/Manila' }) {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-daily-launcher-'));
  homes.push(home);
  mkdirSync(join(home, '.local/bin'), { recursive: true });
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  // Empty sessions root is a successful empty scan; only a missing root fails closed.
  mkdirSync(join(home, '.codex/sessions'), { recursive: true });
  const config = join(home, '.gbrain/config.json');
  const original = `${JSON.stringify({ database_url: 'postgres://example:example@127.0.0.1:5432/example', ...configExtra })}\n`;
  writeFileSync(config, original);
  const calls = join(home, 'calls.jsonl');
  const bun = join(home, '.local/bin/bun');
  writeFileSync(bun, `#!/usr/bin/env python3
import json, os, pathlib, sys, time
args = sys.argv[1:]
kind = 'resolve' if args[0] == '-e' else (
  'tz' if any('daily-memory-timezone' in a for a in args) else
  ('ingest' if 'transcripts' in args else 'write'))
log = pathlib.Path(os.environ['TEST_CALLS'])
previous = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
if kind == 'tz':
    value = (os.environ.get('TEST_BRAIN_TZ') or '').strip()
    if value:
        print(value, end='')
    sys.exit(0)
with log.open('a') as out:
    out.write(json.dumps({'kind': kind, 'args': args, 'url': os.environ.get('GBRAIN_DATABASE_URL'), 'tz': os.environ.get('TZ'), 'zone': os.environ.get('GBRAIN_DAILY_MEMORY_ZONE'), 'lookback': os.environ.get('GBRAIN_DAILY_MEMORY_LOOKBACK')}) + '\\n')
if kind == 'resolve':
    if os.environ.get('TEST_RESOLVE_FAIL') == '1':
        print('fixture config resolver failed', file=sys.stderr)
        sys.exit(8)
    print('postgres://example:example@127.0.0.1:6543/example', end='')
    sys.exit(0)
if kind == os.environ.get('TEST_FAIL_KIND'):
    attempts = sum(call['kind'] == kind for call in previous)
    if attempts == 0 or os.environ.get('TEST_FAIL_ALWAYS') == '1':
        print('EMAXCONNSESSION' if os.environ.get('TEST_FAIL_MODE') == 'session' else 'fixture command failed')
        sys.exit(7)
if kind == 'write' and os.environ.get('TEST_HOLD') == '1':
    pathlib.Path(os.environ['TEST_READY']).touch()
    time.sleep(1)
if kind == 'ingest':
    # Launcher parses cleanScan from --json stdout before advancing watermark.
    print(json.dumps({'cleanScan': os.environ.get('TEST_CLEAN_SCAN', '1') != '0'}))
else:
    print('fixture success')
`);
  chmodSync(bun, 0o755);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GBRAIN_') && key !== 'DATABASE_URL'));
  function run(args: string[] = [], extra: Record<string, string> = {}) {
    const result = spawnSync('/bin/bash', [launcher, ...args], {
      env: { ...env, HOME: home, GBRAIN_REPO_ROOT: repo, TEST_CALLS: calls, ...extra },
      encoding: 'utf8', timeout: 15_000,
    });
    expect(result.error).toBeUndefined();
    expect(readFileSync(config, 'utf8')).toBe(original);
    expect(existsSync(join(home, '.local/state/gbrain/daily-memory.lock'))).toBe(false);
    return { code: result.status, calls: existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Call) : [] };
  }
  return { home, run };
}

function transcript(home: string, timestamp: string, name: string) {
  const utcDate = timestamp.slice(0, 10).replaceAll('-', '/');
  const file = join(home, '.codex/sessions', utcDate, `${name}.jsonl`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { timestamp } }) + '\n');
  return file;
}

function todayInputs(home: string, timeZone = 'Asia/Manila') {
  const day = new Intl.DateTimeFormat('sv-SE', { timeZone }).format(new Date());
  // Build the zone offset for this calendar day via the formatter's instant math.
  const start = Date.parse(`${day}T00:00:00${offsetFor(timeZone, day)}`);
  const before = transcript(home, new Date(start - 1).toISOString(), 'before');
  const precedingUtc = transcript(home, new Date(start).toISOString(), 'preceding-utc');
  const currentUtc = transcript(home, new Date(start + 12 * 3600_000).toISOString(), 'current-utc');
  const after = transcript(home, new Date(start + 24 * 3600_000).toISOString(), 'after');
  // Pin mtimes to the session instants so "now" during the test does not
  // accidentally select adjacent-day files via the overlap rule.
  const pin = (file: string, ms: number) => {
    const at = new Date(ms);
    utimesSync(file, at, at);
  };
  pin(before, start - 1);
  pin(precedingUtc, start);
  pin(currentUtc, start + 12 * 3600_000);
  pin(after, start + 24 * 3600_000);
  return { day, start, before, precedingUtc, currentUtc, after, timeZone };
}

/** Fixed offset string for zones used in these tests (Manila +08, UTC +00). */
function offsetFor(timeZone: string, _day: string): string {
  if (timeZone === 'UTC') return 'Z';
  if (timeZone === 'Asia/Manila') return '+08:00';
  // Fallback: probe via Intl parts is heavier; tests stick to Manila/UTC.
  return '+08:00';
}

afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

describe('daily memory launcher', () => {
  it('allows only one concurrent writer and releases the kernel lock after exit', () => {
    const { home, run } = fixture();
    const calls = join(home, 'calls.jsonl');
    const ready = join(home, 'ready');
    const probe = spawnSync('python3', ['-c', `
import os, pathlib, subprocess, sys, time
launcher, home, repo, calls, ready = sys.argv[1:]
env = {k:v for k,v in os.environ.items() if not k.startswith('GBRAIN_') and k != 'DATABASE_URL'}
env.update(HOME=home, GBRAIN_REPO_ROOT=repo, TEST_CALLS=calls, TEST_HOLD='1', TEST_READY=ready)
first = subprocess.Popen(['/bin/bash', launcher, '2026-09-29'], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
try:
    deadline = time.monotonic() + 5
    while not pathlib.Path(ready).exists():
        if first.poll() is not None or time.monotonic() > deadline:
            raise RuntimeError('first writer did not acquire lock')
        time.sleep(0.01)
    second = subprocess.run(['/bin/bash', launcher, '2026-09-29'], env=env, capture_output=True, timeout=5)
    assert second.returncode == 0
    assert b'already running' in second.stdout
    assert first.wait(timeout=5) == 0
finally:
    if first.poll() is None:
        first.kill()
        first.wait()
`, launcher, home, repo, calls, ready], { encoding: 'utf8', timeout: 15_000 });
    expect(probe.error).toBeUndefined();
    expect(probe.status).toBe(0);
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(run(['2026-09-29']).code).toBe(0);
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('selects both UTC folders within the Manila calendar day, excluding adjacent days', () => {
    const { home } = fixture();
    const input = todayInputs(home);
    const result = spawnSync('python3', [selector, join(home, '.codex/sessions'), input.day, 'Asia/Manila'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout.split('\0').filter(Boolean)).toEqual([input.precedingUtc, input.currentUtc]);
  });

  it('bounds the Codex day at next local midnight across DST', () => {
    const { home } = fixture();
    // 2026-03-08 America/Los_Angeles springs forward: local day is 23h.
    // start+24h would wrongly include 00:30 PDT on Mar 9 (07:30Z).
    const day = '2026-03-08';
    const zone = 'America/Los_Angeles';
    const inDay = transcript(home, '2026-03-09T06:30:00.000Z', 'late-same-local');
    const nextDay = transcript(home, '2026-03-09T07:30:00.000Z', 'early-next-local');
    for (const [file, iso] of [[inDay, '2026-03-09T06:30:00.000Z'], [nextDay, '2026-03-09T07:30:00.000Z']] as const) {
      const at = new Date(iso);
      utimesSync(file, at, at);
    }
    const result = spawnSync('python3', [selector, join(home, '.codex/sessions'), day, zone], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    const selected = result.stdout.split('\0').filter(Boolean);
    expect(selected).toContain(inDay);
    expect(selected).not.toContain(nextDay);
  });

  it('rescans older sessions modified during the target day', () => {
    const { home } = fixture();
    const input = todayInputs(home);
    // Session started before the Manila day (adjacent "before" file) but kept
    // receiving messages today: mtime inside the day window must select it.
    const touched = input.before;
    const midDay = new Date(input.start + 6 * 3600_000);
    utimesSync(touched, midDay, midDay);
    const result = spawnSync('python3', [selector, join(home, '.codex/sessions'), input.day, 'Asia/Manila'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout.split('\0').filter(Boolean)).toEqual([input.before, input.precedingUtc, input.currentUtc]);
  });

  it('rescans sessions modified after the prior run watermark across midnight', () => {
    const { home } = fixture();
    const input = todayInputs(home);
    // Prior run finished early yesterday; evening messages updated mtime after
    // that watermark but still before today's start — tomorrow must reselect.
    const priorRun = new Date(input.start - 6 * 3600_000).toISOString();
    const evening = new Date(input.start - 2 * 3600_000);
    utimesSync(input.before, evening, evening);
    const result = spawnSync('python3', [selector, join(home, '.codex/sessions'), input.day, 'Asia/Manila', priorRun], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout.split('\0').filter(Boolean)).toEqual([input.before, input.precedingUtc, input.currentUtc]);
  });

  it('ingests selected Codex files before writing with the default source and day boundary', () => {
    const { home, run } = fixture();
    const input = todayInputs(home);
    const result = run();
    expect(result.code).toBe(0);
    expect(result.calls.map(call => call.kind)).toEqual(['ingest', 'write']);
    const args = result.calls[0].args;
    expect(args.slice(1, 6)).toEqual(['transcripts', 'ingest', '--json', '--format', 'codex']);
    // No prior watermark: --since falls back to the target day's midnight.
    expect(new Date(args[args.indexOf('--since') + 1]).getTime()).toBe(input.start);
    expect(args.slice(args.indexOf('--source-id'), args.indexOf('--source-id') + 2)).toEqual(['--source-id', 'default']);
    expect(args.slice(args.indexOf('--date-zone'), args.indexOf('--date-zone') + 2)).toEqual(['--date-zone', 'Asia/Manila']);
    expect(args.slice(-2)).toEqual([input.precedingUtc, input.currentUtc]);
    expect(args).not.toContain(input.before);
    expect(args).not.toContain(input.after);
    expect(result.calls[1].args).toEqual([join(repo, 'scripts/write-daily-memory.ts'), input.day]);
    expect(result.calls[1].zone).toBe('Asia/Manila');
    expect(result.calls[1].lookback).toBe('1');
    expect(existsSync(join(home, '.local/state/gbrain/daily-memory-codex-mtime'))).toBe(true);
  });

  it('commits the pre-scan watermark so mid-run appends stay eligible', () => {
    const { home, run } = fixture();
    todayInputs(home);
    const ready = join(home, 'ready');
    const mark = join(home, '.local/state/gbrain/daily-memory-codex-mtime');
    const result = run([], { TEST_HOLD: '1', TEST_READY: ready });
    expect(result.code).toBe(0);
    const end = Date.now();
    const stamp = Date.parse(readFileSync(mark, 'utf8').trim());
    expect(Number.isFinite(stamp)).toBe(true);
    // Write fixture holds 1s after ingest; pre-scan stamp must predate that hold.
    expect(end - stamp).toBeGreaterThan(800);
  });

  it('writes the Codex mtime watermark via atomic rename', () => {
    const src = readFileSync(launcher, 'utf8');
    expect(src).toContain('os.replace');
    expect(src).toContain('.tmp');
  });

  it('holds the watermark when ingest reports cleanScan false', () => {
    const { home, run } = fixture();
    todayInputs(home);
    const mark = join(home, '.local/state/gbrain/daily-memory-codex-mtime');
    mkdirSync(dirname(mark), { recursive: true });
    writeFileSync(mark, '2026-09-28T12:00:00Z\n');
    const before = readFileSync(mark, 'utf8');
    const result = run([], { TEST_CLEAN_SCAN: '0' });
    expect(result.code).toBe(0);
    expect(result.calls.map(call => call.kind)).toEqual(['ingest', 'write']);
    expect(readFileSync(mark, 'utf8')).toBe(before);
  });

  it('selects a resumed session older than 14 days when watermark mtime matches', () => {
    const { home } = fixture();
    const input = todayInputs(home);
    const oldStart = new Date(input.start - 20 * 86400_000);
    const oldDay = oldStart.toISOString().slice(0, 10).replaceAll('-', '/');
    const file = join(home, '.codex/sessions', oldDay, 'ancient.jsonl');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { timestamp: oldStart.toISOString() } }) + '\n');
    const recent = new Date(input.start - 3600_000);
    utimesSync(file, recent, recent);
    const priorRun = new Date(input.start - 6 * 3600_000).toISOString();
    const result = spawnSync('python3', [selector, join(home, '.codex/sessions'), input.day, 'Asia/Manila', priorRun], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout.split('\0').filter(Boolean)).toContain(file);
  });

  it('selects a resumed session older than 14 days on the first run without a watermark', () => {
    const { home } = fixture();
    const input = todayInputs(home);
    const oldStart = new Date(input.start - 20 * 86400_000);
    const oldDay = oldStart.toISOString().slice(0, 10).replaceAll('-', '/');
    const file = join(home, '.codex/sessions', oldDay, 'ancient-first.jsonl');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { timestamp: oldStart.toISOString() } }) + '\n');
    // mtime inside today's window so first-run selection (mtime_floor = day start) keeps it.
    const midDay = new Date(input.start + 2 * 3600_000);
    utimesSync(file, midDay, midDay);
    const result = spawnSync('python3', [selector, join(home, '.codex/sessions'), input.day, 'Asia/Manila'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout.split('\0').filter(Boolean)).toContain(file);
  });

  it('uses the saved watermark as --since so cross-midnight rescans are not filtered', () => {
    const { home, run } = fixture();
    const input = todayInputs(home);
    // Prior run finished early yesterday; evening messages updated mtime after
    // that watermark but still before today's start.
    const priorRun = new Date(input.start - 6 * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const evening = new Date(input.start - 2 * 3600_000);
    utimesSync(input.before, evening, evening);
    mkdirSync(join(home, '.local/state/gbrain'), { recursive: true });
    writeFileSync(join(home, '.local/state/gbrain/daily-memory-codex-mtime'), `${priorRun}\n`);
    const result = run();
    expect(result.code).toBe(0);
    expect(result.calls.map(call => call.kind)).toEqual(['ingest', 'write']);
    const args = result.calls[0].args;
    expect(args[args.indexOf('--since') + 1]).toBe(priorRun);
    expect(args).toContain(input.before);
    expect(args).toContain(input.precedingUtc);
    expect(args).toContain(input.currentUtc);
  });

  it('rejects a future watermark and falls back to day midnight for --since', () => {
    const { home, run } = fixture();
    const input = todayInputs(home);
    const future = new Date(Date.now() + 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    mkdirSync(join(home, '.local/state/gbrain'), { recursive: true });
    writeFileSync(join(home, '.local/state/gbrain/daily-memory-codex-mtime'), `${future}\n`);
    const result = run();
    expect(result.code).toBe(0);
    expect(result.calls.map(call => call.kind)).toEqual(['ingest', 'write']);
    const args = result.calls[0].args;
    expect(new Date(args[args.indexOf('--since') + 1]).getTime()).toBe(input.start);
    expect(args).toContain(input.precedingUtc);
    expect(args).toContain(input.currentUtc);
  });

  it('rejects a malformed watermark and falls back to day midnight for --since', () => {
    const { home, run } = fixture();
    const input = todayInputs(home);
    mkdirSync(join(home, '.local/state/gbrain'), { recursive: true });
    writeFileSync(join(home, '.local/state/gbrain/daily-memory-codex-mtime'), 'not-a-timestamp\n');
    const result = run();
    expect(result.code).toBe(0);
    expect(result.calls.map(call => call.kind)).toEqual(['ingest', 'write']);
    const args = result.calls[0].args;
    expect(new Date(args[args.indexOf('--since') + 1]).getTime()).toBe(input.start);
  });

  it('regenerates an explicit date without ingesting existing transcripts', () => {
    const { home, run } = fixture();
    todayInputs(home);
    const mark = join(home, '.local/state/gbrain/daily-memory-codex-mtime');
    mkdirSync(dirname(mark), { recursive: true });
    writeFileSync(mark, '2026-09-28T12:00:00Z\n');
    const before = readFileSync(mark, 'utf8');
    const result = run(['2026-09-29']);
    expect(result.code).toBe(0);
    expect(result.calls.map(call => call.kind)).toEqual(['write']);
    expect(result.calls[0].args).toEqual([join(repo, 'scripts/write-daily-memory.ts'), '2026-09-29']);
    expect(result.calls[0].lookback).toBeFalsy();
    // Backfill must not advance the Codex mtime watermark.
    expect(readFileSync(mark, 'utf8')).toBe(before);
  });

  it('writes when the current day has no Codex files', () => {
    const { run } = fixture();
    const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Manila' }).format(new Date());
    const result = run();
    expect(result.code).toBe(0);
    expect(result.calls.map(call => call.kind)).toEqual(['write']);
    expect(result.calls[0].args).toEqual([join(repo, 'scripts/write-daily-memory.ts'), day]);
  });

  it('aborts writing after an importer error without retrying unrelated failures', () => {
    const { home, run } = fixture();
    todayInputs(home);
    const result = run([], { TEST_FAIL_KIND: 'ingest', TEST_FAIL_MODE: 'error' });
    expect(result.code).toBe(7);
    expect(result.calls.map(call => call.kind)).toEqual(['ingest']);
    expect(existsSync(join(home, '.local/state/gbrain/daily-memory-codex-mtime'))).toBe(false);
  });

  for (const kind of ['ingest', 'write']) {
    it(`retries only the ${kind} command on port 6543 after EMAXCONNSESSION`, () => {
      const { home, run } = fixture();
      todayInputs(home);
      const result = run([], { TEST_FAIL_KIND: kind, TEST_FAIL_MODE: 'session' });
      expect(result.code).toBe(0);
      expect(result.calls.map(call => call.kind)).toEqual(kind === 'ingest'
        ? ['ingest', 'resolve', 'ingest', 'write'] : ['ingest', 'write', 'resolve', 'write']);
      const attempts = result.calls.filter(call => call.kind === kind);
      expect(attempts[0].url).toBeNull();
      expect(new URL(attempts[1].url!).port).toBe('6543');
      expect(attempts[1].args).toEqual(attempts[0].args);
      if (kind === 'ingest') expect(result.calls.at(-1)!.url).toBeNull();
    });
  }

  it('aborts after a failed transaction-pooler retry', () => {
    const { home, run } = fixture();
    todayInputs(home);
    const result = run([], { TEST_FAIL_KIND: 'ingest', TEST_FAIL_MODE: 'session', TEST_FAIL_ALWAYS: '1' });
    expect(result.code).toBe(7);
    expect(result.calls.map(call => call.kind)).toEqual(['ingest', 'resolve', 'ingest']);
  });

  it('does not retry on an empty URL when resolving the transaction-pooler URL fails', () => {
    const { home, run } = fixture();
    todayInputs(home);
    const result = run([], { TEST_FAIL_KIND: 'ingest', TEST_FAIL_MODE: 'session', TEST_RESOLVE_FAIL: '1' });
    expect(result.code).toBe(8);
    expect(result.calls.map(call => call.kind)).toEqual(['ingest', 'resolve']);
  });

  it('returns a writer failure without retrying unrelated failures', () => {
    const result = fixture().run(['2026-09-29'], { TEST_FAIL_KIND: 'write', TEST_FAIL_MODE: 'error' });
    expect(result.code).toBe(7);
    expect(result.calls.map(call => call.kind)).toEqual(['write']);
  });

  it('uses cycle.timezone from config over env.sh TZ', () => {
    const { home, run } = fixture({ 'cycle.timezone': 'Asia/Manila' });
    writeFileSync(join(home, '.gbrain/env.sh'), 'export TZ=UTC\n');
    const result = run();
    expect(result.code).toBe(0);
    expect(result.calls.map(call => call.kind)).toEqual(['write']);
    expect(result.calls[0].tz).toBe('Asia/Manila');
    expect(result.calls[0].args).toEqual([join(repo, 'scripts/write-daily-memory.ts'), new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Manila' }).format(new Date())]);
    expect(result.calls[0].lookback).toBe('1');
  });

  it('uses brain DB cycle.timezone when the file plane omits it', () => {
    const { home, run } = fixture({});
    writeFileSync(join(home, '.gbrain/env.sh'), 'export TZ=UTC\n');
    const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Manila' }).format(new Date());
    const result = run([], { TEST_BRAIN_TZ: 'Asia/Manila' });
    expect(result.code).toBe(0);
    expect(result.calls[0].tz).toBe('Asia/Manila');
    expect(result.calls[0].args).toEqual([join(repo, 'scripts/write-daily-memory.ts'), day]);
  });

  it('honors GBRAIN_DAILY_MEMORY_TZ over config and env.sh', () => {
    const { home, run } = fixture({ 'cycle.timezone': 'Asia/Manila' });
    writeFileSync(join(home, '.gbrain/env.sh'), 'export TZ=UTC\n');
    const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'UTC' }).format(new Date());
    const result = run([], { GBRAIN_DAILY_MEMORY_TZ: 'UTC' });
    expect(result.code).toBe(0);
    expect(result.calls[0].tz).toBe('UTC');
    expect(result.calls[0].zone).toBe('UTC');
    expect(result.calls[0].args).toEqual([join(repo, 'scripts/write-daily-memory.ts'), day]);
  });

  it('exits nonzero when a selected Codex transcript cannot be read', () => {
    const { home } = fixture();
    const input = todayInputs(home);
    // Broken symlink under today's UTC folder: glob finds it, open fails.
    const utcDate = new Date(input.start + 3600_000).toISOString().slice(0, 10).replaceAll('-', '/');
    const broken = join(home, '.codex/sessions', utcDate, 'unreadable.jsonl');
    mkdirSync(dirname(broken), { recursive: true });
    // Point at a missing target so open() raises ENOENT.
    try {
      symlinkSync(join(home, 'missing-target.jsonl'), broken);
    } catch {
      // Fallback for environments that block symlinks: empty chmod-000 file.
      writeFileSync(broken, '');
      chmodSync(broken, 0o000);
    }
    const result = spawnSync('python3', [selector, join(home, '.codex/sessions'), input.day, 'Asia/Manila'], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/cannot (stat|read)/);
    try { chmodSync(broken, 0o644); } catch { /* ignore */ }
  });

  it('exits nonzero when the Codex sessions root is absent', () => {
    const { home } = fixture();
    const input = todayInputs(home);
    const sessions = join(home, '.codex/sessions');
    rmSync(sessions, { recursive: true, force: true });
    const result = spawnSync('python3', [selector, sessions, input.day, 'Asia/Manila'], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/cannot list/);
  });

  it('treats a child day directory that disappears mid-walk as empty, not a root failure', () => {
    const { home } = fixture();
    const input = todayInputs(home);
    // Remove only the currentUtc day folder; an existing sessions root must still succeed.
    rmSync(dirname(input.currentUtc), { recursive: true, force: true });
    const result = spawnSync('python3', [selector, join(home, '.codex/sessions'), input.day, 'Asia/Manila'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    const selected = result.stdout.split('\0').filter(Boolean);
    expect(selected).not.toContain(input.currentUtc);
  });

  it('exits nonzero when a session day directory cannot be listed', () => {
    const { home } = fixture();
    const input = todayInputs(home);
    const utcDate = new Date(input.start + 3600_000).toISOString().slice(0, 10).replaceAll('-', '/');
    const dayDir = join(home, '.codex/sessions', utcDate);
    mkdirSync(dayDir, { recursive: true });
    chmodSync(dayDir, 0o000);
    const result = spawnSync('python3', [selector, join(home, '.codex/sessions'), input.day, 'Asia/Manila'], { encoding: 'utf8' });
    try { chmodSync(dayDir, 0o755); } catch { /* ignore */ }
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/cannot (list|stat)/);
  });

  it('places the flock under GBRAIN_DAILY_MEMORY_STATE on a fresh home', () => {
    const { home, run } = fixture();
    const state = join(home, 'custom-state');
    const defaultState = join(home, '.local/state/gbrain');
    const result = run(['2026-09-29'], { GBRAIN_DAILY_MEMORY_STATE: state });
    expect(result.code).toBe(0);
    expect(existsSync(join(state, 'daily-memory.flock'))).toBe(true);
    expect(existsSync(join(defaultState, 'daily-memory.flock'))).toBe(false);
  });

});
