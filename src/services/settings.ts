import { z } from 'zod';

import { config } from '../config.js';
import { logger } from '../logger.js';
import type { JsonDbStore } from '../storage/store.js';
import type { AppSettings } from '../types.js';

const settingsSchema = z.object({
  require_command_for_images: z.boolean(),
  photo_collect_window_sec: z.number().int().min(5).max(300),
  max_image_bytes: z.number().int().min(0).max(50_000_000),
  max_photos_per_session: z.number().int().min(1).max(20),
  media_retention_hours: z.number().int().min(1).max(24 * 90),
  session_inactive_hours: z.number().int().min(1).max(24 * 30),
  session_retention_days: z.number().int().min(1).max(3650),
});

const DEFAULT_SETTINGS: AppSettings = {
  require_command_for_images: config.wa.requireCommandForImages,
  photo_collect_window_sec: config.photoCollectWindowSec,
  max_image_bytes: config.wa.maxImageBytes,
  max_photos_per_session: 8,
  media_retention_hours: config.cleanup.mediaRetentionHours,
  session_inactive_hours: config.cleanup.sessionInactiveHours,
  session_retention_days: config.cleanup.sessionRetentionDays,
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
  { key: 'media_retention_hours', description: 'Retencao de fotos locais (horas)' },
  { key: 'session_inactive_hours', description: 'Horas para expirar sessao inativa' },
  { key: 'session_retention_days', description: 'Dias para remover sessoes antigas' },
];

