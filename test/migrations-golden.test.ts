/** Migration numbering remains stable when forward migrations are added. */

import { describe, expect, test } from 'bun:test';
import { LATEST_VERSION, MIGRATIONS } from '../src/core/migrate.ts';

describe('migration numbering', () => {
  test('versions are unique and preserve the historical gaps', () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect(new Set(versions).size).toBe(versions.length);
    const sorted = [...versions].sort((a, b) => a - b);
    for (const gap of [17, 18, 19, 100]) expect(versions).not.toContain(gap);
    expect(sorted[0]).toBe(2);
    expect(sorted[sorted.length - 1]).toBe(LATEST_VERSION);
  }, 60_000);
});
