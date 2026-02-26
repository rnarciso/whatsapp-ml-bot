import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import PQueue from 'p-queue';

import { config } from '../config.js';
import { logger } from '../logger.js';
import type { MercadoLivreClient, MlCategoryAttribute } from '../services/mercadoLivre.js';
import { buildListingDraft } from '../services/listingDraft.js';
import { buildCreateItemPayload } from '../services/mlPayload.js';
import type { OpenAIVisionService } from '../services/openaiVision.js';
import { analyzePrices } from '../services/pricing.js';
import { mutableSettingsForChat, type SettingsService } from '../services/settings.js';
import type { Db, ListingDraft, Session, VisionResult } from '../types.js';
import { ensureDir, writeFileAtomic } from '../utils/fs.js';
import { formatBRL } from '../utils/format.js';
import { normalizeYesNo, parseKeyValueLines } from '../utils/kv.js';
import { hasAttributeValue, parseUserAttributeValue } from '../utils/mlAttributes.js';
import type { JsonDbStore } from '../storage/store.js';

// Baileys message typings are quite permissive (lots of nullable fields) and
// often don't play nicely with `exactOptionalPropertyTypes`. Keep it pragmatic.
type WAMessage = any;

function nowMs(): number {
  return Date.now();
}

function isGroupJid(jid: string): boolean {
  return jid.endsWith('@g.us');
}

function getSenderId(msg: WAMessage): string | null {
  const jid = msg?.key?.remoteJid;
  if (!jid) return null;
  if (isGroupJid(jid)) return msg?.key?.participant ?? null;
  return jid;
}

function getText(msg: WAMessage): string | null {
  const m = msg.message;
  if (!m) return null;

  // Plain
  if (m.conversation) return m.conversation;

  // Extended text
  const ext = (m.extendedTextMessage as any)?.text;
  if (typeof ext === 'string') return ext;

  // Image caption
  const cap = (m.imageMessage as any)?.caption;
  if (typeof cap === 'string') return cap;

  return null;
}

function parseBotCommand(text: string): string | null {
  const cleaned = text.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (!cleaned) return null;

  const m = cleaned.match(/^(?:!|\/)?ml-bot\b\s*(.*)$/i);
  if (!m) return null;

  return (m[1] ?? '').trim().replace(/[.!?]+$/, '').trim();
}

function isImageMessage(msg: WAMessage): boolean {
  const m = msg.message as any;
  return Boolean(m?.imageMessage);
}

function mimeTypeFromImage(msg: WAMessage): string {
  const m = msg.message as any;
  const mt = m?.imageMessage?.mimetype;
  return typeof mt === 'string' && mt.startsWith('image/') ? mt : 'image/jpeg';
}

function fileLengthFromImage(msg: WAMessage): number | null {
  const m = msg.message as any;
  const v = m?.imageMessage?.fileLength;
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (v && typeof v === 'object') {
    if (typeof (v as any).toNumber === 'function') {
      try {
        const n = (v as any).toNumber();
        return Number.isFinite(n) ? n : null;
      } catch {
        // ignore
      }
    }
    const low = (v as any).low;
    const high = (v as any).high;
    if (typeof low === 'number' && typeof high === 'number') {
      return (high >>> 0) * 2 ** 32 + (low >>> 0);
    }
  }
  return null;
}

function fileExtFromMime(mimeType: string): string {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/webp') return 'webp';
  return 'jpg';
}

function findActiveSession(db: Db, groupId: string, userId: string, scope: 'group' | 'user'): Session | null {
  const active = Object.values(db.sessions)
    .filter((s) => s.groupId === groupId && (scope === 'group' || s.userId === userId))
    .filter((s) => !['done', 'cancelled', 'error'].includes(s.status))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return active[0] ?? null;
}

function humanCondition(cond: string): string {
  if (cond === 'new') return 'novo';
  if (cond === 'used') return 'usado';
  if (cond === 'refurbished') return 'recondicionado';
  return 'desconhecido';
}

function shortSessionId(id: string): string {
  return id.slice(0, 8);
}

function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function formatAnalysisErrorForUser(err: unknown): string {
  const msg =
    typeof (err as any)?.message === 'string'
      ? (err as any).message
      : typeof err === 'string'
        ? err
        : 'erro inesperado';
  if (/dados incompletos para montar o anúncio/i.test(msg)) {
    return 'A IA retornou dados incompletos para este item';
  }
  if (/modelo inválido no provedor openai-compatible/i.test(msg) || /invalid model name/i.test(msg)) {
    return 'o modelo configurado no provedor OpenAI-compatible é inválido';
  }
  return msg;
}

function parseConditionFromText(raw: string): 'new' | 'used' | 'refurbished' | null {
  const s = raw.trim().toLowerCase();
  if (['novo', 'nova', 'new'].includes(s)) return 'new';
  if (['usado', 'usada', 'used'].includes(s)) return 'used';
  if (['recondicionado', 'recondicionada', 'refurbished'].includes(s)) return 'refurbished';
  return null;
}

function parsePriceModeFromText(raw: string): 'rapido' | 'justo' | 'lucro' | 'manual' | null {
  const s = raw.trim().toLowerCase();
  if (['rapido', 'rápido', 'fast'].includes(s)) return 'rapido';
  if (['justo', 'fair'].includes(s)) return 'justo';
  if (['lucro', 'profit', 'max'].includes(s)) return 'lucro';
  if (['manual'].includes(s)) return 'manual';
  return null;
}

