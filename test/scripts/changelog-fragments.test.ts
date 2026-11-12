import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '../..');
const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
const history = '# Changelog\n\nKeep this preamble.\n\n## [Unreleased]\n\nExisting text.\n\n## [1.0.0.0] - 2026-01-01\n\nHistorical text.\n';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-changelog-'));
  roots.push(root);
  writeFileSync(join(root, 'VERSION'), '1.0.1.0\n');
  writeFileSync(join(root, 'CHANGELOG.md'), history);
  mkdirSync(join(root, 'changelog.d'));
  return root;
}
function run(root: string, script: string, args: string[] = [], env: Record<string, string> = {}) {
  return spawnSync('node', [join(REPO, 'scripts', script), ...args], {
    cwd: root, encoding: 'utf8', env: { HOME: root, PATH: process.env.PATH, ...env },
  });
}
function git(root: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

describe('release changelog collection', () => {
  test('sorts fragments, preserves all existing bytes, consumes inputs, and repeats without changes', () => {
    const root = fixture();
    writeFileSync(join(root, 'changelog.d/z-issue.md'), '### Fixed\n\n- Fix Z.\n');
    writeFileSync(join(root, 'changelog.d/a-branch.md'), '### Added\n\n- Add A.\n');
    writeFileSync(join(root, 'changelog.d/.gitkeep'), '');
    const result = run(root, 'collect-changelog.mjs', [], { GBRAIN_RESTAMP_DATE: '2026-11-12' });
    expect(result.status, result.stderr).toBe(0);
    const expected = history.replace('## [Unreleased]', '## [1.0.1.0] - 2026-11-12\n\n### Added\n\n- Add A.\n\n### Fixed\n\n- Fix Z.\n\n## [Unreleased]');
    expect(readFileSync(join(root, 'CHANGELOG.md'), 'utf8')).toBe(expected);
    expect(existsSync(join(root, 'changelog.d/a-branch.md'))).toBe(false);
    expect(existsSync(join(root, 'changelog.d/z-issue.md'))).toBe(false);
    expect(existsSync(join(root, 'changelog.d/.gitkeep'))).toBe(true);
    expect(run(root, 'collect-changelog.mjs').status).toBe(0);
    expect(readFileSync(join(root, 'CHANGELOG.md'), 'utf8')).toBe(expected);
  });

  test('adds fragments to an existing release without a duplicate version heading', () => {
    const root = fixture();
    const before = history.replace('[Unreleased]', '[1.0.1.0] - 2026-11-12');
    writeFileSync(join(root, 'CHANGELOG.md'), before);
    writeFileSync(join(root, 'changelog.d/issue.md'), '### Fixed\n\n- Fix A.');
    expect(run(root, 'collect-changelog.mjs').status).toBe(0);
    const after = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
    expect(after.match(/## \[1\.0\.1\.0\]/g)).toHaveLength(1);
    expect(after.indexOf('- Fix A.')).toBeLessThan(after.indexOf('## [1.0.0.0]'));
    expect(after).toContain('Existing text.');
    expect(after).toContain('Historical text.');
  });

  test.each(['', '# Wrong heading', '## [2.0.0.0] - 2026-11-12'])('rejects malformed fragment %j before any write', (text) => {
    const root = fixture();
    writeFileSync(join(root, 'changelog.d/a-valid.md'), '- Keep A.');
    writeFileSync(join(root, 'changelog.d/z-invalid.md'), text);
    expect(run(root, 'collect-changelog.mjs').status).toBe(1);
    expect(readFileSync(join(root, 'CHANGELOG.md'), 'utf8')).toBe(history);
    expect(existsSync(join(root, 'changelog.d/a-valid.md'))).toBe(true);
    expect(existsSync(join(root, 'changelog.d/z-invalid.md'))).toBe(true);
  });

  test('has no side effects without a fragment directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-changelog-empty-'));
    roots.push(root);
    expect(run(root, 'collect-changelog.mjs').status).toBe(0);
    expect(existsSync(join(root, 'CHANGELOG.md'))).toBe(false);
  });
});

describe('pull request changelog policy against git revisions', () => {
  test('rejects direct edits and renames; permits fragments and release version changes', () => {
    const root = fixture();
    git(root, 'init', '-q');
    git(root, 'config', 'user.name', 'Fixture');
    git(root, 'config', 'user.email', 'fixture@example.test');
    git(root, 'add', 'CHANGELOG.md', 'VERSION');
    git(root, 'commit', '-qm', 'base');
    const base = git(root, 'rev-parse', 'HEAD');
    writeFileSync(join(root, 'changelog.d/issue.md'), '- A fragment.');
    git(root, 'add', 'changelog.d/issue.md');
    git(root, 'commit', '-qm', 'fragment');
    expect(run(root, 'check-changelog-pr.mjs', [base, 'HEAD']).status).toBe(0);
    writeFileSync(join(root, 'CHANGELOG.md'), history + '\nDirect edit.\n');
    git(root, 'add', 'CHANGELOG.md');
    git(root, 'commit', '-qm', 'direct edit');
    expect(run(root, 'check-changelog-pr.mjs', [base, 'HEAD'], { PR_HEAD_REF: 'feature/issue' }).status).toBe(1);
    expect(run(root, 'check-changelog-pr.mjs', [base, 'HEAD'], { PR_HEAD_REF: 'release/1.0.1.0' }).status).toBe(1);
    writeFileSync(join(root, 'VERSION'), '1.0.2.0\n');
    writeFileSync(join(root, 'package.json'), '{"version":"1.0.2.0"}\n');
    git(root, 'add', 'VERSION', 'package.json');
    git(root, 'commit', '-qm', 'release stamps');
    expect(run(root, 'check-changelog-pr.mjs', [base, 'HEAD'], { PR_HEAD_REF: 'release/1.0.2.0' }).status).toBe(0);
    expect(run(root, 'check-changelog-pr.mjs', [base, 'HEAD'], { PR_HEAD_REF: 'feature/issue' }).status).toBe(1);
    const renameBase = git(root, 'rev-parse', 'HEAD');
    git(root, 'mv', 'CHANGELOG.md', 'ARCHIVE.md');
    git(root, 'commit', '-qm', 'rename changelog');
    expect(run(root, 'check-changelog-pr.mjs', [renameBase, 'HEAD']).status).toBe(1);
  });
});
