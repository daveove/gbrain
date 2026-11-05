import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { APPLY_OPT_IN_ENV, decidePostinstall } from '../../scripts/postinstall.ts';

const REPO = resolve(import.meta.dir, '..', '..');
const SCRIPT = join(REPO, 'scripts', 'postinstall.ts');

describe('decidePostinstall', () => {
  test('applies migrations only on the explicit opt-in', () => {
    expect(APPLY_OPT_IN_ENV).toBe('GBRAIN_POSTINSTALL_APPLY_MIGRATIONS');
    expect(decidePostinstall({})).toBe('no-opt-in');
    expect(decidePostinstall({ [APPLY_OPT_IN_ENV]: '1' })).toBe('apply');
  });

  test('any value other than 1 is not an opt-in', () => {
    for (const value of ['', '0', 'true', 'yes', ' 1', undefined]) {
      expect(decidePostinstall({ [APPLY_OPT_IN_ENV]: value })).toBe('no-opt-in');
    }
  });

  test('the upgrade skip keeps working and wins over the opt-in', () => {
    expect(decidePostinstall({ GBRAIN_UPGRADE_OWNS_MIGRATIONS: '1' })).toBe('upgrade-owns');
    expect(decidePostinstall({ GBRAIN_UPGRADE_OWNS_MIGRATIONS: '1', [APPLY_OPT_IN_ENV]: '1' })).toBe('upgrade-owns');
    expect(decidePostinstall({ GBRAIN_UPGRADE_OWNS_MIGRATIONS: '0', [APPLY_OPT_IN_ENV]: '1' })).toBe('apply');
  });
});

// The script run end to end with a stub `gbrain` that only logs its argv. HOME and
// GBRAIN_HOME point at a throwaway directory and the environment is minimal, so
// nothing here can reach a real brain or inherit an opt-in.
describe('scripts/postinstall.ts opt-in, run as the install hook runs it', () => {
  function runHook(extraEnv: Record<string, string>) {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-postinstall-opt-in-'));
    try {
      const bin = join(home, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'gbrain'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$HOME/calls.log"\n`, { mode: 0o755 });
      const r = spawnSync(process.execPath, ['--no-env-file', SCRIPT], {
        cwd: home,
        env: { HOME: home, GBRAIN_HOME: home, PATH: `${bin}:/usr/bin:/bin`, ...extraEnv },
        encoding: 'utf8',
        timeout: 30_000,
      });
      const log = join(home, 'calls.log');
      return { status: r.status, stderr: r.stderr, calls: existsSync(log) ? readFileSync(log, 'utf8') : '' };
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  test('default: gbrain is never called, one line says how to opt in, exit 0', () => {
    const r = runHook({});
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).toBe('');
    const lines = r.stderr.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`${APPLY_OPT_IN_ENV}=1`);
  });

  test('opt-in: apply-migrations runs once, non-interactively', () => {
    const r = runHook({ [APPLY_OPT_IN_ENV]: '1' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).toBe('apply-migrations --yes --non-interactive\n');
  });

  test('upgrade skip: gbrain is never called even with the opt-in set', () => {
    const r = runHook({ GBRAIN_UPGRADE_OWNS_MIGRATIONS: '1', [APPLY_OPT_IN_ENV]: '1' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).toBe('');
    expect(r.stderr).toContain('deferred to `gbrain post-upgrade`');
  });
});
