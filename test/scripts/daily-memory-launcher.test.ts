import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const repo = resolve(import.meta.dir, '../..');
const launcher = join(repo, 'scripts/gbrain-daily-memory.sh');
const selector = join(repo, 'scripts/daily-memory-codex-files.py');
const homes: string[] = [];
type Call = { kind: string; args: string[]; url: string | null };

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-daily-launcher-'));
  homes.push(home);
  mkdirSync(join(home, '.local/bin'), { recursive: true });
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  const config = join(home, '.gbrain/config.json');
  const original = '{"database_url":"postgres://example:example@127.0.0.1:5432/example"}\n';
  writeFileSync(config, original);
  const calls = join(home, 'calls.jsonl');
  const bun = join(home, '.local/bin/bun');
  writeFileSync(bun, `#!/usr/bin/env python3
import json, os, pathlib, sys
args = sys.argv[1:]
kind = 'resolve' if args[0] == '-e' else ('ingest' if 'transcripts' in args else 'write')
log = pathlib.Path(os.environ['TEST_CALLS'])
previous = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
with log.open('a') as out:
    out.write(json.dumps({'kind': kind, 'args': args, 'url': os.environ.get('GBRAIN_DATABASE_URL')}) + '\\n')
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

function todayInputs(home: string) {
  const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Manila' }).format(new Date());
  const start = new Date(`${day}T00:00:00+08:00`).getTime();
  const before = transcript(home, new Date(start - 1).toISOString(), 'before');
  const precedingUtc = transcript(home, new Date(start).toISOString(), 'preceding-utc');
  const currentUtc = transcript(home, new Date(start + 12 * 3600_000).toISOString(), 'current-utc');
  const after = transcript(home, new Date(start + 24 * 3600_000).toISOString(), 'after');
  return { day, start, before, precedingUtc, currentUtc, after };
}

afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

describe('daily memory launcher', () => {
  it('selects both UTC folders within the Manila calendar day, excluding adjacent days', () => {
    const { home } = fixture();
    const input = todayInputs(home);
    const result = spawnSync('python3', [selector, join(home, '.codex/sessions'), input.day], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout.split('\0').filter(Boolean)).toEqual([input.precedingUtc, input.currentUtc]);
  });

  it('ingests selected Codex files before writing with the default source and day boundary', () => {
    const { home, run } = fixture();
    const input = todayInputs(home);
    const result = run();
    expect(result.code).toBe(0);
    expect(result.calls.map(call => call.kind)).toEqual(['ingest', 'write']);
    const args = result.calls[0].args;
    expect(args.slice(1, 5)).toEqual(['transcripts', 'ingest', '--format', 'codex']);
    expect(new Date(args[args.indexOf('--since') + 1]).getTime()).toBe(input.start);
    expect(args.slice(args.indexOf('--source-id'), args.indexOf('--source-id') + 2)).toEqual(['--source-id', 'default']);
    expect(args.slice(-2)).toEqual([input.precedingUtc, input.currentUtc]);
    expect(args).not.toContain(input.before);
    expect(args).not.toContain(input.after);
  });

  it('regenerates an explicit date without ingesting existing transcripts', () => {
    const { home, run } = fixture();
    todayInputs(home);
    const result = run(['2026-09-29']);
    expect(result.code).toBe(0);
    expect(result.calls.map(call => call.kind)).toEqual(['write']);
    expect(result.calls[0].args).toEqual([join(repo, 'scripts/write-daily-memory.ts'), '2026-09-29']);
  });

  it('writes when the current day has no Codex files', () => {
    const result = fixture().run();
    expect(result.code).toBe(0);
    expect(result.calls.map(call => call.kind)).toEqual(['write']);
  });

  it('aborts writing after an importer error without retrying unrelated failures', () => {
    const { home, run } = fixture();
    todayInputs(home);
    const result = run([], { TEST_FAIL_KIND: 'ingest', TEST_FAIL_MODE: 'error' });
    expect(result.code).toBe(7);
    expect(result.calls.map(call => call.kind)).toEqual(['ingest']);
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
});
