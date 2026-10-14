/**
 * #3387: chronicle extraction must enter through the gateway-refresh wrapper,
 * never a bare registration. Keep the historical describe for identity accounting;
 * the refresh-name set and its four mechanism predicates have been retired.
 * Every paid job must still refresh billing through registerBuiltinJob. Replacing
 * any paid registration with worker.register must fail; the chronicle-only guard
 * and registry-name golden cannot detect that drift. No production seam is needed.
 */
import { describe, test, expect } from 'bun:test';
import { surfaceFileSource, surfaceSource } from './helpers/source-surface.ts';

const JOBS_SRC = surfaceSource('jobs');
const SHARED_SRC = surfaceFileSource('jobs', 'src/commands/jobs/shared.ts');

describe('#3387 — GATEWAY_REFRESH_JOB_NAMES ⇔ registerBuiltinJob call sites', () => {
  test('chronicle_extract is registered via registerBuiltinJob, not bare worker.register', () => {
    const registered = [
      ...JOBS_SRC.matchAll(/registerBuiltinJob\(\s*worker,\s*engine,\s*'([^']+)'/g),
    ].map((x) => x[1]!);
    expect(registered).toContain('chronicle_extract');
    expect(JOBS_SRC).not.toMatch(/worker\.register\(\s*'chronicle_extract'/);
  });

  test('every PAID_JOB_NAMES member is registered via registerBuiltinJob, not bare worker.register', () => {
    const paidSet = SHARED_SRC.match(/const PAID_JOB_NAMES\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
    expect(paidSet).not.toBeNull();
    const paidNames = [...paidSet![1]!.matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]!);
    expect(paidNames.length).toBeGreaterThan(0);

    const wrapped = new Set(
      [...JOBS_SRC.matchAll(/registerBuiltinJob\(\s*worker,\s*engine,\s*['"]([^'"]+)['"]/g)]
        .map((match) => match[1]!),
    );
    const bare = new Set(
      [...JOBS_SRC.matchAll(/worker\.register\(\s*['"]([^'"]+)['"]/g)]
        .map((match) => match[1]!),
    );
    expect(paidNames.filter((name) => !wrapped.has(name))).toEqual([]);
    expect(paidNames.filter((name) => bare.has(name))).toEqual([]);
  });
});
