import fs from 'node:fs/promises';
import path from 'node:path';

import { config } from '../config.js';
import { logger } from '../logger.js';
import type { SettingsService } from './settings.js';
import type { JsonDbStore } from '../storage/store.js';
import type { Session } from '../types.js';

const TERMINAL_STATUSES = new Set<Session['status']>(['done', 'cancelled', 'error']);

function uniq<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

async function safeUnlink(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (err: any) {
    if (err?.code === 'ENOENT') return;
    logger.warn({ err, filePath }, 'failed to delete media file');
  }
}

export async function runCleanupOnce(store: JsonDbStore, settingsService?: SettingsService): Promise<void> {
  const settings = settingsService?.get();
  const now = Date.now();
  const inactiveCutoff = now - (settings?.session_inactive_hours ?? config.cleanup.sessionInactiveHours) * 3600_000;
  const mediaCutoff = now - (settings?.media_retention_hours ?? config.cleanup.mediaRetentionHours) * 3600_000;
  const sessionCutoff = now - (settings?.session_retention_days ?? config.cleanup.sessionRetentionDays) * 86400_000;

  const db = await store.read();

  const sessionsToCancel: string[] = [];
  const sessionsToDelete: string[] = [];
  const sessionsToClearPhotos: string[] = [];
  const mediaToDelete: string[] = [];
  const referencedMedia = new Set<string>();

  for (const [id, s] of Object.entries(db.sessions)) {
    for (const p of s.photos ?? []) {
      if (p?.filePath) referencedMedia.add(p.filePath);
    }

    const updatedAt = s.updatedAt ?? s.createdAt ?? 0;
    const isTerminal = TERMINAL_STATUSES.has(s.status);

    if (!isTerminal && updatedAt > 0 && updatedAt < inactiveCutoff) {
      sessionsToCancel.push(id);
      continue;
    }

    if (!isTerminal) continue;

    if (updatedAt > 0 && updatedAt < mediaCutoff && s.photos.length > 0) {
      sessionsToClearPhotos.push(id);
      mediaToDelete.push(...s.photos.map((p) => p.filePath));
    }

    if (updatedAt > 0 && updatedAt < sessionCutoff) {
      sessionsToDelete.push(id);
      mediaToDelete.push(...s.photos.map((p) => p.filePath));
    }
  }

  // Best-effort cleanup of orphan files (e.g., bot crashed after download but before db write).
  try {
    const mediaDir = path.join(config.dataDirAbs, 'media');
    const entries = await fs.readdir(mediaDir, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      const filePath = path.join(mediaDir, ent.name);
      if (referencedMedia.has(filePath)) continue;
      const st = await fs.stat(filePath);
      if (st.mtimeMs < mediaCutoff) mediaToDelete.push(filePath);
    }
  } catch (err) {
    logger.warn({ err }, 'failed to scan media dir for orphans');
  }

  const files = uniq(mediaToDelete).filter(Boolean);
  await Promise.all(files.map((p) => safeUnlink(p)));

  if (sessionsToCancel.length === 0 && sessionsToClearPhotos.length === 0 && sessionsToDelete.length === 0) return;

  await store.update((db2) => {
    const now2 = Date.now();

    for (const id of sessionsToCancel) {
      const s = db2.sessions[id];
      if (!s) continue;
      if (TERMINAL_STATUSES.has(s.status)) continue;
      s.status = 'cancelled';
      s.error = s.error ?? 'expired_due_to_inactivity';
      s.updatedAt = now2;
    }

    for (const id of sessionsToClearPhotos) {
      const s = db2.sessions[id];
      if (!s) continue;
      if (!TERMINAL_STATUSES.has(s.status)) continue;
      s.photos = [];
      s.updatedAt = now2;
    }

    for (const id of sessionsToDelete) {
      delete db2.sessions[id];
    }
  });

  logger.info(
    {
      cancelled: sessionsToCancel.length,
      cleared_photos: sessionsToClearPhotos.length,
      deleted_sessions: sessionsToDelete.length,
      deleted_files: files.length,
    },
    'cleanup finished',
  );
}

export function startCleanupLoop(store: JsonDbStore, settingsService?: SettingsService): NodeJS.Timeout {
  const fallbackIntervalMs = Math.max(60_000, config.cleanup.intervalMin * 60_000);
  // Run once shortly after startup (gives time for initial db creation).
  setTimeout(() => void runCleanupOnce(store, settingsService).catch((err) => logger.warn({ err }, 'cleanup failed')), 5_000);

  let timer: NodeJS.Timeout;
  const tick = async () => {
    try {
      await runCleanupOnce(store, settingsService);
    } catch (err) {
      logger.warn({ err }, 'cleanup failed');
    } finally {
      const mins = settingsService?.get().cleanup_interval_min;
      const nextMs = mins ? Math.max(60_000, mins * 60_000) : fallbackIntervalMs;
      timer = setTimeout(() => void tick(), nextMs);
    }
  };
  timer = setTimeout(() => void tick(), fallbackIntervalMs);
  return timer;
}
