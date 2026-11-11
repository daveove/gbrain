import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { load as loadYaml } from 'js-yaml';

type Job = {
  'runs-on'?: string;
  strategy?: { matrix: { os?: string[]; target?: string[] } };
};
const root = join(import.meta.dir, '../..');
const load = (name: string) => loadYaml(readFileSync(join(root, '.github/workflows', name), 'utf8')) as { jobs: Record<string, Job> };
// DAV-7475 (#71, #75): this fork has no Ubicloud installation for Test, E2E,
// Scale tier, persistence, native-lock and stress jobs. They run on GitHub-hosted
// runners. The label-gated heavy suite, actionlint and Semgrep keep Ubicloud labels.
const hosted = 'ubuntu-latest';
const normal = 'ubicloud-standard-16-ubuntu-2404';
const heavy = 'ubicloud-standard-30-ubuntu-2404';
const small = 'ubicloud-standard-2-ubuntu-2404';
const report = 'ubicloud-standard-4-ubuntu-2404';
const pooled = 'ubicloud-standard-8-ubuntu-2404';
const arm = 'ubicloud-standard-4-arm-ubuntu-2404';
const hostedArm = 'ubuntu-24.04-arm';
const targetRunners = (job: Job) =>
  JSON.parse(/fromJSON\('([^']+)'\)\[matrix\.target\]/.exec(job['runs-on']!)![1]!) as Record<string, string>;

describe('CI runner routing', () => {
  test('fork Test, E2E, persistence, native-lock and stress jobs use GitHub-hosted runners; release never uses Ubicloud', () => {
    for (const file of ['test.yml', 'e2e.yml', 'persistence-validation.yml', 'native-locks.yml', 'stress.yml', 'scale-tier.yml']) {
      for (const job of Object.values(load(file).jobs)) {
        const runner = job['runs-on'];
        if (!runner || runner.startsWith('${{')) continue;
        expect(runner, file).toBe(hosted);
      }
    }
    for (const file of ['heavy-tests.yml', 'actionlint.yml', 'semgrep.yml']) {
      for (const job of Object.values(load(file).jobs)) {
        const runner = job['runs-on'];
        if (!runner || runner.startsWith('${{')) continue;
        expect(runner, file).toMatch(/^ubicloud-standard-(2|4|8|16|30)-ubuntu-2404$/);
      }
    }
    const release = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
    expect(release).not.toContain('ubicloud');
    expect(load('osv-scanner.yml').jobs['osv-scan']['runs-on']).toBeUndefined();
  });

  test('the label-gated heavy suite keeps 30 vCPUs', () => {
    expect(load('heavy-tests.yml').jobs.heavy['runs-on']).toBe(heavy);
  });

  test('unit shards, the serial pool, verify and Selected E2E shards run on GitHub-hosted runners', () => {
    expect(load('test.yml').jobs.test['runs-on']).toBe(hosted);
    expect(load('test.yml').jobs['serial-tests']['runs-on']).toBe(hosted);
    expect(load('test.yml').jobs.verify['runs-on']).toBe(hosted);
    expect(load('e2e.yml').jobs['selected-e2e']['runs-on']).toBe(hosted);
  });

  test('security matrix labels and native platform coverage retain their identities', () => {
    const security = load('test.yml').jobs['security-regressions'];
    expect(security.strategy!.matrix.os).toEqual(['ubuntu-latest', 'macos-26', 'windows-latest']);
    for (const os of security.strategy!.matrix.os!) {
      const expression = security['runs-on']!.replace(/^\$\{\{\s*|\s*\}\}$/g, '');
      expect(runInNewContext(expression, { matrix: { os } }, { timeout: 100 })).toBe(os);
    }
    const native = load('native-locks.yml');
    expect(targetRunners(native.jobs.native)).toEqual({
      'linux-x64-glibc': hosted,
      'linux-arm64-glibc': hostedArm,
      'darwin-arm64': 'macos-26',
      'darwin-x64': 'macos-26-intel',
      'win32-x64': 'windows-2022',
      'win32-arm64': 'windows-11-arm',
    });
    expect(native.jobs.native.strategy!.matrix.target).toEqual(Object.keys(targetRunners(native.jobs.native)));
    expect(targetRunners(native.jobs.musl)).toEqual({ 'linux-x64-musl': hosted, 'linux-arm64-musl': hostedArm });
    expect(native.jobs.musl.strategy!.matrix.target).toEqual(['linux-x64-musl', 'linux-arm64-musl']);
  });

  test('macOS 26 validation is pinned, time-boxed, label-gated on pull requests and uses no secrets', () => {
    const text = readFileSync(join(root, '.github/workflows/macos-validation.yml'), 'utf8');
    const workflow = loadYaml(text) as { on: Record<string, unknown>; jobs: Record<string, Job & { 'timeout-minutes'?: number; if?: string }> };
    expect(Object.keys(workflow.on).sort()).toEqual(['pull_request', 'schedule', 'workflow_dispatch']);
    const job = workflow.jobs['macos-26']!;
    expect(job['runs-on']).toBe('macos-26');
    expect(job['timeout-minutes']).toBeGreaterThan(0);
    expect(job.if).toContain("contains(github.event.pull_request.labels.*.name, 'macos-validation')");
    expect(text).not.toMatch(/\$\{\{[^}]*secrets\./);
  });

  test('status, planning and coverage report jobs use GitHub-hosted runners; actionlint and Semgrep keep their sizes', () => {
    for (const name of ['changes', 'gitleaks', 'dependency-audit', 'test-status', 'native-only-status']) {
      expect(load('test.yml').jobs[name]['runs-on'], name).toBe(hosted);
    }
    for (const name of ['prepare-e2e', 'e2e-status']) expect(load('e2e.yml').jobs[name]['runs-on'], name).toBe(hosted);
    expect(load('test.yml').jobs['coverage-report']['runs-on']).toBe(hosted);
    expect(load('e2e.yml').jobs['coverage-full-report']['runs-on']).toBe(hosted);
    expect(load('actionlint.yml').jobs.actionlint['runs-on']).toBe(small);
    expect(load('semgrep.yml').jobs.semgrep['runs-on']).toBe(report);
  });

  test('actionlint recognizes every configured custom label and watches its configuration', () => {
    const config = loadYaml(readFileSync(join(root, '.github/actionlint.yaml'), 'utf8')) as { 'self-hosted-runner': { labels: string[] } };
    expect(config['self-hosted-runner'].labels.sort()).toEqual([small, report, pooled, normal, heavy, arm].sort());
    const workflow = loadYaml(readFileSync(join(root, '.github/workflows/actionlint.yml'), 'utf8')) as { on: Record<string, { paths: string[] }> };
    for (const event of ['push', 'pull_request']) expect(workflow.on[event].paths).toContain('.github/actionlint.yaml');
  });
});
