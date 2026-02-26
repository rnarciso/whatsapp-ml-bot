import type { ItemCondition, ListingDraft, PriceAnalysis, VisionResult } from '../types.js';
import { formatBRL } from '../utils/format.js';
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

function conditionLabel(cond: ItemCondition): string {
  if (cond === 'new') return 'Novo';
  if (cond === 'used') return 'Usado';
  if (cond === 'refurbished') return 'Recondicionado';
  return 'Nao informado';
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
  const brandRaw = (input.marca ?? input.brand ?? '').trim() || vision.product.brand || '';
  const modelRaw = (input.modelo ?? input.model ?? '').trim() || vision.product.model || '';

  const sections: string[] = [];
  sections.push(descriptionBase);

  const ficha: string[] = [];
  if (brandRaw) ficha.push(`Marca: ${brandRaw}`);
  if (modelRaw) ficha.push(`Modelo: ${modelRaw}`);
  if (vision.product.variant) ficha.push(`Versao/Variante: ${vision.product.variant}`);
  if (vision.product.color) ficha.push(`Cor: ${vision.product.color}`);
  if (vision.product.material) ficha.push(`Material: ${vision.product.material}`);
  ficha.push(`Condicao: ${conditionLabel(condition)}`);
  ficha.push(`Quantidade: ${quantity}`);
  if (price) {
    ficha.push(
      `Faixa de mercado observada: ${formatBRL(price.p25)} a ${formatBRL(price.p75)} (mediana ${formatBRL(price.median)})`,
    );
  }
  if (ficha.length) {
    sections.push(['Ficha rapida:', ...ficha.map((l) => `- ${l}`)].join('\n'));
  }

  const includedLines: string[] = [];
  const includes = input.acompanha ?? input.itens ?? input.incluso;
  if (includes) includedLines.push(includes);
  if (vision.product.included?.length) {
    for (const v of vision.product.included.slice(0, 8)) {
      if (!includedLines.some((i) => i.toLowerCase() === v.toLowerCase())) includedLines.push(v);
    }
  }
  if (includedLines.length) {
    sections.push(['O que acompanha:', ...includedLines.map((l) => `- ${l}`)].join('\n'));
  }

  const defectsLines: string[] = [];
  const defects = input.defeitos ?? input.avarias ?? input.problemas;
  if (defects) defectsLines.push(defects);
  if (vision.product.defects?.length) {
    for (const v of vision.product.defects.slice(0, 8)) {
      if (!defectsLines.some((i) => i.toLowerCase() === v.toLowerCase())) defectsLines.push(v);
    }
  }
  if (defectsLines.length) {
    sections.push(['Defeitos/avarias informados:', ...defectsLines.map((l) => `- ${l}`)].join('\n'));
  }

  const obs = input.observacoes ?? input.observações ?? input.obs;
  if (obs) sections.push(['Observacoes do vendedor:', `- ${obs}`].join('\n'));
  if (vision.product.notes?.length) {
    sections.push(['Observacoes adicionais identificadas nas fotos:', ...vision.product.notes.slice(0, 6).map((n) => `- ${n}`)].join('\n'));
  }

  const description = sections.filter(Boolean).join('\n\n---\n\n');

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
