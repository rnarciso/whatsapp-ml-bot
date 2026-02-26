import { config } from '../config.js';
import { logger } from '../logger.js';
import type { ComparableItem } from '../types.js';

export interface MlTokens {
  access_token: string;
  refresh_token: string;
  expires_at_ms: number;
}

export interface MlCategoryPrediction {
  category_id: string;
  category_name?: string;
}

export interface MlSearchResult {
  results: ComparableItem[];
}

export interface MlPictureUploadResult {
  id: string;
  url?: string;
}

export interface MlCreateItemResult {
  id: string;
  permalink?: string;
  status?: string;
}

export interface MlCategoryAttribute {
  id: string;
  name: string;
  tags?: Record<string, unknown>;
  value_type?: string;
  values?: Array<{ id?: string; name?: string }>;
}

type MlRuntime = {
  siteId: string;
  clientId: string | undefined;
  clientSecret: string | undefined;
  refreshToken: string | undefined;
  currencyId: string;
  listingTypeId: string;
  buyingMode: string;
  defaultQuantity: number;
  dryRun: boolean;
};

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function asBool(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

function asString(v: unknown): v is string {
  return typeof v === 'string';
}

function asNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function urlJoin(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path.startsWith('/') ? '' : '/'}${path}`;
}

function safeJsonLower(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}).toLowerCase();
  } catch {
    return '';
  }
}

export class MercadoLivreClient {
  private baseUrl = 'https://api.mercadolibre.com';
  private tokens: MlTokens | null = null;
  private refreshInFlight: Promise<string> | null = null;

  constructor(
    private getTokens: () => Promise<MlTokens | null>,
    private saveTokens: (t: MlTokens) => Promise<void>,
    private getRuntime?: () => MlRuntime,
  ) {}

  private runtime(): MlRuntime {
    if (this.getRuntime) return this.getRuntime();
    return {
      siteId: config.ml.siteId,
      clientId: config.ml.clientId ?? undefined,
      clientSecret: config.ml.clientSecret ?? undefined,
      refreshToken: config.ml.refreshToken ?? undefined,
      currencyId: config.ml.currencyId,
      listingTypeId: config.ml.listingTypeId,
      buyingMode: config.ml.buyingMode,
      defaultQuantity: config.ml.defaultQuantity,
      dryRun: config.ml.dryRun,
    };
  }

  private async apiFetch<T = unknown>(
    method: string,
    path: string,
    opts?: { auth?: boolean; query?: Record<string, string | number | undefined>; body?: JsonValue | FormData },
  ): Promise<T> {
    const url = new URL(urlJoin(this.baseUrl, path));
    if (opts?.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v === undefined) continue;
        url.searchParams.set(k, String(v));
      }
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
    };

    let body: any;
    if (opts?.body instanceof FormData) {
      body = opts.body as any;
      // fetch will set multipart boundaries automatically.
    } else if (opts?.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }

    if (opts?.auth) {
      const token = await this.getAccessToken();
      headers.Authorization = `Bearer ${token}`;
    }

    const res = await fetch(url, { method, headers, body });
    const raw = await res.text();
    const isJson = res.headers.get('content-type')?.includes('application/json');
    const data = (isJson && raw ? (JSON.parse(raw) as unknown) : raw) as unknown;

    if (!res.ok) {
      logger.warn({ status: res.status, url: url.toString(), data }, 'Mercado Livre API error');
      const msg =
        (typeof data === 'object' && data && 'message' in data && asString((data as any).message) && (data as any).message) ||
        `Mercado Livre API error ${res.status}`;
      const details =
        typeof data === 'object' && data && 'cause' in data && Array.isArray((data as any).cause) ? (data as any).cause : undefined;
      const err = new Error(msg);
      (err as any).status = res.status;
      (err as any).data = data;
      (err as any).cause_details = details;
      throw err;
    }

    return data as T;
  }

  private async canUseOAuth(): Promise<boolean> {
    const rt = this.runtime();
    if (!rt.clientId || !rt.clientSecret) return false;
    if (!this.tokens) this.tokens = await this.getTokens();
    return Boolean(this.tokens?.refresh_token || rt.refreshToken);
  }

  private isPolicyAgentForbidden(err: any): boolean {
    const data = err?.data;
    return (
      err?.status === 403 &&
      (data?.code === 'PA_UNAUTHORIZED_RESULT_FROM_POLICIES' ||
        data?.blocked_by === 'PolicyAgent' ||
        data?.error === 'forbidden')
    );
  }

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (!this.tokens) this.tokens = await this.getTokens();

    if (this.tokens && this.tokens.expires_at_ms > now + 60_000) {
      return this.tokens.access_token;
    }

    // Refresh tokens can be rotated/one-time-use. Ensure only one refresh happens at a time.
    if (this.refreshInFlight) return this.refreshInFlight;

    const rt = this.runtime();
    if (!rt.clientId || !rt.clientSecret || !(this.tokens?.refresh_token || rt.refreshToken)) {
      throw new Error('Missing Mercado Livre credentials. Set ML_CLIENT_ID, ML_CLIENT_SECRET and ML_REFRESH_TOKEN.');
    }

    this.refreshInFlight = (async () => {
      // Re-check after we become the "refresher" (another call might have refreshed already).
      const now2 = Date.now();
      if (!this.tokens) this.tokens = await this.getTokens();
      if (this.tokens && this.tokens.expires_at_ms > now2 + 60_000) {
        return this.tokens.access_token;
      }

      const refreshToken = this.tokens?.refresh_token ?? rt.refreshToken!;

      const form = new URLSearchParams();
      form.set('grant_type', 'refresh_token');
      form.set('client_id', rt.clientId!);
      form.set('client_secret', rt.clientSecret!);
      form.set('refresh_token', refreshToken);

      const res = await fetch(urlJoin(this.baseUrl, '/oauth/token'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: form,
      });

      const data = (await res.json()) as any;
      if (!res.ok) {
        logger.error({ status: res.status, data }, 'Mercado Livre token refresh failed');
        if (data?.error === 'invalid_grant') {
          throw new Error('Mercado Livre OAuth: refresh token inválido/expirado. Reautorize e atualize ML_REFRESH_TOKEN.');
        }
        const msg = asString(data?.message) ? data.message : asString(data?.error_description) ? data.error_description : '';
        throw new Error(`Mercado Livre token refresh failed (${res.status})${msg ? `: ${msg}` : ''}`);
      }

      if (!asString(data.access_token) || !asString(data.refresh_token) || !asNumber(data.expires_in)) {
        throw new Error('Unexpected token response from Mercado Livre');
      }

      const t: MlTokens = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at_ms: Date.now() + Math.max(0, data.expires_in - 60) * 1000,
      };

      this.tokens = t;
      await this.saveTokens(t);
      return t.access_token;
    })();

    try {
      return await this.refreshInFlight;
    } finally {
      this.refreshInFlight = null;
    }
  }

  async predictCategory(title: string): Promise<MlCategoryPrediction | null> {
    const site = this.runtime().siteId;
    let data: any;
    try {
      data = await this.apiFetch<any>('GET', `/sites/${site}/category_predictor/predict`, { query: { title } });
    } catch (err) {
      if (!this.isPolicyAgentForbidden(err) || !(await this.canUseOAuth())) throw err;
      data = await this.apiFetch<any>('GET', `/sites/${site}/category_predictor/predict`, { auth: true, query: { title } });
    }

    if (!data || !asString(data.id)) return null;
    return { category_id: data.id, category_name: asString(data.name) ? data.name : undefined };
  }

  async searchSimilar(query: string, categoryId?: string): Promise<MlSearchResult> {
    const rt = this.runtime();
    const site = rt.siteId;
    let data: any;
    try {
      data = await this.apiFetch<any>('GET', `/sites/${site}/search`, { query: { q: query, category: categoryId, limit: 50 } });
    } catch (err) {
      if (!this.isPolicyAgentForbidden(err) || !(await this.canUseOAuth())) throw err;
      data = await this.apiFetch<any>('GET', `/sites/${site}/search`, { auth: true, query: { q: query, category: categoryId, limit: 50 } });
    }

    const results = Array.isArray(data?.results) ? data.results : [];
    const mapped: ComparableItem[] = results
      .map((r: any) => ({
        id: String(r.id ?? ''),
        title: String(r.title ?? ''),
        price: Number(r.price ?? NaN),
        currency_id: String(r.currency_id ?? rt.currencyId),
        permalink: asString(r.permalink) ? r.permalink : undefined,
        condition: asString(r.condition) ? r.condition : undefined,
        sold_quantity: typeof r.sold_quantity === 'number' ? r.sold_quantity : undefined,
      }))
      .filter((r: ComparableItem) => r.id && r.title && Number.isFinite(r.price));

    return { results: mapped };
  }

  async getMe(): Promise<{ id: number; nickname?: string }> {
    const data = await this.apiFetch<any>('GET', '/users/me', { auth: true });
    if (!data || !asNumber(data.id)) throw new Error('Invalid /users/me response');
    return { id: data.id, nickname: asString(data.nickname) ? data.nickname : undefined };
  }

  async uploadPicture(buf: Buffer, fileName: string, mimeType: string): Promise<MlPictureUploadResult> {
    const form = new FormData();
    // Convert Buffer -> Uint8Array to satisfy Blob typings on newer Node.
    form.append('file', new Blob([new Uint8Array(buf)], { type: mimeType }), fileName);

    const data = await this.apiFetch<any>('POST', '/pictures/items/upload', { auth: true, body: form });
    if (!data || !asString(data.id)) throw new Error('Invalid picture upload response');
    return { id: data.id, url: asString(data.variations?.[0]?.url) ? data.variations[0].url : undefined };
  }

  async createItem(payload: Record<string, unknown>): Promise<MlCreateItemResult> {
    if (this.runtime().dryRun) {
      logger.info({ payload }, 'ML_DRY_RUN=true; skipping createItem');
      return { id: 'DRY_RUN_ITEM_ID', status: 'paused' };
    }

    const parseResult = (data: any): MlCreateItemResult => {
      if (!data || !asString(data.id)) throw new Error('Invalid create item response');
      return { id: data.id, permalink: asString(data.permalink) ? data.permalink : undefined, status: asString(data.status) ? data.status : undefined };
    };

    const adjustPayload = (current: Record<string, unknown>, errData: any): Record<string, unknown> | null => {
      const message = asString(errData?.message) ? errData.message.toLowerCase() : '';
      const errorText = asString(errData?.error) ? errData.error.toLowerCase() : '';
      const lower = safeJsonLower(errData);

      const invalidTitle =
        (message === 'body.invalid_fields' && (errorText.includes('[title]') || lower.includes('[title]'))) ||
        lower.includes('fields [title] are invalid');
      const missingFamilyName =
        (message === 'body.required_fields' && (errorText.includes('[family_name]') || lower.includes('[family_name]'))) ||
        lower.includes('family_name');
      if (!invalidTitle && !missingFamilyName) return null;

      const next: Record<string, unknown> = { ...current };
      const currentTitle = asString(next.title) ? next.title.trim() : '';
      let changed = false;

      if (missingFamilyName && !asString(next.family_name) && currentTitle) {
        next.family_name = currentTitle;
        changed = true;
      }
      if (invalidTitle && 'title' in next) {
        delete next.title;
        changed = true;
      }
      if (invalidTitle && !asString(next.family_name) && currentTitle) {
        next.family_name = currentTitle;
        changed = true;
      }

      if (!changed) return null;
      logger.warn({ invalidTitle, missingFamilyName }, 'Retrying createItem with catalog-safe payload');
      return next;
    };

    let currentPayload: Record<string, unknown> = { ...payload };
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const data = await this.apiFetch<any>('POST', '/items', { auth: true, body: currentPayload as any });
        return parseResult(data);
      } catch (err: any) {
        lastErr = err;
        if (attempt >= 3) break;
        const nextPayload = adjustPayload(currentPayload, err?.data);
        if (!nextPayload) break;
        currentPayload = nextPayload;
      }
    }
    throw lastErr;
  }

  async getCategoryAttributes(categoryId: string): Promise<MlCategoryAttribute[]> {
    let data: any;
    try {
      data = await this.apiFetch<any>('GET', `/categories/${categoryId}/attributes`);
    } catch (err) {
      if (!this.isPolicyAgentForbidden(err) || !(await this.canUseOAuth())) throw err;
      data = await this.apiFetch<any>('GET', `/categories/${categoryId}/attributes`, { auth: true });
    }
    if (!Array.isArray(data)) return [];
    return data
      .map((a: any) => {
        const out: MlCategoryAttribute = { id: String(a?.id ?? ''), name: String(a?.name ?? '') };
        if (typeof a?.tags === 'object' && a.tags) out.tags = a.tags as Record<string, unknown>;
        if (asString(a?.value_type)) out.value_type = a.value_type;
        if (Array.isArray(a?.values)) {
          const values = a.values
            .map((v: any) => ({ id: asString(v?.id) ? v.id : undefined, name: asString(v?.name) ? v.name : undefined }))
            .filter((v: any) => v.id || v.name);
          if (values.length) out.values = values;
        }
        return out;
      })
      .filter((a: MlCategoryAttribute) => a.id && a.name);
  }

  async pauseItem(itemId: string): Promise<void> {
    if (this.runtime().dryRun) return;
    await this.apiFetch('PUT', `/items/${itemId}`, { auth: true, body: { status: 'paused' } });
  }

  async setDescription(itemId: string, plainText: string): Promise<void> {
    if (this.runtime().dryRun) return;
    await this.apiFetch('POST', `/items/${itemId}/description`, { auth: true, body: { plain_text: plainText } });
  }
}
