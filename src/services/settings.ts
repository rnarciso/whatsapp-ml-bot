import { z } from 'zod';

import { config } from '../config.js';
import { logger } from '../logger.js';
import type { JsonDbStore } from '../storage/store.js';
import type { AppSettings } from '../types.js';

const settingsSchema = z.object({
  openai_base_url: z.string(),
  openai_api_key: z.string(),
  openai_model_vision: z.string().min(1),
  openai_model_vision_fallback: z.string(),

  ml_site_id: z.string().min(1),
  ml_client_id: z.string(),
  ml_client_secret: z.string(),
  ml_refresh_token: z.string(),
  ml_currency_id: z.string().min(1),
  ml_listing_type_id: z.string().min(1),
  ml_buying_mode: z.string().min(1),
  ml_default_quantity: z.number().int().min(1).max(9999),
  ml_dry_run: z.boolean(),

  require_command_for_images: z.boolean(),
  photo_collect_window_sec: z.number().int().min(5).max(300),
  max_image_bytes: z.number().int().min(0).max(50_000_000),
  max_photos_per_session: z.number().int().min(1).max(20),
  wa_human_delay_ms_min: z.number().int().min(0).max(30_000),
  wa_human_delay_ms_max: z.number().int().min(0).max(30_000),
  wa_send_interval_ms: z.number().int().min(250).max(60_000),
  wa_send_interval_cap: z.number().int().min(1).max(60),
  media_retention_hours: z.number().int().min(1).max(24 * 90),
  session_inactive_hours: z.number().int().min(1).max(24 * 30),
  session_retention_days: z.number().int().min(1).max(3650),
  cleanup_interval_min: z.number().int().min(5).max(24 * 60),
});

const DEFAULT_SETTINGS: AppSettings = {
  openai_base_url: config.openai.baseUrl ?? '',
  openai_api_key: config.openai.apiKey === 'local' ? '' : config.openai.apiKey,
  openai_model_vision: config.openai.modelVision,
  openai_model_vision_fallback: config.openai.modelVisionFallback ?? '',

  ml_site_id: config.ml.siteId,
  ml_client_id: config.ml.clientId ?? '',
  ml_client_secret: config.ml.clientSecret ?? '',
  ml_refresh_token: config.ml.refreshToken ?? '',
  ml_currency_id: config.ml.currencyId,
  ml_listing_type_id: config.ml.listingTypeId,
  ml_buying_mode: config.ml.buyingMode,
  ml_default_quantity: config.ml.defaultQuantity,
  ml_dry_run: config.ml.dryRun,

  require_command_for_images: config.wa.requireCommandForImages,
  photo_collect_window_sec: config.photoCollectWindowSec,
  max_image_bytes: config.wa.maxImageBytes,
  max_photos_per_session: 8,
  wa_human_delay_ms_min: config.wa.humanDelayMsMin,
  wa_human_delay_ms_max: config.wa.humanDelayMsMax,
  wa_send_interval_ms: config.wa.sendIntervalMs,
  wa_send_interval_cap: config.wa.sendIntervalCap,
  media_retention_hours: config.cleanup.mediaRetentionHours,
  session_inactive_hours: config.cleanup.sessionInactiveHours,
  session_retention_days: config.cleanup.sessionRetentionDays,
  cleanup_interval_min: config.cleanup.intervalMin,
};

export type MutableSettingKey = keyof AppSettings;

export class SettingsService {
  private cache: AppSettings = DEFAULT_SETTINGS;

  constructor(private store: JsonDbStore) {}

  async init(): Promise<void> {
    const db = await this.store.read();
    const merged = { ...DEFAULT_SETTINGS, ...(db.settings ?? {}) };
    const parsed = settingsSchema.safeParse(merged);
    if (!parsed.success) {
      logger.warn({ issues: parsed.error.issues }, 'invalid persisted settings; falling back to defaults');
      this.cache = DEFAULT_SETTINGS;
      await this.store.update((db2) => {
        db2.settings = this.cache;
      });
      return;
    }
    this.cache = parsed.data;
    if (!db.settings) {
      await this.store.update((db2) => {
        db2.settings = this.cache;
      });
    }
  }

  get(): AppSettings {
    return { ...this.cache };
  }

  async setMany(patch: Partial<AppSettings>): Promise<AppSettings> {
    const merged = { ...this.cache, ...patch };
    const parsed = settingsSchema.parse(merged);
    this.cache = parsed;
    await this.store.update((db) => {
      db.settings = parsed;
    });
    return this.get();
  }
}

export const mutableSettingsForChat: Array<{ key: MutableSettingKey; description: string }> = [
  { key: 'require_command_for_images', description: 'Exigir !ml-bot novo antes de aceitar fotos' },
  { key: 'photo_collect_window_sec', description: 'Janela de coleta de fotos (segundos)' },
  { key: 'max_image_bytes', description: 'Tamanho maximo da imagem (bytes)' },
  { key: 'max_photos_per_session', description: 'Quantidade maxima de fotos por anuncio' },
  { key: 'ml_dry_run', description: 'Nao publicar no ML (somente simular)' },
  { key: 'media_retention_hours', description: 'Retencao de fotos locais (horas)' },
  { key: 'session_inactive_hours', description: 'Horas para expirar sessao inativa' },
  { key: 'session_retention_days', description: 'Dias para remover sessoes antigas' },
];
