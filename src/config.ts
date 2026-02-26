import 'dotenv/config';

import path from 'node:path';
import { z } from 'zod';

const envSchema = z.object({
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  DATA_DIR: z.string().default('./data'),

  WA_SESSION_DIR: z.string().default('./data/wa_auth'),
  WA_ALLOWED_GROUP_IDS: z.string().optional(),
  PHOTO_COLLECT_WINDOW_SEC: z.coerce.number().int().min(5).max(300).default(45),
  WA_REQUIRE_COMMAND_FOR_IMAGES: z.preprocess((v) => {
    if (v === undefined) return false;
    const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
    return ['1', 'true', 'yes', 'y', 'sim', 's'].includes(s);
  }, z.boolean()),
  BOT_CONVERSATION_MODE: z.enum(['guided', 'kv']).default('guided'),
  BOT_SESSION_SCOPE: z.enum(['group', 'user']).default('group'),
  WA_MAX_IMAGE_BYTES: z.coerce.number().int().min(0).max(50_000_000).default(10_000_000),
  WA_HUMAN_DELAY_MS_MIN: z.coerce.number().int().min(0).max(30_000).default(1_000),
  WA_HUMAN_DELAY_MS_MAX: z.coerce.number().int().min(0).max(30_000).default(3_000),
  WA_SEND_INTERVAL_MS: z.coerce.number().int().min(250).max(60_000).default(1_000),
  WA_SEND_INTERVAL_CAP: z.coerce.number().int().min(1).max(60).default(3),

  ADMIN_WEB_ENABLED: z.preprocess((v) => {
    if (v === undefined) return true;
    const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
    return ['1', 'true', 'yes', 'y', 'sim', 's'].includes(s);
  }, z.boolean()),
  ADMIN_WEB_HOST: z.string().default('127.0.0.1'),
  ADMIN_WEB_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  ADMIN_WEB_TOKEN: z.string().optional(),

  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().optional(),
  OPENAI_MODEL_VISION: z.string().default('gpt-4o-mini'),
  OPENAI_MODEL_VISION_FALLBACK: z.string().optional(),

  ML_SITE_ID: z.string().default('MLB'),
  ML_CLIENT_ID: z.string().optional(),
  ML_CLIENT_SECRET: z.string().optional(),
  ML_REFRESH_TOKEN: z.string().optional(),
  ML_CURRENCY_ID: z.string().default('BRL'),
  ML_LISTING_TYPE_ID: z.string().default('gold_special'),
  ML_BUYING_MODE: z.string().default('buy_it_now'),
  ML_DEFAULT_QUANTITY: z.coerce.number().int().min(1).max(9999).default(1),
  ML_DRY_RUN: z.preprocess((v) => {
    const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
    return ['1', 'true', 'yes', 'y', 'sim', 's'].includes(s);
  }, z.boolean()),

  MEDIA_RETENTION_HOURS: z.coerce.number().int().min(1).max(24 * 90).default(168),
  SESSION_INACTIVE_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(72),
  SESSION_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  CLEANUP_INTERVAL_MIN: z.coerce.number().int().min(5).max(24 * 60).default(360),

  STORAGE_ENCRYPTION_KEY: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  // Make it very obvious what is missing/misconfigured.
  // eslint-disable-next-line no-console
  console.error(parsed.error.format());
  process.exit(1);
}

const env = parsed.data;

const cwd = process.cwd();
const dataDirAbs = path.isAbsolute(env.DATA_DIR) ? env.DATA_DIR : path.join(cwd, env.DATA_DIR);
const waSessionDirAbs = path.isAbsolute(env.WA_SESSION_DIR)
  ? env.WA_SESSION_DIR
  : path.join(cwd, env.WA_SESSION_DIR);

const allowedGroupIds =
  env.WA_ALLOWED_GROUP_IDS?.split(',')
    .map((s) => s.trim())
    .filter(Boolean) ?? [];

function normalizeBaseUrl(raw: string | undefined): string | undefined {
  const s = raw?.trim();
  if (!s) return undefined;
  const noSlash = s.replace(/\/+$/, '');
  if (noSlash.endsWith('/v1')) return noSlash;
  return `${noSlash}/v1`;
}

const openaiBaseUrl = normalizeBaseUrl(env.OPENAI_BASE_URL);
const openaiApiKeyRaw = env.OPENAI_API_KEY?.trim();
// Some OpenAI-compatible gateways don't require auth, but the OpenAI SDK still wants a non-empty key.
const openaiApiKey = openaiApiKeyRaw || 'local';

export const config = {
  logLevel: env.LOG_LEVEL,
  dataDirAbs,
  waSessionDirAbs,
  allowedGroupIds,
  photoCollectWindowSec: env.PHOTO_COLLECT_WINDOW_SEC,
  wa: {
    requireCommandForImages: env.WA_REQUIRE_COMMAND_FOR_IMAGES,
    conversationMode: env.BOT_CONVERSATION_MODE,
    sessionScope: env.BOT_SESSION_SCOPE,
    maxImageBytes: env.WA_MAX_IMAGE_BYTES,
    humanDelayMsMin: Math.min(env.WA_HUMAN_DELAY_MS_MIN, env.WA_HUMAN_DELAY_MS_MAX),
    humanDelayMsMax: Math.max(env.WA_HUMAN_DELAY_MS_MIN, env.WA_HUMAN_DELAY_MS_MAX),
    sendIntervalMs: env.WA_SEND_INTERVAL_MS,
    sendIntervalCap: env.WA_SEND_INTERVAL_CAP,
  },
  adminWeb: {
    enabled: env.ADMIN_WEB_ENABLED,
    host: env.ADMIN_WEB_HOST,
    port: env.ADMIN_WEB_PORT,
    token: env.ADMIN_WEB_TOKEN,
  },
  openai: {
    apiKey: openaiApiKey,
    baseUrl: openaiBaseUrl,
    modelVision: env.OPENAI_MODEL_VISION,
    modelVisionFallback: env.OPENAI_MODEL_VISION_FALLBACK,
  },
  ml: {
    siteId: env.ML_SITE_ID,
    clientId: env.ML_CLIENT_ID,
    clientSecret: env.ML_CLIENT_SECRET,
    refreshToken: env.ML_REFRESH_TOKEN,
    currencyId: env.ML_CURRENCY_ID,
    listingTypeId: env.ML_LISTING_TYPE_ID,
    buyingMode: env.ML_BUYING_MODE,
    defaultQuantity: env.ML_DEFAULT_QUANTITY,
    dryRun: env.ML_DRY_RUN,
  },
  cleanup: {
    mediaRetentionHours: env.MEDIA_RETENTION_HOURS,
    sessionInactiveHours: env.SESSION_INACTIVE_HOURS,
    sessionRetentionDays: env.SESSION_RETENTION_DAYS,
    intervalMin: env.CLEANUP_INTERVAL_MIN,
  },
  security: {
    storageEncryptionKey: env.STORAGE_ENCRYPTION_KEY,
  },
} as const;
