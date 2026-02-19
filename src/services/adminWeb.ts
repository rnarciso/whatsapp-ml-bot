import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { URL, URLSearchParams } from 'node:url';
import QRCode from 'qrcode';

import { config } from '../config.js';
import { logger } from '../logger.js';
import type { AppSettings } from '../types.js';
import type { SettingsService } from './settings.js';

type WhatsAppConnectionSnapshot = {
  state: 'connecting' | 'open' | 'closed';
  qrText: string | null;
  qrUpdatedAt: number | null;
};

type WhatsAppStatusProvider = {
  getConnectionSnapshot(): WhatsAppConnectionSnapshot;
  refreshConnection?(): Promise<{ ok: boolean; message: string }>;
};

const AUTH_COOKIE_NAME = 'mlbot_admin_session';
const AUTH_COOKIE_MAX_AGE_SEC = 12 * 60 * 60;

const LOGO_MARK = `
<svg class="logo" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M196 140H332C386.2 140 430 183.8 430 238V274C430 328.2 386.2 372 332 372H256L180 432L206 372H196C141.8 372 98 328.2 98 274V238C98 183.8 141.8 140 196 140Z" fill="#0B1220"/>
  <path d="M222 214H338L382 256L338 298H222L178 256L222 214Z" fill="#F8FAFC"/>
  <circle cx="212" cy="256" r="10" fill="#0B1220"/>
  <path d="M262 242H344" stroke="#0B1220" stroke-width="14" stroke-linecap="round"/>
  <path d="M262 270H324" stroke="#0B1220" stroke-width="14" stroke-linecap="round"/>
  <path d="M396 144L406 168L430 178L406 188L396 212L386 188L362 178L386 168L396 144Z" fill="#FBBF24"/>
</svg>
`.trim();

