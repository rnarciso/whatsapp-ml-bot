import { describe, expect, it } from 'vitest';

import { analyzePrices } from '../src/services/pricing.js';

describe('analyzePrices', () => {
  it('returns fair, fast and profit suggestions', () => {
    const items = [
      { id: '1', title: 'A', price: 1000, currency_id: 'BRL' },
      { id: '2', title: 'B', price: 1100, currency_id: 'BRL' },
      { id: '3', title: 'C', price: 1200, currency_id: 'BRL' },
      { id: '4', title: 'D', price: 1300, currency_id: 'BRL' },
      { id: '5', title: 'E', price: 1400, currency_id: 'BRL' },
      { id: '6', title: 'F', price: 1500, currency_id: 'BRL' },
      { id: '7', title: 'G', price: 1600, currency_id: 'BRL' },
    ];

    const analysis = analyzePrices(items, 'BRL');
    expect(analysis).not.toBeNull();
    expect(analysis!.suggested_fast).toBeLessThan(analysis!.suggested_fair);
    expect(analysis!.suggested_profit).toBeGreaterThan(analysis!.suggested_fair);
  });
});
