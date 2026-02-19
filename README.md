# WhatsApp -> Mercado Livre (Anúncios a partir de fotos)

<p align="center">
  <img src="assets/logo.svg" width="180" alt="WhatsApp ML Bot logo" />
</p>

Bot para ficar em **grupo do WhatsApp** e:

- receber fotos de produtos no grupo
- identificar o item (visão + texto)
- buscar similares no Mercado Livre para estimar **preço justo** e **preço para vender rápido**
- montar um anúncio e **publicar como PAUSADO** (para revisão antes de ativar)

## Aviso importante (WhatsApp)

O WhatsApp **não oferece** (até onde é documentado publicamente) uma API oficial para bots participarem de **grupos**.  
Este projeto usa **Baileys (WhatsApp Web)**, que é uma integração **não-oficial** e pode violar Termos de Uso.

Se você quiser uma alternativa “100% oficial”, o caminho costuma ser:

- WhatsApp Business Platform/Cloud API (somente conversas 1:1, não grupo)
- ou um “operador humano” que encaminha as fotos para o bot (ex.: DM)  

## Setup

1. Instale deps:

```bash
npm install
```

2. Crie `.env`:

```bash
cp .env.example .env
```

3. Preencha no `.env`:

- `OPENAI_API_KEY` (obrigatório para identificar produto via foto)
- (Opcional) `OPENAI_BASE_URL` para usar um endpoint OpenAI-compatible (ex.: LiteLLM)
- Mercado Livre: `ML_CLIENT_ID`, `ML_CLIENT_SECRET`, `ML_REFRESH_TOKEN` (obrigatório para publicar)
- Opcional: `WA_ALLOWED_GROUP_IDS` para limitar em quais grupos o bot responde
- (Opcional, recomendado em grupos "não dedicados"): `WA_REQUIRE_COMMAND_FOR_IMAGES=true` para só processar fotos após `!ml-bot novo`
- (Opcional): `WA_MAX_IMAGE_BYTES` para limitar o tamanho das imagens aceitas (evita DoS por imagens gigantes)
- (Opcional): `STORAGE_ENCRYPTION_KEY` para criptografar os tokens do Mercado Livre no `db.json`
- (Opcional): painel web local (`ADMIN_WEB_ENABLED`, `ADMIN_WEB_HOST`, `ADMIN_WEB_PORT`, `ADMIN_WEB_TOKEN`)
- (Opcional) review via Gemini: ter o `gemini` CLI instalado e logado (opcional: `GEMINI_MODEL`)
- (Opcional) retenção/limpeza: `MEDIA_RETENTION_HOURS`, `SESSION_INACTIVE_HOURS`, `SESSION_RETENTION_DAYS`

4. Rode:

```bash
npm run dev
```

5. Escaneie o QR code para logar o WhatsApp do bot (disponível nos logs e no painel web em `/settings`).

6. (Opcional) Abra o painel web local de configuração:

- `http://127.0.0.1:8787`
- Se `ADMIN_WEB_TOKEN` estiver definido: `http://127.0.0.1:8787/?token=SEU_TOKEN`

## Como obter `ML_REFRESH_TOKEN`

1. No painel de dev do Mercado Livre, configure um `redirect_uri` no seu app (ex.: `http://localhost:3333/callback`).
2. No `.env`, preencha `ML_CLIENT_ID` e `ML_CLIENT_SECRET`.
3. Rode:

```bash
npm run ml:oauth
```

4. Abra o link que o script imprimir; ao autorizar, ele vai mostrar o `ML_REFRESH_TOKEN` para você colar no `.env`.

## Uso no grupo

- Se `WA_REQUIRE_COMMAND_FOR_IMAGES=true`: primeiro envie `!ml-bot novo` e depois envie as fotos do produto.
- Envie 1 ou mais fotos do mesmo produto. O bot aguarda `PHOTO_COLLECT_WINDOW_SEC` segundos para juntar várias fotos.
- Depois ele responde com:
  - identificação do produto
  - comparáveis e preços do Mercado Livre
  - perguntas rápidas (ex.: condição, detalhes, defeitos)
- Responda com `chave=valor` (o bot mostra o template).
- Quando estiver ok, responda `confirmar` para publicar (como **pausado**).

## Comandos rápidos

- `!ml-bot ping` (teste)
- `!ml-bot group` (mostra o ID do grupo, para usar em `WA_ALLOWED_GROUP_IDS`)
- `!ml-bot novo` (inicia uma nova sessão para enviar fotos)
- `!ml-bot config` (lista configurações não sensíveis)
- `!ml-bot config set chave=valor` (ajusta configurações não sensíveis, ex: `photo_collect_window_sec=60`)
- `cancelar` (cancela a sessão ativa do usuário no grupo)

Itens sensíveis (tokens/chaves) não são exibidos nem alterados via chat.

## Rodar em “sem publicar”

Defina `ML_DRY_RUN=true` no `.env`.  
O bot vai gerar o anúncio, mas não cria item no Mercado Livre.

## Usar modelos locais (OpenAI-compatible / LiteLLM)

Se você tem um gateway OpenAI-compatible (ex.: LiteLLM) rodando, defina:

- `OPENAI_BASE_URL=http://docker.lan:4000/v1` (ou o host/porta do seu LiteLLM)
- `OPENAI_API_KEY=...` (se o seu gateway exigir; se não exigir, pode usar um valor dummy como `local`)
- `OPENAI_MODEL_VISION=...` (nome do modelo conforme configurado no seu gateway)

## Review via Gemini (opcional)

Com o `gemini` CLI instalado e logado, rode:

```bash
npm run gemini:review
```

O review fica salvo em `reports/gemini-review-<timestamp>.md`.

## Troubleshooting (Mercado Livre 403 / PolicyAgent)

Se você receber erro `403` com algo como `PA_UNAUTHORIZED_RESULT_FROM_POLICIES` / `blocked_by=PolicyAgent`, normalmente significa:

- você está chamando um endpoint que agora exige autenticação OAuth, ou
- seu app não tem permissões/escopos funcionais para aquele recurso

Este bot tenta automaticamente repetir algumas chamadas com OAuth quando detecta esse 403, mas você ainda precisa de:

- `ML_CLIENT_ID`, `ML_CLIENT_SECRET`, `ML_REFRESH_TOKEN` válidos
