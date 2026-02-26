import type { ComparableItem, PriceAnalysis } from '../types.js';
import { quantile, roundDownTo, roundTo } from '../utils/stats.js';

function stepFor(medianValue: number): number {
  if (medianValue < 100) return 5;
  if (medianValue < 500) return 10;
  if (medianValue < 2000) return 20;
  return 50;
}

export function analyzePrices(items: ComparableItem[], preferredCurrency?: string): PriceAnalysis | null {
  const filtered = items
    .filter((i) => Number.isFinite(i.price) && i.price > 0)
    .filter((i) => (!preferredCurrency ? true : i.currency_id === preferredCurrency));

  if (filtered.length < 5) return null;

  const pricesSorted = filtered
    .map((i) => i.price)
    .filter((p) => Number.isFinite(p))
    .sort((a, b) => a - b);

  const p25 = quantile(pricesSorted, 0.25);
  const med = quantile(pricesSorted, 0.5);
  const p75 = quantile(pricesSorted, 0.75);
  const iqr = p75 - p25;

  const low = p25 - 1.5 * iqr;
  const high = p75 + 1.5 * iqr;

  const pricesNoOutliers = pricesSorted.filter((p) => p >= low && p <= high);
  const base = pricesNoOutliers.length >= 5 ? pricesNoOutliers : pricesSorted;

  const min = base[0]!;
  const max = base[base.length - 1]!;
  const q25 = quantile(base, 0.25);
  const median = quantile(base, 0.5);
  const q75 = quantile(base, 0.75);

  const step = stepFor(median);
  const suggestedFair = roundTo(median, step);
  let suggestedFast = roundDownTo(Math.min(q25, median * 0.9), step);
  if (suggestedFast >= suggestedFair) suggestedFast = Math.max(step, suggestedFair - step);
  let suggestedProfit = roundTo(Math.max(q75, median * 1.1), step);
  if (suggestedProfit <= suggestedFair) suggestedProfit = suggestedFair + step;

  const currencyId = preferredCurrency ?? filtered[0]!.currency_id;
  return {
    currency_id: currencyId,
    sample_size: base.length,
    min,
    p25: q25,
    median,
    p75: q75,
    max,
    suggested_fair: suggestedFair,
    suggested_fast: suggestedFast,
    suggested_profit: suggestedProfit,
    comparables: filtered.slice(0, 10),
  };
}
