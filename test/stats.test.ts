import { describe, expect, it } from 'vitest';

import { median, quantile, roundDownTo, roundTo } from '../src/utils/stats.js';

describe('stats', () => {
  it('quantile/median work on sorted arrays', () => {
    const sorted = [10, 20, 30, 40];
    expect(quantile(sorted, 0)).toBe(10);
    expect(quantile(sorted, 1)).toBe(40);
    expect(quantile(sorted, 0.5)).toBe(25);
    expect(median([40, 10, 20, 30])).toBe(25);
  });

  it('rounding helpers', () => {
    expect(roundTo(123, 10)).toBe(120);
    expect(roundTo(125, 10)).toBe(130);
    expect(roundDownTo(129, 10)).toBe(120);
  });
});

