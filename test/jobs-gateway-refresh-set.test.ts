/**
 * #3387: chronicle extraction must enter through the gateway-refresh wrapper,
 * never a bare registration. Keep the historical describe for identity accounting;
 * the refresh-name set and its four mechanism predicates have been retired.
 */
import { describe, test, expect } from 'bun:test';
import { surfaceFileSource } from './helpers/source-surface.ts';

const JOBS_SRC = surfaceFileSource('jobs', 'src/commands/jobs.ts');

describe('#3387 — GATEWAY_REFRESH_JOB_NAMES ⇔ registerBuiltinJob call sites', () => {
  test('chronicle_extract is registered via registerBuiltinJob, not bare worker.register', () => {
    const registered = [
      ...JOBS_SRC.matchAll(/registerBuiltinJob\(\s*worker,\s*engine,\s*'([^']+)'/g),
    ].map((x) => x[1]!);
    expect(registered).toContain('chronicle_extract');
    expect(JOBS_SRC).not.toMatch(/worker\.register\(\s*'chronicle_extract'/);
  });
});
