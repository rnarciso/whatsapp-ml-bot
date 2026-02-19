import path from 'node:path';

import { config } from './config.js';
import { logger } from './logger.js';
import { WhatsAppMlBot } from './bot/WhatsAppMlBot.js';
import { MercadoLivreClient, type MlTokens } from './services/mercadoLivre.js';
import { startCleanupLoop } from './services/cleanup.js';
import { startAdminWebServer } from './services/adminWeb.js';
import { OpenAIVisionService } from './services/openaiVision.js';
import { SettingsService } from './services/settings.js';
import { JsonDbStore } from './storage/store.js';
import { decryptJson, encryptJson } from './utils/crypto.js';

async function main(): Promise<void> {
  const dbPath = path.join(config.dataDirAbs, 'db.json');
  const store = new JsonDbStore(dbPath);

  await store.init();
  const settings = new SettingsService(store);
  await settings.init();

  const encryptionKey = config.security.storageEncryptionKey?.trim();
  const encryptionEnabled = Boolean(encryptionKey);
  if (encryptionEnabled) {
    await store.update((db) => {
      if (db.mlTokens && !db.mlTokensEncrypted) {
        db.mlTokensEncrypted = encryptJson(db.mlTokens, encryptionKey!);
        delete db.mlTokens;
      }
    });
  } else {
    const db = await store.read();
    if (db.mlTokensEncrypted) {
      throw new Error('Encrypted ML tokens found in db.json. Set STORAGE_ENCRYPTION_KEY to start the bot.');
    }
  }

  const ml = new MercadoLivreClient(
    async () => {
      const db = await store.read();
      if (db.mlTokensEncrypted) {
        if (!encryptionEnabled) {
          throw new Error('Encrypted ML tokens found, but STORAGE_ENCRYPTION_KEY is missing.');
        }
        try {
          return decryptJson<MlTokens>(db.mlTokensEncrypted, encryptionKey!);
        } catch (err) {
          throw new Error(`Failed to decrypt Mercado Livre tokens: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return db.mlTokens ?? null;
    },
    async (t: MlTokens) => {
      await store.update((db) => {
        if (encryptionEnabled) {
          db.mlTokensEncrypted = encryptJson(t, encryptionKey!);
          delete db.mlTokens;
          return;
        }
        db.mlTokens = t;
        delete db.mlTokensEncrypted;
      });
    },
  );

  const vision = new OpenAIVisionService();
  const bot = new WhatsAppMlBot(store, vision, ml, settings);
  await bot.start();

  startCleanupLoop(store, settings);
  startAdminWebServer(settings, bot);
}

main().catch((err) => {
  logger.error({ err }, 'fatal');
  process.exit(1);
});
