/**
 * Open-loop extractor plumbing: gateway-refresh registration, kill-switch key,
 * edge vocabulary, and the public operations' area/read/write/remote posture.
 * The obsolete refresh-name set is not part of the contract: every builtin
 * wrapper now refreshes unconditionally.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { load } from 'js-yaml';

import { KNOWN_CONFIG_KEYS } from '../src/core/config.ts';
import { KNOWN_LINK_TYPES } from '../src/core/search/relational-intent.ts';
import { operations } from '../src/core/operations.ts';
import { surfaceFileSource } from './helpers/source-surface.ts';

const REPO = path.join(import.meta.dir, '..');

describe('jobs.ts wiring', () => {
  const src = surfaceFileSource('jobs', 'src/commands/jobs.ts');

  test("'loops_extract' is registered via registerBuiltinJob, never bare worker.register", () => {
    const registered = [
      ...src.matchAll(/registerBuiltinJob\(\s*worker,\s*engine,\s*'([^']+)'/g),
    ].map((x) => x[1]!);
    expect(registered).toContain('loops_extract');
    expect(src).not.toMatch(/worker\.register\(\s*'loops_extract'/);
  });
});

describe('kill-switch config key', () => {
  test("KNOWN_CONFIG_KEYS includes 'loops.extraction_enabled'", () => {
    expect(KNOWN_CONFIG_KEYS).toContain('loops.extraction_enabled');
  });
});

describe('relational edge vocabulary', () => {
  test("KNOWN_LINK_TYPES includes 'owes_to' and 'awaiting_reply_from'", () => {
    expect(KNOWN_LINK_TYPES.has('owes_to')).toBe(true);
    expect(KNOWN_LINK_TYPES.has('awaiting_reply_from')).toBe(true);
  });

  test('gbrain-base-v2.yaml declares both verbs as link_types', () => {
    const raw = fs.readFileSync(
      path.join(REPO, 'src', 'core', 'schema-pack', 'base', 'gbrain-base-v2.yaml'),
      'utf8',
    );
    const pack = load(raw) as { link_types?: Array<{ name: string }> };
    expect(Array.isArray(pack.link_types)).toBe(true);
    const names = pack.link_types!.map((lt) => lt.name);
    expect(names).toContain('owes_to');
    expect(names).toContain('awaiting_reply_from');
  });
});

describe('loops operations contract', () => {
  const byName = new Map(operations.map((op) => [op.name, op]));

  test("open_loops / loops_close / loops_mute exist with area 'loops'", () => {
    for (const name of ['open_loops', 'loops_close', 'loops_mute']) {
      const op = byName.get(name);
      expect(op).toBeDefined();
      expect(op!.area).toBe('loops');
    }
  });

  test('open_loops is a read op and NOT localOnly (remote posture D4-A)', () => {
    const op = byName.get('open_loops')!;
    expect(op.scope).toBe('read');
    expect(op.mutating).toBeFalsy();
    expect(op.localOnly).toBeFalsy();
  });

  test('loops_close and loops_mute are mutating write ops', () => {
    for (const name of ['loops_close', 'loops_mute']) {
      const op = byName.get(name)!;
      expect(op.scope).toBe('write');
      expect(op.mutating).toBe(true);
    }
  });
});
