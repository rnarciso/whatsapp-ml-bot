import type { ListingDraft } from '../types.js';

export function buildCreateItemPayload(
  draft: ListingDraft,
  pictureIds: string[],
  opts: { buyingMode: string; listingTypeId: string },
): Record<string, unknown> {
  if (!draft.category_id) throw new Error('category_id is missing');
  if (!draft.price_chosen || !Number.isFinite(draft.price_chosen) || draft.price_chosen <= 0) {
    throw new Error('price is missing/invalid');
  }
  if (draft.condition === 'unknown') throw new Error('condition is unknown; set condicao=novo|usado');

  return {
    title: draft.title,
    category_id: draft.category_id,
    price: draft.price_chosen,
    currency_id: draft.currency_id,
    available_quantity: draft.quantity,
    buying_mode: opts.buyingMode,
    listing_type_id: opts.listingTypeId,
    condition: draft.condition,
    status: 'paused',
    pictures: pictureIds.map((id) => ({ id })),
    attributes: Object.entries(draft.attributes)
      .map(([id, value]) => {
        if (value.value_id) return { id, value_id: value.value_id };
        if (value.value_name) return { id, value_name: value.value_name };
        return null;
      })
      .filter(Boolean),
  };
}