function esc(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderHtml(
  settings: AppSettings,
  wa: { stateLabel: string; qrDataUrl: string | null; qrUpdatedAtLabel: string | null },
  flash?: string,
): string {
  const checked = settings.require_command_for_images ? 'checked' : '';
  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
	    <title>ML Bot Config</title>
	    <style>
	      :root { --bg:#f5f6f8; --card:#fff; --ink:#1f2937; --muted:#6b7280; --line:#e5e7eb; --ok:#065f46; --okbg:#ecfdf5; }
	      body { margin:0; font-family: ui-sans-serif, -apple-system, Segoe UI, Roboto, sans-serif; background:var(--bg); color:var(--ink); }
	      main { max-width: 820px; margin: 24px auto; padding: 0 16px 24px; }
	      .card { background: var(--card); border:1px solid var(--line); border-radius: 12px; padding: 16px; box-shadow: 0 1px 2px rgba(0,0,0,.04); }
	      .header { display:flex; align-items:center; gap:12px; margin: 2px 0 10px; }
	      .logo { width: 42px; height: 42px; }
	      h1 { font-size: 20px; margin: 0 0 4px; }
	      p { color: var(--muted); margin: 0 0 16px; }
	      form { display: grid; gap: 10px; }
	      label { display:grid; gap:4px; font-size: 14px; }
      input[type=number], input[type=text] { border:1px solid var(--line); border-radius:8px; padding:10px; font-size:14px; }
      .row { display:flex; align-items:center; gap:8px; }
      .btn { border:0; background:#111827; color:#fff; border-radius:8px; padding:10px 14px; cursor:pointer; width: fit-content; }
      .flash { margin: 0 0 12px; border:1px solid #a7f3d0; background:var(--okbg); color:var(--ok); border-radius:8px; padding:10px; font-size:14px; }
      .muted { color:var(--muted); font-size:13px; }
      code { background:#f3f4f6; padding:2px 6px; border-radius:6px; }
      .wa-panel { border:1px solid var(--line); border-radius:10px; padding:12px; margin: 0 0 14px; background:#fafafa; }
      .wa-state { margin: 0 0 10px; font-size:14px; }
      .wa-qr { display:flex; gap:12px; align-items:flex-start; flex-wrap:wrap; }
      .wa-qr img { width: 220px; height: 220px; border:1px solid var(--line); border-radius:10px; background:#fff; }
      .wa-actions { margin-top: 10px; display:flex; gap:8px; }
        .toolbar { display:flex; justify-content:flex-end; margin-bottom: 12px; }
        .btn-light { background:#fff; color:#111827; border:1px solid var(--line); }
	    </style>
  </head>
	  <body>
	    <main>
	      <div class="card">
          <div class="toolbar">
            <form method="post" action="/logout">
              <button class="btn btn-light" type="submit">Sair</button>
            </form>
          </div>
	        <div class="header">
	          ${LOGO_MARK}
	          <div>
	            <h1>Configuração do Bot</h1>
	            <p>Ajustes não sensíveis. Chaves/tokens continuam fora do chat e deste painel.</p>
	          </div>
	        </div>
	        ${flash ? `<div class="flash">${esc(flash)}</div>` : ''}
          <div class="wa-panel">
            <p class="wa-state"><strong>WhatsApp:</strong> ${esc(wa.stateLabel)}</p>
            ${
              wa.qrDataUrl
                ? `<div class="wa-qr">
                    <img src="${wa.qrDataUrl}" alt="QR Code do WhatsApp" />
                    <div>
                      <p class="muted">Abra o WhatsApp no celular e escaneie este QR.</p>
                      ${wa.qrUpdatedAtLabel ? `<p class="muted">Última atualização: ${esc(wa.qrUpdatedAtLabel)}</p>` : ''}
                    </div>
                  </div>`
                : '<p class="muted">QR indisponível no momento. Se desconectado, recarregue a página ou reinicie o container.</p>'
            }
            <div class="wa-actions">
              <form method="post" action="/wa/refresh">
                <button class="btn btn-light" type="submit">Atualizar QR</button>
              </form>
            </div>
          </div>
	        <form method="post" action="/settings">
          <label class="row">
            <input type="checkbox" name="require_command_for_images" value="1" ${checked} />
            Exigir <code>!ml-bot novo</code> antes de aceitar fotos
          </label>

          <label>
            Janela de coleta de fotos (segundos)
            <input type="number" min="5" max="300" name="photo_collect_window_sec" value="${settings.photo_collect_window_sec}" />
          </label>

          <label>
            Tamanho máximo da imagem (bytes)
            <input type="number" min="0" max="50000000" name="max_image_bytes" value="${settings.max_image_bytes}" />
          </label>

          <label>
            Máximo de fotos por sessão
            <input type="number" min="1" max="20" name="max_photos_per_session" value="${settings.max_photos_per_session}" />
          </label>

          <label>
            Retenção de fotos locais (horas)
            <input type="number" min="1" max="${24 * 90}" name="media_retention_hours" value="${settings.media_retention_hours}" />
          </label>

          <label>
            Expirar sessão inativa (horas)
            <input type="number" min="1" max="${24 * 30}" name="session_inactive_hours" value="${settings.session_inactive_hours}" />
          </label>

          <label>
            Remover sessões antigas (dias)
            <input type="number" min="1" max="3650" name="session_retention_days" value="${settings.session_retention_days}" />
          </label>

          <button class="btn" type="submit">Salvar</button>
        </form>

        <p class="muted">Também disponível no chat: <code>!ml-bot config</code> e <code>!ml-bot config set chave=valor</code>.</p>
      </div>
    </main>
  </body>
</html>`;
}

function renderLoginHtml(flash?: string): string {
  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ML Bot Login</title>
    <style>
      :root { --bg:#f5f6f8; --card:#fff; --ink:#1f2937; --muted:#6b7280; --line:#e5e7eb; --err:#991b1b; --errbg:#fef2f2; }
      body { margin:0; font-family: ui-sans-serif, -apple-system, Segoe UI, Roboto, sans-serif; background:var(--bg); color:var(--ink); }
      main { min-height: 100vh; display:grid; place-items:center; padding: 16px; }
      .card { width:min(420px, 100%); background: var(--card); border:1px solid var(--line); border-radius: 12px; padding: 20px; box-shadow: 0 1px 2px rgba(0,0,0,.04); }
      .header { display:flex; align-items:center; gap:12px; margin: 0 0 12px; }
      .logo { width: 42px; height: 42px; }
      h1 { font-size: 20px; margin: 0 0 4px; }
      p { color: var(--muted); margin: 0 0 16px; }
      form { display:grid; gap:10px; }
      label { display:grid; gap:4px; font-size: 14px; }
      input[type=password] { border:1px solid var(--line); border-radius:8px; padding:10px; font-size:14px; }
      .btn { border:0; background:#111827; color:#fff; border-radius:8px; padding:10px 14px; cursor:pointer; width: fit-content; }
      .flash { margin: 0 0 12px; border:1px solid #fecaca; background:var(--errbg); color:var(--err); border-radius:8px; padding:10px; font-size:14px; }
    </style>
  </head>
  <body>
    <main>
      <div class="card">
        <div class="header">
          ${LOGO_MARK}
          <div>
            <h1>Acesso ao Painel</h1>
            <p>Entre para visualizar configurações e QR do WhatsApp.</p>
          </div>
        </div>
        ${flash ? `<div class="flash">${esc(flash)}</div>` : ''}
        <form method="post" action="/login">
          <label>
            Senha do painel
            <input type="password" name="password" autocomplete="current-password" required />
          </label>
          <button class="btn" type="submit">Entrar</button>
        </form>
      </div>
    </main>
  </body>
</html>`;
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

function parseIntOrThrow(v: string | null, key: string): number {
  const n = Number(v ?? '');
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new Error(`Valor inválido para ${key}`);
  return n;
}

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function parseCookies(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const item of raw.split(';')) {
    const i = item.indexOf('=');
    if (i <= 0) continue;
    const key = item.slice(0, i).trim();
    const value = item.slice(i + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

function isSecureRequest(req: http.IncomingMessage): boolean {
  const proto = req.headers['x-forwarded-proto'];
  if (Array.isArray(proto)) return proto[0] === 'https';
  return typeof proto === 'string' && proto.split(',')[0]?.trim() === 'https';
}

function buildAuthCookie(value: string, secure: boolean): string {
  const parts = [
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${AUTH_COOKIE_MAX_AGE_SEC}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function clearAuthCookie(secure: boolean): string {
  const parts = [
    `${AUTH_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function hashSession(adminToken: string, sessionSecret: string): string {
  return createHash('sha256').update(adminToken).update(':').update(sessionSecret).digest('hex');
}

function hasValidSession(req: http.IncomingMessage, expected: string): boolean {
  const cookies = parseCookies(req.headers.cookie);
  const got = cookies[AUTH_COOKIE_NAME];
  if (!got) return false;
  return safeEqual(got, expected);
}

async function getWaView(waStatusProvider?: WhatsAppStatusProvider): Promise<{
  stateLabel: string;
  qrDataUrl: string | null;
  qrUpdatedAtLabel: string | null;
}> {
  const snapshot = waStatusProvider?.getConnectionSnapshot() ?? {
    state: 'closed',
    qrText: null,
    qrUpdatedAt: null,
  };
  const stateLabel =
    snapshot.state === 'open'
      ? 'conectado'
      : snapshot.state === 'connecting'
        ? 'aguardando pareamento'
        : 'desconectado';
  const qrDataUrl = snapshot.qrText ? await QRCode.toDataURL(snapshot.qrText, { margin: 1, width: 320 }) : null;
  const qrUpdatedAtLabel = snapshot.qrUpdatedAt ? new Date(snapshot.qrUpdatedAt).toLocaleString('pt-BR') : null;
  return { stateLabel, qrDataUrl, qrUpdatedAtLabel };
}

export function startAdminWebServer(
  settingsService: SettingsService,
  waStatusProvider?: WhatsAppStatusProvider,
): http.Server | null {
  if (!config.adminWeb.enabled) return null;
  const adminToken = config.adminWeb.token?.trim();
  if (!adminToken) {
    logger.warn('Admin web disabled: set ADMIN_WEB_TOKEN to enable authenticated access.');
    return null;
  }
  const sessionSecret = randomBytes(32).toString('hex');
  const expectedSession = hashSession(adminToken, sessionSecret);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${config.adminWeb.host}:${config.adminWeb.port}`);

      if (req.method === 'GET' && url.pathname === '/login') {
        if (hasValidSession(req, expectedSession)) {
          res.writeHead(303, { Location: '/settings' });
          res.end();
          return;
        }
        const html = renderLoginHtml();
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/login') {
        const body = await readBody(req);
        const params = new URLSearchParams(body);
        const password = params.get('password') ?? '';
        if (!safeEqual(password, adminToken)) {
          const html = renderLoginHtml('Senha inválida.');
          res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(html);
          return;
        }
        const secure = isSecureRequest(req);
        res.writeHead(303, {
          Location: '/settings',
          'Set-Cookie': buildAuthCookie(expectedSession, secure),
          'Cache-Control': 'no-store',
        });
        res.end();
        return;
      }

      if (req.method === 'POST' && url.pathname === '/logout') {
        const secure = isSecureRequest(req);
        res.writeHead(303, {
          Location: '/login',
          'Set-Cookie': clearAuthCookie(secure),
          'Cache-Control': 'no-store',
        });
        res.end();
        return;
      }

      if (req.method === 'POST' && url.pathname === '/wa/refresh') {
        if (!hasValidSession(req, expectedSession)) {
          res.writeHead(303, { Location: '/login', 'Cache-Control': 'no-store' });
          res.end();
          return;
        }
        const result = waStatusProvider?.refreshConnection
          ? await waStatusProvider.refreshConnection()
          : { ok: false, message: 'Refresh de conexão indisponível neste runtime.' };
        const waView = await getWaView(waStatusProvider);
        const html = renderHtml(settingsService.get(), waView, result.message);
        res.writeHead(result.ok ? 200 : 503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
        return;
      }

      if (!hasValidSession(req, expectedSession)) {
        res.writeHead(303, { Location: '/login', 'Cache-Control': 'no-store' });
        res.end();
        return;
      }

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/settings')) {
        const waView = await getWaView(waStatusProvider);
        const html = renderHtml(settingsService.get(), waView);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/settings') {
        const body = await readBody(req);
        const params = new URLSearchParams(body);
        const patch = {
          require_command_for_images: params.get('require_command_for_images') === '1',
          photo_collect_window_sec: parseIntOrThrow(params.get('photo_collect_window_sec'), 'photo_collect_window_sec'),
          max_image_bytes: parseIntOrThrow(params.get('max_image_bytes'), 'max_image_bytes'),
          max_photos_per_session: parseIntOrThrow(params.get('max_photos_per_session'), 'max_photos_per_session'),
          media_retention_hours: parseIntOrThrow(params.get('media_retention_hours'), 'media_retention_hours'),
          session_inactive_hours: parseIntOrThrow(params.get('session_inactive_hours'), 'session_inactive_hours'),
          session_retention_days: parseIntOrThrow(params.get('session_retention_days'), 'session_retention_days'),
        };
        await settingsService.setMany(patch);
        const waView = await getWaView(waStatusProvider);
        const html = renderHtml(settingsService.get(), waView, 'Configuração salva com sucesso.');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    } catch (err: any) {
      logger.warn({ err }, 'admin web request failed');
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Erro: ${err?.message ?? String(err)}`);
    }
  });

  server.listen(config.adminWeb.port, config.adminWeb.host, () => {
    logger.info({ url: `http://${config.adminWeb.host}:${config.adminWeb.port}/login` }, 'Admin web started');
  });

  return server;
}
