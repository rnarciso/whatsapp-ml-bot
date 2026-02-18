export function formatBRL(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
}

