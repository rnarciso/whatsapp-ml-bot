import fs from 'node:fs/promises';
import path from 'node:path';

import PQueue from 'p-queue';

import type { Db } from '../types.js';
import { ensureDir, fileExists, writeFileAtomic } from '../utils/fs.js';

function defaultDb(): Db {
  return { sessions: {} };
}

function cloneJson<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T;
}

export class JsonDbStore {
  private queue = new PQueue({ concurrency: 1 });
  private cache: Db | null = null;

  constructor(private filePath: string) {}

  async init(): Promise<void> {
    await ensureDir(path.dirname(this.filePath));
    if (!(await fileExists(this.filePath))) {
      await writeFileAtomic(this.filePath, JSON.stringify(defaultDb(), null, 2));
    }
    await this.queue.add(async () => {
      // Preload cache for consistent reads.
      this.cache = await this.readUnlocked();
    });
  }

  private async readUnlocked(): Promise<Db> {
    if (this.cache) return this.cache;
    const raw = await fs.readFile(this.filePath, 'utf8');
    const parsed = JSON.parse(raw) as Db;
    if (!parsed.sessions) parsed.sessions = {};
    this.cache = parsed;
    return parsed;
  }

  async read(): Promise<Db> {
    // Route reads through the same queue as writes to avoid seeing stale state.
    return this.queue.add(async () => cloneJson(await this.readUnlocked()));
  }

  async update(mutator: (db: Db) => void | Promise<void>): Promise<Db> {
    return this.queue.add(async () => {
      const current = await this.readUnlocked();
      const db = cloneJson(current);
      await mutator(db);
      if (!db.sessions) db.sessions = {};
      await writeFileAtomic(this.filePath, JSON.stringify(db, null, 2));
      this.cache = db;
      return cloneJson(db);
    });
  }
}
