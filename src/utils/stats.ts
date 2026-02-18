export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  if (q <= 0) return sorted[0]!;
  if (q >= 1) return sorted[sorted.length - 1]!;

  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const a = sorted[base]!;
  const b = sorted[base + 1] ?? a;
  return a + rest * (b - a);
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return quantile(sorted, 0.5);
}

export function roundTo(value: number, step: number): number {
  if (!Number.isFinite(value)) return value;
  if (step <= 0) return value;
  return Math.round(value / step) * step;
}

export function roundDownTo(value: number, step: number): number {
  if (!Number.isFinite(value)) return value;
  if (step <= 0) return value;
  return Math.floor(value / step) * step;
}

