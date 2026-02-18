import { describe, expect, it } from 'vitest';

import { buildListingDraft } from '../src/services/listingDraft.js';
import type { PriceAnalysis, VisionResult } from '../src/types.js';

function makeVision(): VisionResult {
  return {
    confidence: 0.9,
    product: {
      short_name: 'iPhone 13',
      likely_category: 'Celulares',
      brand: 'Apple',
      model: 'iPhone 13',
      variant: null,
      condition: 'used',
      color: 'Preto',
      material: null,
      quantity: 1,
      included: [],
      defects: [],
      notes: [],
    },
    listing: {
      title: 'iPhone 13 128GB Preto',
      title_alternatives: [],
      description_ptbr: 'Descricao base',
      search_query: 'iPhone 13 128GB',
      keywords: [],
    },
    questions: [],
  };
}

const price: PriceAnalysis = {
  currency_id: 'BRL',
  sample_size: 10,
  min: 1000,
  p25: 1500,
  median: 2000,
  p75: 2500,
  max: 3000,
  suggested_fair: 2000,
  suggested_fast: 1500,
  comparables: [],
};

describe('buildListingDraft', () => {
  it('defaults to fast price', () => {
    const draft = buildListingDraft({
      vision: makeVision(),
      price,
      categoryId: 'MLB1055',
      userInput: { condicao: 'usado' },
      currencyId: 'BRL',
      defaultQuantity: 1,
    });
    expect(draft.price_chosen).toBe(1500);
    expect(draft.category_id).toBe('MLB1055');
  });

  it('allows manual price parsing', () => {
    const draft = buildListingDraft({
      vision: makeVision(),
      price,
      categoryId: 'MLB1055',
      userInput: { preco: 'R$ 1.234,56', condicao: 'usado' },
      currencyId: 'BRL',
      defaultQuantity: 1,
    });
    expect(draft.price_chosen).toBeCloseTo(1234.56);
  });

  it('supports value_id via @ on brand/model', () => {
    const draft = buildListingDraft({
      vision: makeVision(),
      price,
      categoryId: 'MLB1055',
      userInput: { marca: '@123', modelo: '@456', condicao: 'usado' },
      currencyId: 'BRL',
      defaultQuantity: 1,
    });
    expect(draft.attributes.BRAND?.value_id).toBe('123');
    expect(draft.attributes.MODEL?.value_id).toBe('456');
  });
});

