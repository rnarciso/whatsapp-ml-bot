import 'dotenv/config';

import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { URL } from 'node:url';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in .env`);
  return v;
}

async function exchangeCode(params: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  codeVerifier?: string;
}): Promise<{ access_token: string; refresh_token: string; expires_in: number; user_id?: number }> {
  const form = new URLSearchParams();
  form.set('grant_type', 'authorization_code');
  form.set('client_id', params.clientId);
  form.set('client_secret', params.clientSecret);
  form.set('code', params.code);
  form.set('redirect_uri', params.redirectUri);
  if (params.codeVerifier) form.set('code_verifier', params.codeVerifier);

  const res = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: form,
  });

  const data = (await res.json()) as any;
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${JSON.stringify(data)}`);

  return {
    access_token: String(data.access_token),
    refresh_token: String(data.refresh_token),
    expires_in: Number(data.expires_in),
    user_id: typeof data.user_id === 'number' ? data.user_id : undefined,
  };
}

function toBase64Url(input: Buffer): string {
  return input
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function buildPkce(): { verifier: string; challenge: string; method: 'S256' } {
  const verifier = toBase64Url(randomBytes(64));
  const challenge = toBase64Url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge, method: 'S256' };
}

async function main(): Promise<void> {
  const clientId = required('ML_CLIENT_ID');
  const clientSecret = required('ML_CLIENT_SECRET');
  const redirectUri = process.env.ML_REDIRECT_URI ?? 'http://localhost:3333/callback';
  const usePkce = (process.env.ML_USE_PKCE ?? 'true').toLowerCase() !== 'false';
  const pkce = usePkce ? buildPkce() : null;

  const redirect = new URL(redirectUri);
  const port = Number(redirect.port || '3333');

  const authUrl = new URL('https://auth.mercadolivre.com.br/authorization');
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  if (pkce) {
    authUrl.searchParams.set('code_challenge', pkce.challenge);
    authUrl.searchParams.set('code_challenge_method', pkce.method);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', redirectUri);
      if (url.pathname !== redirect.pathname) {
        res.writeHead(404).end('Not found');
        return;
      }

      const code = url.searchParams.get('code');
      if (!code) {
        res.writeHead(400).end('Missing code');
        return;
      }

      const tokens = await exchangeCode({
        clientId,
        clientSecret,
        redirectUri,
        code,
        codeVerifier: pkce?.verifier,
      });

      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('OK. Volte ao terminal.');

      // eslint-disable-next-line no-console
      console.log('\nCole no seu .env:\n');
      // eslint-disable-next-line no-console
      console.log(`ML_REFRESH_TOKEN=${tokens.refresh_token}`);
      // eslint-disable-next-line no-console
      console.log(`\n(user_id: ${tokens.user_id ?? 'n/a'})\n`);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Erro. Veja o terminal.');
      // eslint-disable-next-line no-console
      console.error(err);
    } finally {
      server.close();
    }
  });

  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log('\nAbra este link no navegador para autorizar o app:\n');
    // eslint-disable-next-line no-console
    console.log(authUrl.toString());
    if (pkce) {
      // eslint-disable-next-line no-console
      console.log('\nPKCE: enabled (S256)');
    } else {
      // eslint-disable-next-line no-console
      console.log('\nPKCE: disabled');
    }
    // eslint-disable-next-line no-console
    console.log(`\nAguardando callback em ${redirectUri} ...\n`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