function parseNumberLoose(raw: string): number | null {
  const n = Number(raw.trim().replace(/[R$\s]/gi, '').replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

export class WhatsAppMlBot {
  private sock: ReturnType<typeof makeWASocket> | null = null;
  private connectionState: 'connecting' | 'open' | 'closed' = 'closed';
  private latestQr: { value: string; updatedAt: number } | null = null;
  private analysisTimers = new Map<string, NodeJS.Timeout>();
  private queue = new PQueue({ concurrency: 2 });
  private startPromise: Promise<void> | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private noSessionWarnedAt = new Map<string, number>();
  private sendQueue = new PQueue({
    concurrency: 1,
    interval: config.wa.sendIntervalMs,
    intervalCap: config.wa.sendIntervalCap,
    carryoverConcurrencyCount: true,
  });

  constructor(
    private store: JsonDbStore,
    private vision: OpenAIVisionService,
    private ml: MercadoLivreClient,
    private settings: SettingsService,
  ) {}

  private sessionScope(): 'group' | 'user' {
    return this.settings.get().session_scope;
  }

  private conversationMode(): 'guided' | 'kv' {
    return this.settings.get().conversation_mode;
  }

  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startImpl();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async refreshConnection(): Promise<{ ok: boolean; message: string }> {
    this.latestQr = null;
    this.connectionState = 'connecting';
    this.resetReconnectBackoff();

    const current = this.sock;
    if (current) {
      this.teardownSocket(current);
      try {
        (current as any)?.ws?.close?.();
      } catch (err) {
        logger.warn({ err }, 'failed to close current WhatsApp socket during manual refresh');
      }
    }

    void this.start().catch((err) => {
      logger.warn({ err }, 'failed to restart WhatsApp socket after manual refresh');
    });
    return { ok: true, message: 'Reconexão do WhatsApp iniciada. Aguarde alguns segundos e recarregue.' };
  }

  private async startImpl(): Promise<void> {
    await ensureDir(config.dataDirAbs);
    await ensureDir(path.join(config.dataDirAbs, 'media'));

    await this.store.init();

    const { state, saveCreds } = await useMultiFileAuthState(config.waSessionDirAbs);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: true,
      // Baileys expects a pino logger; keep it quiet and use our own logs.
      logger: logger as any,
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (typeof qr === 'string' && qr.length > 0) {
        this.latestQr = { value: qr, updatedAt: Date.now() };
        this.connectionState = 'connecting';
        logger.info('WhatsApp QR updated');
      }
      if (connection === 'close') {
        this.connectionState = 'closed';
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const reason = statusCode ? DisconnectReason[statusCode] : 'unknown';
        logger.warn({ statusCode, reason }, 'WhatsApp connection closed');
        this.teardownSocket(sock);
        if (statusCode === DisconnectReason.loggedOut) return;
        if (statusCode === DisconnectReason.restartRequired) {
          logger.info('WhatsApp restart required, reconnecting immediately');
          void this.start();
          return;
        }
        this.scheduleReconnect();
        return;
      }
      if (connection === 'open') {
        this.connectionState = 'open';
        this.latestQr = null;
        this.resetReconnectBackoff();
        logger.info('WhatsApp connected');
        void this.recoverSessionsOnConnect().catch((err) => {
          logger.warn({ err }, 'failed to recover sessions on connect');
        });
      }
    });

    sock.ev.on('messages.upsert', ({ messages }) => {
      for (const msg of messages) {
        void this.queue.add(() => this.onMessage(msg));
      }
    });

    this.sock = sock;

    logger.info('Bot started');
  }

  private teardownSocket(sock: ReturnType<typeof makeWASocket>): void {
    try {
      // Prevent listener accumulation if we restart.
      sock.ev.removeAllListeners('creds.update');
      sock.ev.removeAllListeners('connection.update');
      sock.ev.removeAllListeners('messages.upsert');
    } catch {
      // ignore
    }
    if (this.sock === sock) this.sock = null;
  }

  getConnectionSnapshot(): {
    state: 'connecting' | 'open' | 'closed';
    qrText: string | null;
    qrUpdatedAt: number | null;
  } {
    return {
      state: this.connectionState,
      qrText: this.latestQr?.value ?? null,
      qrUpdatedAt: this.latestQr?.updatedAt ?? null,
    };
  }

  private async recoverSessionsOnConnect(): Promise<void> {
    const now = nowMs();
    const staleAnalyzeMs = 15 * 60_000;
    const toSchedule: Array<{ id: string; delayMs: number }> = [];

    await this.store.update((db) => {
      for (const s of Object.values(db.sessions)) {
        if (s.status === 'collecting_photos') {
          if (!s.photos?.length) continue;
          const until = s.collectUntil ?? now;
          toSchedule.push({ id: s.id, delayMs: Math.max(1_000, until - now) });
          continue;
        }

        // If the process restarted mid-analysis, sessions can get stuck in `analyzing`.
        // Only recover when it looks stale, so we don't interfere with a live analysis.
        if (s.status === 'analyzing' && s.updatedAt < now - staleAnalyzeMs) {
          s.status = 'collecting_photos';
          s.collectUntil = now;
          s.updatedAt = now;
          if (s.photos?.length) toSchedule.push({ id: s.id, delayMs: 1_000 });
        }
      }
    });

    for (const t of toSchedule) {
      this.scheduleAnalysis(t.id, t.delayMs);
    }
    if (toSchedule.length) logger.info({ count: toSchedule.length }, 'Recovered session timers');
  }

  private resetReconnectBackoff(): void {
    this.reconnectAttempts = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const attempt = this.reconnectAttempts++;
    const base = Math.min(60_000, 5_000 * 2 ** Math.min(attempt, 10));
    const jitter = Math.floor(Math.random() * 1_000);
    const delay = base + jitter;
    logger.warn({ delay, attempt }, 'Scheduling WhatsApp reconnect');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.start();
    }, delay);
  }

  private async onMessage(msg: WAMessage): Promise<void> {
    if (!msg.message) return;
    if (msg?.key?.fromMe) return;

    const jid = msg?.key?.remoteJid;
    if (!jid) return;
    if (!isGroupJid(jid)) return;
    if (config.allowedGroupIds.length > 0 && !config.allowedGroupIds.includes(jid)) return;

    const sender = getSenderId(msg);
    if (!sender) return;

    const text = getText(msg)?.trim() ?? '';
    const botCmd = parseBotCommand(text);
    if (botCmd !== null) {
      await this.handleCommand(jid, sender, botCmd, msg);
      return;
    }

    if (isImageMessage(msg)) {
      await this.handleImage(jid, sender, msg);
      return;
    }

    if (text) {
      await this.handleText(jid, sender, text, msg);
    }
  }

  private settingsHelpText(): string {
    const lines: string[] = [];
    lines.push('*Configurações (não sensíveis)*');
    const s = this.settings.get();
    lines.push(`- require_command_for_images=${s.require_command_for_images}`);
    lines.push(`- conversation_mode=${s.conversation_mode}`);
    lines.push(`- session_scope=${s.session_scope}`);
    lines.push(`- photo_collect_window_sec=${s.photo_collect_window_sec}`);
    lines.push(`- max_image_bytes=${s.max_image_bytes}`);
    lines.push(`- max_photos_per_session=${s.max_photos_per_session}`);
    lines.push(`- media_retention_hours=${s.media_retention_hours}`);
    lines.push(`- session_inactive_hours=${s.session_inactive_hours}`);
    lines.push(`- session_retention_days=${s.session_retention_days}`);
    lines.push('');
    lines.push('Para alterar:');
    lines.push('!ml-bot config set chave=valor');
    lines.push('Ex.: !ml-bot config set photo_collect_window_sec=60');
    lines.push('');
    lines.push('Itens sensíveis (chaves/tokens) NÃO podem ser lidos/alterados via chat.');
    return lines.join('\n');
  }

  private parseConfigPatch(rawInput: string): { patch?: Record<string, any>; error?: string } {
    const raw = rawInput.replace(/^set\s+/i, '').trim();
    if (!raw) return { error: 'Formato inválido. Use: !ml-bot config set chave=valor' };
    const normalized = raw.replace(/\s+/g, '\n');
    const kv = parseKeyValueLines(normalized);
    if (Object.keys(kv).length === 0) return { error: 'Nenhum par chave=valor encontrado.' };

    const allowed = new Set(mutableSettingsForChat.map((x) => x.key));
    const patch: Record<string, any> = {};
    const unknown: string[] = [];

    for (const [key, value] of Object.entries(kv)) {
      if (!allowed.has(key as any)) {
        unknown.push(key);
        continue;
      }

      if (key === 'require_command_for_images' || key === 'ml_dry_run') {
        const b = normalizeYesNo(value);
        if (b == null) return { error: `Valor inválido para ${key}. Use sim/nao.` };
        patch[key] = b;
        continue;
      }

      if (key === 'conversation_mode') {
        const v = value.trim().toLowerCase();
        if (v !== 'guided' && v !== 'kv') return { error: 'Valor inválido para conversation_mode. Use guided|kv.' };
        patch[key] = v;
        continue;
      }

      if (key === 'session_scope') {
        const v = value.trim().toLowerCase();
        if (v !== 'group' && v !== 'user') return { error: 'Valor inválido para session_scope. Use group|user.' };
        patch[key] = v;
        continue;
      }

      const n = Number(value);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        return { error: `Valor inválido para ${key}. Use número inteiro.` };
      }
      patch[key] = n;
    }

    if (unknown.length) {
      return {
        error: `Chaves não permitidas via chat: ${unknown.join(', ')}.\nUse !ml-bot config para ver as permitidas.`,
      };
    }
    return { patch };
  }

  private async handleConfigCommand(groupId: string, cmd: string, msg: WAMessage): Promise<void> {
    const rest = cmd.replace(/^config\s*/i, '').trim();
    if (!rest || rest === 'show' || rest === 'listar' || rest === 'list') {
      await this.reply(groupId, this.settingsHelpText(), msg);
      return;
    }

    const parsed = this.parseConfigPatch(rest);
    if (parsed.error) {
      await this.reply(groupId, parsed.error, msg);
      return;
    }

    try {
      await this.settings.setMany(parsed.patch ?? {});
      await this.reply(groupId, `Configuração atualizada.\n\n${this.settingsHelpText()}`, msg);
    } catch (err: any) {
      await this.reply(groupId, `Falha ao salvar configuração: ${err?.message ?? String(err)}`, msg);
    }
  }

  private async handleCommand(groupId: string, userId: string, cmdText: string, msg: WAMessage): Promise<void> {
    const cmd = cmdText.trim().toLowerCase();
    if (cmd === 'ping') {
      await this.reply(groupId, 'pong', msg);
      return;
    }
    if (cmd === 'group') {
      await this.reply(groupId, `group_id=${groupId}`, msg);
      return;
    }
    if (cmd === 'novo' || cmd === 'new' || cmd === 'start') {
      await this.startNewSession(groupId, userId, msg);
      return;
    }
    if (cmd === 'cancel' || cmd === 'cancelar') {
      await this.cancelActiveSession(groupId, userId, msg);
      return;
    }
    if (cmd === 'config' || cmd.startsWith('config ')) {
      await this.handleConfigCommand(groupId, cmd, msg);
      return;
    }

    await this.reply(groupId, 'Comandos: !ml-bot ping | !ml-bot group | !ml-bot novo | !ml-bot config | !ml-bot cancel', msg);
  }

  private async startNewSession(groupId: string, userId: string, msg: WAMessage): Promise<void> {
    const createdNow = nowMs();
    let oldSessionId: string | null = null;
    let newSessionId: string | null = null;

    await this.store.update((db) => {
      const old = findActiveSession(db, groupId, userId, this.sessionScope());
      if (old) {
        oldSessionId = old.id;
        old.status = 'cancelled';
        old.updatedAt = createdNow;
      }

      const s: Session = {
        id: crypto.randomUUID(),
        groupId,
        userId,
        createdAt: createdNow,
        updatedAt: createdNow,
        status: 'collecting_photos',
        photos: [],
      };
      db.sessions[s.id] = s;
      newSessionId = s.id;
    });

    if (oldSessionId) {
      const timer = this.analysisTimers.get(oldSessionId);
      if (timer) clearTimeout(timer);
      this.analysisTimers.delete(oldSessionId);
    }

    if (!newSessionId) return;
    await this.reply(
      groupId,
      `Sessão nova criada: ${newSessionId}.\nAgora envie as fotos do produto e eu monto o anúncio (PAUSADO para revisão).`,
      msg,
    );
  }

  private async maybeWarnNeedNewSession(groupId: string, userId: string, msg: WAMessage): Promise<void> {
    const key = `${groupId}:${userId}`;
    const now = nowMs();
    const last = this.noSessionWarnedAt.get(key) ?? 0;
    if (now - last < 2 * 60_000) return;
    this.noSessionWarnedAt.set(key, now);
    await this.reply(
      groupId,
      'Para eu processar fotos neste grupo, inicie uma sessão com `!ml-bot novo` e depois envie as fotos do produto.',
      msg,
    );
  }

  private async handleImage(groupId: string, userId: string, msg: WAMessage): Promise<void> {
    if (!this.sock) return;
    const appSettings = this.settings.get();
    const preDb = await this.store.read();
    const preActive = findActiveSession(preDb, groupId, userId, this.sessionScope());
    if (appSettings.require_command_for_images && (!preActive || preActive.status !== 'collecting_photos')) {
      await this.maybeWarnNeedNewSession(groupId, userId, msg);
      return;
    }
    if (preActive && preActive.photos.length >= appSettings.max_photos_per_session) {
      await this.reply(
        groupId,
        `Limite de fotos por anúncio atingido (${appSettings.max_photos_per_session}). Responda "reanalisar" ou inicie nova sessão com !ml-bot novo.`,
        msg,
      );
      return;
    }

    const maxBytes = appSettings.max_image_bytes;
    const len = fileLengthFromImage(msg);
    if (maxBytes > 0 && len != null && len > maxBytes) {
      const mb = (n: number) => Math.max(1, Math.ceil(n / (1024 * 1024)));
      await this.reply(
        groupId,
        `Imagem muito grande (~${mb(len)}MB). Limite atual: ${mb(maxBytes)}MB. Envie uma imagem menor (ou ajuste WA_MAX_IMAGE_BYTES).`,
        msg,
      );
      return;
    }
    const messageId = msg?.key?.id ?? crypto.randomUUID();
    const mimeType = mimeTypeFromImage(msg);
    const ext = fileExtFromMime(mimeType);

    const photoId = crypto.randomUUID();
    const mediaPath = path.join(config.dataDirAbs, 'media', `${photoId}.${ext}`);
    let sha256: string;
    try {
      const stream = (await downloadMediaMessage(
        msg,
        'stream',
        {},
        { logger: logger as any, reuploadRequest: this.sock.updateMediaMessage },
      )) as any;

      const hasher = crypto.createHash('sha256');
      const hashTap = new Transform({
        transform(chunk, _enc, cb) {
          hasher.update(chunk as Buffer);
          cb(null, chunk);
        },
      });

      await pipeline(stream, hashTap, fsSync.createWriteStream(mediaPath));
      sha256 = hasher.digest('hex');
    } catch (err) {
      logger.error({ err, groupId, userId }, 'failed to download WhatsApp image');
      await fs.unlink(mediaPath).catch(() => {});
      await this.reply(groupId, 'Falha ao baixar a imagem do WhatsApp. Reenvie a foto, por favor.', msg);
      return;
    }

    const createdNow = nowMs();
    let sessionId: string | null = null;
    let isNew = false;
    let rejectedByMaxPhotos = false;
    await this.store.update((db) => {
      let s = findActiveSession(db, groupId, userId, this.sessionScope());
      if (!s) {
        s = {
          id: crypto.randomUUID(),
          groupId,
          userId,
          createdAt: createdNow,
          updatedAt: createdNow,
          status: 'collecting_photos',
          photos: [],
        };
        db.sessions[s.id] = s;
        isNew = true;
      }

      sessionId = s.id;
      s.updatedAt = createdNow;

      if (s.photos.length >= appSettings.max_photos_per_session) {
        rejectedByMaxPhotos = true;
        return;
      }

      // Always accept additional photos for the active session.
      s.photos.push({ id: photoId, messageId, mimeType, filePath: mediaPath, sha256, receivedAt: createdNow });

      if (s.status === 'collecting_photos') s.collectUntil = createdNow + appSettings.photo_collect_window_sec * 1000;
    });

    if (rejectedByMaxPhotos) {
      await fs.unlink(mediaPath).catch(() => {});
      await this.reply(
        groupId,
        `Limite de fotos por anúncio atingido (${appSettings.max_photos_per_session}). Responda "reanalisar" ou inicie nova sessão com !ml-bot novo.`,
        msg,
      );
      return;
    }

    if (!sessionId) return;
    const active = (await this.store.read()).sessions[sessionId];
    if (!active) return;

    if (active.status === 'collecting_photos') {
      this.scheduleAnalysis(active.id, Math.max(1_000, (active.collectUntil ?? nowMs()) - nowMs()));
      if (isNew) {
        const collectUntil = active.collectUntil ?? nowMs() + appSettings.photo_collect_window_sec * 1000;
        const analyzeEta = Math.max(12, Math.min(75, 10 + active.photos.length * 8));
        await this.reply(
          groupId,
          [
            `Sessão ${shortSessionId(active.id)} iniciada.`,
            `Foto recebida com sucesso (${active.photos.length}/${appSettings.max_photos_per_session}).`,
            `Janela para enviar mais fotos: ${appSettings.photo_collect_window_sec}s (até ${formatClock(collectUntil)}).`,
            `Se não chegar mais foto, a análise começa automaticamente em seguida (ETA ~${analyzeEta}s).`,
          ].join('\n'),
          msg,
        );
      } else {
        const remainingSec = Math.max(1, Math.ceil(((active.collectUntil ?? nowMs()) - nowMs()) / 1000));
        await this.reply(
          groupId,
          `Foto adicionada à sessão ${shortSessionId(active.id)} (${active.photos.length}/${appSettings.max_photos_per_session}). Início da análise em ~${remainingSec}s.`,
          msg,
        );
      }
    } else {
      await this.reply(
        groupId,
        `Foto adicionada à sessão ${shortSessionId(active.id)}. Se quiser rodar uma nova análise com as fotos atuais, responda "reanalisar".`,
        msg,
      );
    }
  }

  private scheduleAnalysis(sessionId: string, delayMs: number): void {
    const old = this.analysisTimers.get(sessionId);
    if (old) clearTimeout(old);
    const t = setTimeout(() => void this.queue.add(() => this.analyzeSession(sessionId)), delayMs);
    this.analysisTimers.set(sessionId, t);
  }

  private async analyzeSession(sessionId: string): Promise<void> {
    const timer = this.analysisTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.analysisTimers.delete(sessionId);
    }

    // Transition collecting -> analyzing atomically to avoid reviving cancelled sessions.
    const now = nowMs();
    let started = false;
    let collectUntil: number | null = null;
    await this.store.update((db2) => {
      const s = db2.sessions[sessionId];
      if (!s) return;
      if (s.status !== 'collecting_photos') return;
      if (s.collectUntil && s.collectUntil > now) {
        collectUntil = s.collectUntil;
        return;
      }
      s.status = 'analyzing';
      s.updatedAt = now;
      started = true;
    });

    if (collectUntil) {
      this.scheduleAnalysis(sessionId, Math.max(1_000, collectUntil - nowMs()));
      return;
    }
    if (!started) return;

    try {
      const s1 = (await this.store.read()).sessions[sessionId]!;
      const imagePaths = s1.photos.map((p) => p.filePath);
      const etaSec = Math.max(12, Math.min(75, 10 + imagePaths.length * 8));
      const tasksAhead = Math.max(0, this.queue.size + this.queue.pending - 1);
      const queueHint = tasksAhead > 0 ? ` Fila atual: ${tasksAhead} tarefa(s) na frente.` : '';
      await this.sendToGroup(
        s1.groupId,
        [
          `Análise iniciada - sessão ${shortSessionId(s1.id)}`,
          `Fotos: ${imagePaths.length}`,
          `ETA: ~${etaSec}s.${queueHint}`,
          'Etapa 1/2: visão do produto',
        ].join('\n'),
      );

      const vision = await this.vision.analyzeProduct(imagePaths);
      await this.sendToGroup(s1.groupId, 'Etapa 2/2: buscando comparáveis no Mercado Livre...');
      const cat = await this.ml.predictCategory(vision.listing.title);
      const categoryId = cat?.category_id ?? null;

	      const search = await this.ml.searchSimilar(vision.listing.search_query, categoryId ?? undefined);
	      const condition = vision.product.condition;
	      const sameCondition =
	        condition === 'new' || condition === 'used'
	          ? search.results.filter((r) => r.condition === condition)
	          : [];
      const runtime = this.settings.get();
	      const price = analyzePrices(sameCondition.length >= 5 ? sameCondition : search.results, runtime.ml_currency_id);

	      let applied = false;
	      await this.store.update((db2) => {
	        const s = db2.sessions[sessionId];
	        if (!s) return;
	        // If the user cancelled (or anything else changed), don't "revive" the session.
	        if (s.status !== 'analyzing') return;
	        s.vision = vision;
	        if (categoryId) s.categoryId = categoryId;
	        else delete (s as any).categoryId;
	        if (price) s.price = price;
	        else delete (s as any).price;
	        s.status = 'awaiting_user_info';
	        s.updatedAt = nowMs();
	        applied = true;
	      });

	      if (applied) {
	        const msgText = this.buildAnalysisMessage(vision, cat?.category_name, categoryId, price, s1.id);
	        await this.sendToGroup(s1.groupId, msgText);
	      } else {
	        logger.info({ sessionId }, 'analysis finished but session status changed; ignoring result');
	      }
	    } catch (err: any) {
	      logger.error({ err, sessionId }, 'analysis failed');
        const dbNow = await this.store.read();
        const sNow = dbNow.sessions[sessionId];
        const groupId = sNow?.groupId;
	      await this.store.update((db2) => {
	        const s = db2.sessions[sessionId];
	        if (!s) return;
	        if (s.status !== 'analyzing') return;
	        s.status = 'error';
	        s.error = err?.message ?? String(err);
	        s.updatedAt = nowMs();
	      });
        if (groupId) {
          const friendly = formatAnalysisErrorForUser(err);
          await this.sendToGroup(
            groupId,
            [
              `Falha na análise da sessão ${shortSessionId(sessionId)}: ${friendly}.`,
              'Tente enviar a foto novamente ou responda "reanalisar".',
            ].join('\n'),
          );
        }
	    }
	  }

  private buildAnalysisMessage(
    vision: Session['vision'],
    categoryName: string | undefined,
    categoryId: string | null,
    price: Session['price'] | null,
    sessionId: string,
  ): string {
    if (!vision) return 'Falha: visão vazia.';

    const lines: string[] = [];
    lines.push('*Identificação (por foto)*');
    lines.push(`- Produto: ${vision.product.short_name}`);
    lines.push(`- Categoria provável: ${vision.product.likely_category}`);
    lines.push(`- Marca: ${vision.product.brand ?? '(não tenho certeza)'}`);
    lines.push(`- Modelo: ${vision.product.model ?? '(não tenho certeza)'}`);
    lines.push(`- Condição (chute): ${humanCondition(vision.product.condition)}`);
    lines.push(`- Confiança: ${Math.round(vision.confidence * 100)}%`);

    if (categoryId) {
      lines.push('');
      lines.push('*Categoria sugerida no ML*');
      lines.push(`- ${categoryId}${categoryName ? ` (${categoryName})` : ''}`);
    }

    if (price) {
      lines.push('');
      lines.push(`*Preço (baseado em ${price.sample_size} anúncios similares)*`);
      lines.push(`- Mediana: ${formatBRL(price.median)}`);
      lines.push(`- Preço justo (sugestão): ${formatBRL(price.suggested_fair)}`);
      lines.push(`- Vender rápido (sugestão): ${formatBRL(price.suggested_fast)}`);
      lines.push(`- Maior lucro (sugestão): ${formatBRL(price.suggested_profit)}`);

      const examples = price.comparables.slice(0, 5);
      if (examples.length) {
        lines.push('');
        lines.push('*Exemplos*');
        examples.forEach((ex, idx) => {
          lines.push(`${idx + 1}) ${ex.title} | ${formatBRL(ex.price)}${ex.permalink ? ` | ${ex.permalink}` : ''}`);
        });
      }
    }

    lines.push('');
    if (this.conversationMode() === 'guided') {
      lines.push('Agora vou te fazer perguntas curtas para fechar o anúncio e deixar PAUSADO para revisão.');
      lines.push('Se preferir, ainda funciona responder com chave=valor.');
      lines.push('');
      lines.push(`(sessão: ${sessionId})`);
    } else {
      lines.push('*Para eu montar o anúncio e deixar PAUSADO para revisão, responda com:*');
      lines.push('condicao=novo|usado');
      if (price) lines.push('usar_preco=rapido|justo|lucro|manual');
      lines.push('preco=1234 (opcional, sobrescreve tudo)');
      lines.push('marca=...');
      lines.push('modelo=...');
      lines.push('obs=... (opcional)');
      lines.push('');
      lines.push(`(sessão: ${sessionId})`);
    }

    if (vision.questions?.length) {
      lines.push('');
      lines.push('*Perguntas rápidas*');
      vision.questions.slice(0, 6).forEach((q) => {
        lines.push(`- ${q.key}: ${q.question}`);
      });
    }

    return lines.join('\n');
  }

  private buildGuidedPrompt(
    session: Session,
    missing: string[],
    missingRequiredAttrs: Array<{ id: string; name: string; value_type?: string; values?: MlCategoryAttribute['values'] }>,
  ): { field: string; text: string } | null {
    if (missing.includes('categoria_id')) {
      return {
        field: 'categoria_id',
        text: 'Não consegui fechar a categoria automaticamente. Me envie o `categoria_id` do ML (ex.: MLB1234).',
      };
    }

    if (missing.includes('condicao')) {
      return {
        field: 'condicao',
        text: 'Qual a condição do produto? Responda com: novo, usado ou recondicionado.',
      };
    }

    if (missing.includes('preco')) {
      if (session.price) {
        return {
          field: 'usar_preco',
          text: [
            'Qual estratégia de preço você quer?',
            `- rapido (${formatBRL(session.price.suggested_fast)})`,
            `- justo (${formatBRL(session.price.suggested_fair)})`,
            `- lucro (${formatBRL(session.price.suggested_profit)})`,
            '- manual',
          ].join('\n'),
        };
      }
      return {
        field: 'preco_manual',
        text: 'Não consegui estimar o preço automático. Qual preço de anúncio você quer? (ex.: 1299,90)',
      };
    }

    if (missingRequiredAttrs.length) {
      const a = missingRequiredAttrs[0]!;
      const opts =
        a.values
          ?.slice(0, 5)
          .map((v) => {
            const name = v.name?.trim();
            const id = v.id?.trim();
            if (name && id) return `${name} (@${id})`;
            if (name) return name;
            if (id) return `@${id}`;
            return null;
          })
          .filter(Boolean) ?? [];
      const suffix = opts.length ? `\nOpções: ${opts.join(', ')}` : '';
      return {
        field: `attr:${a.id}`,
        text: `Preciso de ${a.name} (${a.id}) para publicar.${suffix}\nPode responder com texto livre ou @id.`,
      };
    }

    return null;
  }

  private async handleGuidedReply(session: Session, text: string, msg: WAMessage): Promise<boolean> {
    if (this.conversationMode() !== 'guided') return false;

    const field = session.pendingField?.trim();
    if (!field) {
      await this.generatePreview(session.id, msg);
      return true;
    }

    const patch: Record<string, string> = {};
    if (field === 'condicao') {
      const cond = parseConditionFromText(text);
      if (!cond) {
        await this.reply(session.groupId, 'Resposta inválida para condição. Use: novo, usado ou recondicionado.', msg);
        return true;
      }
      patch.condicao = cond === 'new' ? 'novo' : cond === 'used' ? 'usado' : 'recondicionado';
    } else if (field === 'usar_preco') {
      const mode = parsePriceModeFromText(text);
      if (mode === 'manual') {
        await this.store.update((db2) => {
          const s2 = db2.sessions[session.id];
          if (!s2) return;
          s2.pendingField = 'preco_manual';
          s2.updatedAt = nowMs();
        });
        await this.reply(session.groupId, 'Perfeito. Qual preço manual? (ex.: 1299,90)', msg);
        return true;
      }
      if (mode) {
        patch.usar_preco = mode;
      } else {
        const n = parseNumberLoose(text);
        if (!n || n <= 0) {
          await this.reply(session.groupId, 'Escolha: rapido, justo, lucro ou manual. Se preferir, envie direto um preço numérico.', msg);
          return true;
        }
        patch.preco = String(n);
      }
    } else if (field === 'preco_manual') {
      const n = parseNumberLoose(text);
      if (!n || n <= 0) {
        await this.reply(session.groupId, 'Preço inválido. Envie um número, por exemplo: 1299,90', msg);
        return true;
      }
      patch.preco = String(n);
    } else if (field === 'categoria_id') {
      const v = text.trim().toUpperCase();
      if (!v) {
        await this.reply(session.groupId, 'categoria_id inválido. Envie algo como: MLB1234', msg);
        return true;
      }
      patch.categoria_id = v;
    } else if (field.startsWith('attr:')) {
      const attrId = field.slice('attr:'.length).trim();
      const raw = text.trim();
      if (!attrId || !raw) {
        await this.reply(session.groupId, 'Valor inválido. Tente novamente com um texto simples ou @id.', msg);
        return true;
      }
      patch[attrId] = raw;
    } else {
      await this.generatePreview(session.id, msg);
      return true;
    }

    await this.store.update((db2) => {
      const s2 = db2.sessions[session.id];
      if (!s2) return;
      s2.userInput = { ...(s2.userInput ?? {}), ...patch };
      delete s2.pendingField;
      s2.updatedAt = nowMs();
    });

    await this.generatePreview(session.id, msg);
    return true;
  }

  private async handleText(groupId: string, userId: string, text: string, msg: WAMessage): Promise<void> {
    const t = text.trim();
    if (!t) return;

    if (t.toLowerCase() === 'cancelar') {
      await this.cancelActiveSession(groupId, userId, msg);
      return;
    }

    if (t.toLowerCase() === 'reanalisar') {
      const db = await this.store.read();
      const active = findActiveSession(db, groupId, userId, this.sessionScope());
      if (!active) {
        await this.reply(groupId, 'Não encontrei sessão ativa para reanalisar.', msg);
        return;
      }
      const now = nowMs();
      await this.store.update((db2) => {
        const s = db2.sessions[active.id];
        if (!s) return;
        s.status = 'collecting_photos';
        s.collectUntil = now;
        s.updatedAt = now;
      });
      await this.analyzeSession(active.id);
      return;
    }

    const db = await this.store.read();
    const session = findActiveSession(db, groupId, userId, this.sessionScope());
    if (!session) return;

    if (session.status === 'awaiting_confirmation' && t.toLowerCase() === 'confirmar') {
      await this.publishSession(session.id, msg);
      return;
    }

    if (!['awaiting_user_info', 'awaiting_confirmation'].includes(session.status)) return;

    const kv = parseKeyValueLines(text);
    if (session.status === 'awaiting_user_info' && Object.keys(kv).length === 0) {
      const handled = await this.handleGuidedReply(session, t, msg);
      if (handled) return;
    }

    if (Object.keys(kv).length === 0) {
      await this.reply(groupId, 'Envie a correção em chave=valor (ex.: preco=999) ou responda *confirmar*.', msg);
      return;
    }

    await this.store.update((db2) => {
      const s = db2.sessions[session.id];
      if (!s) return;
      s.userInput = { ...(s.userInput ?? {}), ...kv };
      delete s.pendingField;
      s.updatedAt = nowMs();
    });

    await this.generatePreview(session.id, msg);
  }

  private async cancelActiveSession(groupId: string, userId: string, msg: WAMessage): Promise<void> {
    const db = await this.store.read();
    const session = findActiveSession(db, groupId, userId, this.sessionScope());
    if (!session) {
      await this.reply(groupId, 'Não há sessão ativa para cancelar.', msg);
      return;
    }
    await this.store.update((db2) => {
      const s = db2.sessions[session.id];
      if (!s) return;
      s.status = 'cancelled';
      s.updatedAt = nowMs();
    });
    await this.reply(groupId, `Sessão ${session.id} cancelada.`, msg);
  }

  private normalizeAttrText(value: string): string {
    return value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  private pickAttributeOption(
    attr: MlCategoryAttribute,
    preferredNames: Array<string | null | undefined>,
  ): { value_id?: string; value_name?: string } | null {
    const cleaned = preferredNames.map((v) => (v ?? '').trim()).filter(Boolean);
    const values = attr.values ?? [];

    if (values.length) {
      if (values.length === 1) {
        const only = values[0]!;
        if (attr.id.endsWith('_HOMOLOGATION_NUMBER') && only.name) return { value_name: only.name };
        if (only.id) return { value_id: only.id };
        if (only.name) return { value_name: only.name };
      }

      const normalizedValues = values.map((v) => ({
        id: v.id?.trim(),
        name: v.name?.trim(),
        norm: this.normalizeAttrText(v.name?.trim() ?? ''),
      }));

      for (const candidate of cleaned) {
        const normCandidate = this.normalizeAttrText(candidate);
        if (!normCandidate) continue;
        const exact = normalizedValues.find((v) => v.norm && v.norm === normCandidate);
        if (exact) {
          if (attr.id.endsWith('_HOMOLOGATION_NUMBER') && exact.name) return { value_name: exact.name };
          if (exact.id) return { value_id: exact.id };
          if (exact.name) return { value_name: exact.name };
        }
        const partial = normalizedValues.find((v) => v.norm && (v.norm.includes(normCandidate) || normCandidate.includes(v.norm)));
        if (partial) {
          if (attr.id.endsWith('_HOMOLOGATION_NUMBER') && partial.name) return { value_name: partial.name };
          if (partial.id) return { value_id: partial.id };
          if (partial.name) return { value_name: partial.name };
        }
      }
    }

    const fallback = cleaned[0];
    if (!fallback) return null;
    return { value_name: fallback };
  }

  private guessRequiredAttributeValue(
    attr: MlCategoryAttribute,
    draft: ListingDraft,
    vision: VisionResult | undefined,
  ): { value_id?: string; value_name?: string } | null {
    const id = attr.id.toUpperCase();
    const condition = draft.condition;

    const fromVision = {
      brand: vision?.product.brand ?? null,
      model: vision?.product.model ?? null,
      color: vision?.product.color ?? null,
      material: vision?.product.material ?? null,
    };

    if (id === 'BRAND') return this.pickAttributeOption(attr, [fromVision.brand]);
    if (id === 'MODEL') return this.pickAttributeOption(attr, [fromVision.model]);
    if (id === 'COLOR' || id === 'MAIN_COLOR') return this.pickAttributeOption(attr, [fromVision.color]);
    if (id === 'MATERIAL') return this.pickAttributeOption(attr, [fromVision.material]);

    if (id === 'ITEM_CONDITION') {
      if (condition === 'new') return this.pickAttributeOption(attr, ['novo', 'new']);
      if (condition === 'used') return this.pickAttributeOption(attr, ['usado', 'used']);
      if (condition === 'refurbished') return this.pickAttributeOption(attr, ['recondicionado', 'refurbished', 'remanufaturado']);
    }

    if (id === 'WARRANTY_TYPE') {
      if (condition === 'used') return this.pickAttributeOption(attr, ['sem garantia', 'without warranty']);
      return this.pickAttributeOption(attr, ['garantia do vendedor', 'sem garantia']);
    }

    if (id === 'EMPTY_GTIN_REASON') {
      return this.pickAttributeOption(attr, ['outro motivo', 'nao se aplica', 'não se aplica']);
    }

    if (id === 'UNITS_PER_PACK' || id === 'PACKAGE_QUANTITY' || id === 'UNITS_PER_PACKAGE') {
      return this.pickAttributeOption(attr, ['1']);
    }

    if (id.endsWith('_HOMOLOGATION_NUMBER')) {
      const current = draft.attributes[attr.id];
      if (current?.value_name) return { value_name: current.value_name };
      return null;
    }

    return this.pickAttributeOption(attr, []);
  }

  private autoFillRequiredAttributes(
    draft: ListingDraft,
    vision: VisionResult | undefined,
    categoryAttrs: MlCategoryAttribute[] | null,
    specificAttrIds?: string[],
  ): string[] {
    if (!draft.category_id || !categoryAttrs?.length) return [];

    const requestedIds = new Set((specificAttrIds ?? []).map((id) => id.trim()).filter(Boolean));
    const targetAttrs = categoryAttrs.filter((a) => (a.tags as any)?.required === true || requestedIds.has(a.id));
    const filled: string[] = [];

    for (const attr of targetAttrs) {
      if (hasAttributeValue(draft.attributes[attr.id])) continue;
      const guess = this.guessRequiredAttributeValue(attr, draft, vision);
      if (!guess || (!guess.value_id && !guess.value_name)) continue;
      draft.attributes[attr.id] = guess;
      filled.push(attr.id);
    }
    return filled;
  }

  private mergePreferredDescription(mlDescription: string | null, draftDescription: string): string {
    const ml = mlDescription?.trim() ?? '';
    const draft = draftDescription.trim();
    if (!ml) return draft;
    if (!draft) return ml;

    const mlNorm = this.normalizeAttrText(ml).slice(0, 200);
    const draftNorm = this.normalizeAttrText(draft).slice(0, 200);
    if (mlNorm && draftNorm && (mlNorm.includes(draftNorm) || draftNorm.includes(mlNorm))) return draft;

    return [ml, '---', 'Ajustes e complementos do bot:', draft].join('\n\n');
  }

	  private async generatePreview(sessionId: string, quotedMsg: WAMessage): Promise<void> {
	    const db = await this.store.read();
	    const s = db.sessions[sessionId];
	    if (!s || !s.vision) return;

	    const draft = buildListingDraft({
	      vision: s.vision,
	      price: s.price ?? null,
	      categoryId: s.categoryId ?? null,
	      userInput: s.userInput,
	      currencyId: this.settings.get().ml_currency_id,
	      defaultQuantity: this.settings.get().ml_default_quantity,
	    });

	    let categoryAttrs: MlCategoryAttribute[] | null = null;
	    if (draft.category_id) {
	      try {
	        categoryAttrs = await this.ml.getCategoryAttributes(draft.category_id);
	      } catch (err) {
	        logger.warn({ err, categoryId: draft.category_id }, 'failed to load category attributes (preview)');
	      }
	    }

	    // Augment attributes with any "ATTRIBUTE_ID=value" the user typed, and support value_id via "@123".
	    if (draft.category_id && categoryAttrs) {
	      const byIdLower = new Map(categoryAttrs.map((a) => [a.id.toLowerCase(), a] as const));
	      for (const [k, v] of Object.entries(s.userInput ?? {})) {
	        const attr = byIdLower.get(k.toLowerCase());
	        const parsed = parseUserAttributeValue(v);
	        if (attr && parsed) draft.attributes[attr.id] = parsed;
	      }

	      // Common aliases -> attribute IDs (only if the attribute exists for this category).
	      const aliases: Record<string, string> = {
	        gtin: 'GTIN',
	        ean: 'GTIN',
	        'codbarras': 'GTIN',
	        'codigo_de_barras': 'GTIN',
	        'código_de_barras': 'GTIN',
	        cor: 'COLOR',
	        color: 'COLOR',
	        voltagem: 'VOLTAGE',
	        voltage: 'VOLTAGE',
	      };
	      for (const [aliasKey, attrId] of Object.entries(aliases)) {
	        const raw = (s.userInput ?? {})[aliasKey];
	        if (!raw) continue;
	        const attr = byIdLower.get(attrId.toLowerCase());
	        if (!attr) continue;
	        const parsed = parseUserAttributeValue(raw);
	        if (parsed) draft.attributes[attr.id] = parsed;
	      }
	    }

	    let autoFilledAttrs: string[] = [];
	    if (draft.category_id && categoryAttrs) {
	      autoFilledAttrs = this.autoFillRequiredAttributes(draft, s.vision, categoryAttrs);
	    }

	    const missing: string[] = [];
	    if (!draft.category_id) missing.push('categoria_id');
	    if (draft.condition === 'unknown') missing.push('condicao');
	    if (!draft.price_chosen) missing.push('preco');

	    const warnings: string[] = [];
	    let missingRequiredAttrs: Array<{ id: string; name: string; value_type?: string; values?: MlCategoryAttribute['values'] }> = [];
	    if (draft.category_id && categoryAttrs) {
	      const required = categoryAttrs.filter((a) => (a.tags as any)?.required === true);
	      missingRequiredAttrs = required
	        .filter((a) => !hasAttributeValue(draft.attributes[a.id]))
	        .slice(0, 12)
	        .map((a) => ({ id: a.id, name: a.name, value_type: (a as any).value_type, values: a.values }));

	      // Soft warnings for list attributes when user provided a value_name that doesn't match known options.
	      for (const a of required) {
	        const val = draft.attributes[a.id];
	        if (!val || val.value_id || !val.value_name || !a.values || a.values.length === 0) continue;
	        const match = a.values.some((v) => v.name?.toLowerCase() === val.value_name?.toLowerCase());
	        if (!match) {
	          warnings.push(`${a.id} (${a.name}): valor pode precisar ser uma das opções sugeridas (ou use @id).`);
	        }
	      }
	    }

    const guided = this.conversationMode() === 'guided';
    const guidedPrompt = guided ? this.buildGuidedPrompt(s, missing, missingRequiredAttrs) : null;

    await this.store.update((db2) => {
      const s2 = db2.sessions[sessionId];
      if (!s2) return;
      s2.draft = draft;
      s2.status = missing.length || missingRequiredAttrs.length ? 'awaiting_user_info' : 'awaiting_confirmation';
      if (s2.status === 'awaiting_user_info' && guidedPrompt) s2.pendingField = guidedPrompt.field;
      else delete s2.pendingField;
      s2.updatedAt = nowMs();
    });

    if (guidedPrompt && (missing.length || missingRequiredAttrs.length)) {
      await this.reply(s.groupId, guidedPrompt.text, quotedMsg);
      return;
    }

	    const preview = this.buildPreviewMessage(s, draft, missing, missingRequiredAttrs, warnings, autoFilledAttrs);
	    await this.reply(s.groupId, preview, quotedMsg);
	  }

	  private buildPreviewMessage(
	    session: Session,
	    draft: Session['draft'],
	    missing: string[],
	    missingRequiredAttrs: Array<{ id: string; name: string; value_type?: string; values?: MlCategoryAttribute['values'] }>,
	    warnings: string[],
	    autoFilledAttrs: string[],
	  ): string {
	    if (!draft) return 'Erro: draft vazio.';

    const lines: string[] = [];
    lines.push('*Preview do anúncio (antes de publicar)*');
    lines.push(`- Título: ${draft.title}`);
    lines.push(`- Categoria: ${draft.category_id ?? '(faltando)'}`);
    lines.push(`- Condição: ${humanCondition(draft.condition)}`);
    lines.push(`- Quantidade: ${draft.quantity}`);
    lines.push(`- Preço escolhido: ${draft.price_chosen ? formatBRL(draft.price_chosen) : '(faltando)'}`);
    if (draft.price_fair && draft.price_fast && session.price?.suggested_profit) {
      lines.push(
        `- Sugestões: justo ${formatBRL(draft.price_fair)} | rápido ${formatBRL(draft.price_fast)} | lucro ${formatBRL(session.price.suggested_profit)}`,
      );
    }
    lines.push(`- Fotos: ${session.photos.length}`);

	    lines.push('');
	    lines.push('*Descrição (início)*');
	    lines.push(draft.description_ptbr.slice(0, 800) + (draft.description_ptbr.length > 800 ? '…' : ''));

	    if (warnings.length) {
	      lines.push('');
	      lines.push('*Atenção*');
	      warnings.slice(0, 8).forEach((w) => lines.push(`- ${w}`));
	      if (warnings.length > 8) lines.push(`- (+${warnings.length - 8} avisos)`);
	    }

	    if (autoFilledAttrs.length) {
	      lines.push('');
	      lines.push('*Preenchido automaticamente para melhorar qualidade*');
	      autoFilledAttrs.slice(0, 10).forEach((id) => lines.push(`- ${id}`));
	      if (autoFilledAttrs.length > 10) lines.push(`- (+${autoFilledAttrs.length - 10} campos)`);
	    }

	    if (missing.length || missingRequiredAttrs.length) {
	      lines.push('');
	      lines.push('*Ainda preciso de:*');
	      missing.forEach((m) => lines.push(`- ${m}`));
	      missingRequiredAttrs.forEach((a) => {
	        let line = `- ${a.id} (${a.name})`;
	        const opts =
	          a.values
	            ?.slice(0, 5)
	            .map((v) => {
	              const name = v.name?.trim();
	              const id = v.id?.trim();
	              if (name && id) return `${name} (@${id})`;
	              if (name) return name;
	              if (id) return `@${id}`;
	              return null;
	            })
	            .filter(Boolean) ?? [];
	        if (opts.length) line += ` | opções: ${opts.join(', ')}`;
	        lines.push(line);
	      });
	      lines.push('');
      if (this.conversationMode() === 'guided') {
        lines.push('Vou pedir esses campos em sequência, em mensagens curtas.');
      } else {
        lines.push('Responda com chave=valor, por exemplo:');
        if (missing.includes('condicao')) lines.push('condicao=usado');
        if (missing.includes('preco')) lines.push('usar_preco=rapido');
        lines.push('Dica: para usar um value_id, escreva ATTRIBUTE=@id (ex.: COLOR=@52005).');
        missingRequiredAttrs.slice(0, 4).forEach((a) => lines.push(`${a.id}=...`));
      }
      return lines.join('\n');
    }

    lines.push('');
    lines.push('Se estiver tudo certo, responda: *confirmar*');
    lines.push('Ou envie correções em chave=valor (ex.: preco=999, titulo=..., obs=...).');
    return lines.join('\n');
  }

  private async publishSession(sessionId: string, quotedMsg: WAMessage): Promise<void> {
    const db = await this.store.read();
    const s = db.sessions[sessionId];
    if (!s || !s.draft) return;
    const groupId = s.groupId;

    if (!s.draft.category_id || !s.draft.price_chosen || s.draft.condition === 'unknown') {
      await this.reply(s.groupId, 'Ainda falta info para publicar. Veja o preview e complete os campos faltantes.', quotedMsg);
      return;
    }

    await this.store.update((db2) => {
      const s2 = db2.sessions[sessionId];
      if (!s2) return;
      s2.status = 'publishing';
      s2.updatedAt = nowMs();
	    });

	    let created: { id: string; permalink?: string; status?: string } | null = null;
	    let pauseOk = false;
	    try {
        const publishEta = Math.max(18, Math.min(90, 14 + s.photos.length * 8));
        const tasksAhead = Math.max(0, this.queue.size + this.queue.pending);
        const queueHint = tasksAhead > 0 ? ` Fila atual: ${tasksAhead} tarefa(s) em processamento.` : '';
        await this.reply(
          groupId,
          [
            `Publicação iniciada - sessão ${shortSessionId(s.id)}`,
            `ETA: ~${publishEta}s.${queueHint}`,
            'Etapa 1/4: upload das fotos',
          ].join('\n'),
          quotedMsg,
        );
	      // Upload pictures
	      const pictureIds: string[] = [];
	      for (const [idx, p] of s.photos.entries()) {
          await this.sendToGroup(groupId, `Etapa 1/4: enviando foto ${idx + 1}/${s.photos.length}...`);
	        const buf = await fs.readFile(p.filePath);
	        const fileName = `photo_${idx + 1}.${fileExtFromMime(p.mimeType)}`;
	        const uploaded = await this.ml.uploadPicture(buf, fileName, p.mimeType);
	        pictureIds.push(uploaded.id);
	      }

        await this.sendToGroup(groupId, 'Etapa 2/4: criando item no Mercado Livre...');
        const runtime = this.settings.get();
        const publishDraft: ListingDraft = {
          ...s.draft,
          attributes: { ...s.draft.attributes },
        };
        const categoryAttrs = publishDraft.category_id ? await this.ml.getCategoryAttributes(publishDraft.category_id).catch(() => null) : null;
        const autoFilledOnPublish = new Set<string>();

        let payload = buildCreateItemPayload(publishDraft, pictureIds, {
          buyingMode: runtime.ml_buying_mode,
          listingTypeId: runtime.ml_listing_type_id,
        });

        // Validate/create loop: auto-fill required ML attributes when possible before asking user.
        let createErr: any = null;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            await this.ml.validateItem(payload);
          } catch (validateErr: any) {
            const needed = this.extractAttributeIdsFromMlError(validateErr);
            const filled = this.autoFillRequiredAttributes(publishDraft, s.vision, categoryAttrs, needed);
            if (filled.length) {
              filled.forEach((id) => autoFilledOnPublish.add(id));
              payload = buildCreateItemPayload(publishDraft, pictureIds, {
                buyingMode: runtime.ml_buying_mode,
                listingTypeId: runtime.ml_listing_type_id,
              });
            }
          }

          try {
            created = await this.ml.createItem(payload);
            break;
          } catch (err: any) {
            createErr = err;
            const needed = this.extractAttributeIdsFromMlError(err);
            const filled = this.autoFillRequiredAttributes(publishDraft, s.vision, categoryAttrs, needed);
            if (!filled.length) break;
            filled.forEach((id) => autoFilledOnPublish.add(id));
            await this.sendToGroup(groupId, `Ajustando automaticamente exigências do ML: ${filled.join(', ')}`);
            payload = buildCreateItemPayload(publishDraft, pictureIds, {
              buyingMode: runtime.ml_buying_mode,
              listingTypeId: runtime.ml_listing_type_id,
            });
          }
        }
        if (!created) throw createErr ?? new Error('Falha ao criar item no ML');

        if (autoFilledOnPublish.size) {
          await this.store.update((db2) => {
            const s2 = db2.sessions[sessionId];
            if (!s2?.draft) return;
            s2.draft.attributes = publishDraft.attributes;
            s2.updatedAt = nowMs();
          });
        }

	      // Persist the created item ID immediately so we don't lose it on partial failures.
	      await this.store.update((db2) => {
	        const s2 = db2.sessions[sessionId];
	        if (!s2) return;
	        const published: any = { item_id: created!.id };
	        if (created!.permalink) published.permalink = created!.permalink;
	        if (created!.status) published.status = created!.status;
	        s2.published = published;
	        s2.updatedAt = nowMs();
	      });

	      // Best-effort pause as early as possible (even if createItem already set status=paused).
	      try {
          await this.sendToGroup(groupId, 'Etapa 3/4: aplicando pausa de segurança...');
	        await this.ml.pauseItem(created.id);
	        pauseOk = true;
	      } catch (err) {
	        logger.warn({ err, itemId: created.id }, 'failed to pause item (early)');
	      }

        await this.sendToGroup(groupId, 'Etapa 4/4: atualizando descrição...');
        const mlDescription = await this.ml.getDescription(created.id).catch((err) => {
          logger.warn({ err, itemId: created?.id }, 'failed to fetch ML generated description');
          return null;
        });
        const finalDescription = this.mergePreferredDescription(mlDescription, publishDraft.description_ptbr);
	      await this.ml.setDescription(created.id, finalDescription);

	      // Best-effort pause again.
	      try {
          await this.sendToGroup(groupId, 'Finalizando: confirmando status pausado...');
	        await this.ml.pauseItem(created.id);
	        pauseOk = true;
	      } catch (err) {
	        logger.warn({ err, itemId: created.id }, 'failed to pause item (final)');
	      }

	      let cancelledDuringPublish = false;
	      await this.store.update((db2) => {
	        const s2 = db2.sessions[sessionId];
	        if (!s2) return;
	        cancelledDuringPublish = s2.status !== 'publishing';
	        s2.updatedAt = nowMs();
	        if (!cancelledDuringPublish) s2.status = 'done';
	      });

	      const link = created.permalink ? `\nLink: ${created.permalink}` : '';
	      const extra = cancelledDuringPublish
	        ? '\nObs: a sessão foi cancelada durante a publicação, mas o anúncio já tinha sido criado.'
	        : '';
	      const pauseWarn = pauseOk
	        ? ''
	        : '\nAtenção: não consegui garantir que o item ficou *PAUSADO* automaticamente; confira no link.';
	      await this.reply(groupId, `Anúncio criado.${pauseWarn}\nItem: ${created.id}${link}${extra}`, quotedMsg);
	    } catch (err: any) {
	      logger.error({ err, sessionId, itemId: created?.id }, 'publish failed');

	      // If an item was created, do NOT reset the session back to awaiting_user_info
	      // (user would type "confirmar" again and create duplicates). Keep the item id.
	      if (created?.id) {
	        try {
	          await this.ml.pauseItem(created.id);
	          pauseOk = true;
	        } catch (pauseErr) {
	          logger.warn({ err: pauseErr, itemId: created.id }, 'failed to pause item after publish error');
	        }

	        await this.store.update((db2) => {
	          const s2 = db2.sessions[sessionId];
	          if (!s2) return;
	          const published: any = s2.published ?? { item_id: created!.id };
	          if (created!.permalink) published.permalink = created!.permalink;
	          if (created!.status) published.status = created!.status;
	          s2.published = published;
	          s2.error = err?.message ?? String(err);
	          s2.updatedAt = nowMs();
	          if (s2.status === 'publishing') s2.status = 'done';
	        });

	        const link = created.permalink ? `\nLink: ${created.permalink}` : '';
	        const pauseWarn = pauseOk
	          ? ''
	          : '\nAtenção: não consegui garantir que o item ficou *PAUSADO* automaticamente; confira no link e pause manualmente.';
	        await this.reply(
	          groupId,
	          `Item criado, mas houve um erro ao finalizar (descrição/pausa).\nErro: ${err?.message ?? String(err)}${pauseWarn}\nItem: ${created.id}${link}`,
	          quotedMsg,
	        );
	        return;
	      }

	      await this.store.update((db2) => {
	        const s2 = db2.sessions[sessionId];
	        if (!s2) return;
	        if (s2.status !== 'publishing') return;
	        s2.status = 'awaiting_user_info';
	        s2.error = err?.message ?? String(err);
	        s2.updatedAt = nowMs();
	      });

	      const msgText = await this.formatPublishError(err, s.draft);
	      await this.reply(groupId, msgText, quotedMsg);
	    }
  }

  private extractAttributeIdsFromMlError(err: any): string[] {
    const ids = new Set<string>();
    const causes = err?.cause_details;
	    if (Array.isArray(causes)) {
	      for (const c of causes) {
	        const msg = typeof c?.message === 'string' ? c.message : '';
	        const m = msg.match(/\[([A-Z0-9_]+)\]/g);
	        if (m) {
	          for (const token of m) {
	            const id = token.replace(/^\[|\]$/g, '').trim();
	            if (id) ids.add(id);
	          }
	        }
        if (typeof c?.attribute_id === 'string') ids.add(c.attribute_id);
        if (typeof c?.id === 'string' && /^[A-Z0-9_]+$/.test(c.id)) ids.add(c.id);
        if (typeof c?.cause_id === 'string' && /^[A-Z0-9_]+$/.test(c.cause_id)) ids.add(c.cause_id);
      }
    }
    return Array.from(ids);
  }

  private async formatPublishError(err: any, draft: Session['draft']): Promise<string> {
    const base = `Falha ao publicar no Mercado Livre: ${err?.message ?? String(err)}`.trim();

    const lines: string[] = [base];

    const msg = String(err?.message ?? '').toLowerCase();
    if (msg.includes('refresh token') || msg.includes('oauth') || msg.includes('invalid_grant')) {
      lines.push('Parece um problema de autenticação OAuth. Você provavelmente precisa reautorizar o app e atualizar ML_REFRESH_TOKEN.');
    }

    const attrIds = this.extractAttributeIdsFromMlError(err);
    if (attrIds.length) {
      lines.push('');
      lines.push(`Possíveis atributos exigidos pelo ML: ${attrIds.join(', ')}`);
      lines.push('Responda com ATTRIBUTE_ID=valor (ex.: BRAND=Samsung). Para usar value_id: ATTRIBUTE=@id (ex.: COLOR=@52005).');

      if (draft?.category_id) {
        try {
          const attrs = await this.ml.getCategoryAttributes(draft.category_id);
          const byId = new Map(attrs.map((a) => [a.id, a] as const));
          const hints: string[] = [];
          for (const id of attrIds.slice(0, 8)) {
            const a = byId.get(id);
            if (!a?.values?.length) continue;
            const opts = a.values
              .slice(0, 5)
              .map((v) => (v.name && v.id ? `${v.name} (@${v.id})` : v.name || (v.id ? `@${v.id}` : null)))
              .filter(Boolean);
            if (opts.length) hints.push(`${id}: ${opts.join(', ')}`);
          }
          if (hints.length) {
            lines.push('');
            lines.push('Opções (se aplicável):');
            hints.forEach((h) => lines.push(`- ${h}`));
          }
        } catch {
          // ignore
        }
      }
    } else {
      lines.push('Se o erro for de atributos obrigatórios, responda com ATTRIBUTE_ID=valor (ex.: BRAND=Samsung).');
    }

    return lines.join('\\n');
  }

  private async sendToGroup(groupId: string, text: string): Promise<void> {
    await this.enqueueSend(groupId, { text });
  }

  private async reply(groupId: string, text: string, quoted: WAMessage): Promise<void> {
    await this.enqueueSend(groupId, { text }, { quoted });
  }

  private async enqueueSend(groupId: string, message: any, options?: any): Promise<void> {
    if (!this.sock) return;
    await this.sendQueue.add(async () => {
      try {
        await this.humanDelay(message?.text);
        await this.sock!.sendMessage(groupId, message, options);
      } catch (err) {
        logger.error({ err, groupId }, 'failed to send WhatsApp message');
      }
    });
  }

  private async humanDelay(text?: string): Promise<void> {
    const min = config.wa.humanDelayMsMin;
    const max = config.wa.humanDelayMsMax;
    if (max <= 0) return;

    const base = min + Math.floor(Math.random() * (max - min + 1));
    const extra = text ? Math.min(2_000, Math.floor(text.length / 200) * 250) : 0;
    const ms = base + extra;
    await new Promise((r) => setTimeout(r, ms));
  }
}
