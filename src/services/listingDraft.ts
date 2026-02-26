import type { ItemCondition, ListingDraft, PriceAnalysis, VisionResult } from '../types.js';
import { parseUserAttributeValue } from '../utils/mlAttributes.js';

function parseNumberLoose(v: string): number | null {
  const normalized = v
    .trim()
    .replace(/[R$\s]/gi, '')
    .replace(/\./g, '')
    .replace(',', '.');
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function parseCondition(v: string): ItemCondition | null {
  const s = v.trim().toLowerCase();
  if (['novo', 'nova', 'new'].includes(s)) return 'new';
  if (['usado', 'usada', 'used'].includes(s)) return 'used';
  if (['recondicionado', 'refurbished', 'remanufaturado'].includes(s)) return 'refurbished';
  return null;
}

function clampTitle(title: string): string {
  const t = title.trim().replace(/\s+/g, ' ');
  if (t.length <= 60) return t;
  return t.slice(0, 60).trim();
}

export function buildListingDraft(params: {
  vision: VisionResult;
  price: PriceAnalysis | null;
  categoryId: string | null;
  userInput: Record<string, string> | undefined;
  currencyId: string;
  defaultQuantity: number;
}): ListingDraft {
  const { vision, price, categoryId, userInput, currencyId, defaultQuantity } = params;

  const input = userInput ?? {};

  const title = clampTitle(input.titulo ?? input.title ?? vision.listing.title);

  const condition =
    parseCondition(input.condicao ?? input['condição'] ?? input.condition ?? '') ?? vision.product.condition ?? 'unknown';

  const quantity = (() => {
    const raw = input.quantidade ?? input.qtd ?? input.quantity;
    if (!raw) return defaultQuantity;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : defaultQuantity;
  })();

  const priceChosen = (() => {
    const direct = input.preco ?? input.price;
    if (direct) return parseNumberLoose(direct);

    const mode = (input.usar_preco ?? input.price_mode ?? '').trim().toLowerCase();
    if (!price) return null;
    if (mode === 'justo') return price.suggested_fair;
    if (mode === 'rapido' || mode === 'rápido' || mode === 'fast') return price.suggested_fast;
    if (mode === 'lucro' || mode === 'profit') return price.suggested_profit;
    if (mode === 'manual') return parseNumberLoose(input.preco_manual ?? input.manual_price ?? '');

    // Default: sell fast.
    return price.suggested_fast;
  })();

  const descriptionBase = vision.listing.description_ptbr.trim();
  const extraLines: string[] = [];

  const obs = input.observacoes ?? input.observações ?? input.obs;
  if (obs) extraLines.push(`Observações do vendedor: ${obs}`);

  const defects = input.defeitos ?? input.avarias ?? input.problemas;
  if (defects) extraLines.push(`Defeitos/avarias: ${defects}`);

  const includes = input.acompanha ?? input.itens ?? input.incluso;
  if (includes) extraLines.push(`O que acompanha (info do vendedor): ${includes}`);

  const description =
    extraLines.length === 0
      ? descriptionBase
      : `${descriptionBase}\n\n---\n\n${extraLines.map((l) => `- ${l}`).join('\n')}`;

  const brandRaw = (input.marca ?? input.brand ?? '').trim() || vision.product.brand || '';
  const modelRaw = (input.modelo ?? input.model ?? '').trim() || vision.product.model || '';

  const attributes: ListingDraft['attributes'] = {};
  const brand = brandRaw ? parseUserAttributeValue(brandRaw) : null;
  const model = modelRaw ? parseUserAttributeValue(modelRaw) : null;
  if (brand) attributes.BRAND = brand;
  if (model) attributes.MODEL = model;

  return {
    title,
    category_id: (input.categoria_id ?? input.category_id ?? '').trim() || categoryId,
    condition,
    quantity,
    currency_id: currencyId,
    price_fair: price?.suggested_fair ?? null,
    price_fast: price?.suggested_fast ?? null,
    price_chosen: priceChosen,
    description_ptbr: description,
    attributes,
  };
}
