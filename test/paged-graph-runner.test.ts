import { describe, expect, test } from 'bun:test';
import { medianFromHistogram } from '../src/core/graph-usefulness/paged-runner.ts';

describe('paged measure median', () => {
  test('matches percentile_cont(0.5) on a zero-heavy histogram', () => {
    expect(medianFromHistogram({ '0': 4, '2': 1 })).toBe(0);
    expect(medianFromHistogram({ '1': 1 })).toBe(1);
    expect(medianFromHistogram({})).toBe(0);
  });

  test('interpolates between the two middle degrees', () => {
    expect(medianFromHistogram({ '0': 1, '2': 1 })).toBe(1);
  });
});
