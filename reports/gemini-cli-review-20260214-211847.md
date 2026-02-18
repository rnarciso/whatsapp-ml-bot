# Gemini CLI Code Review

- model: gemini-2.5-flash-lite
- generated_at_utc: 2026-02-15T00:19:16Z

Este é um code review do projeto **WhatsApp -> Mercado Livre Bot**. O projeto apresenta uma arquitetura funcional bem estruturada para um MVP, com bom uso de padrões assíncronos e separação de responsabilidades. No entanto, existem riscos operacionais e de escalabilidade que precisam de atenção.

---

### Resumo do Review
- **Robustez de Sessão:** O uso de `PQueue` e estado persistente em JSON é bom para escala pequena, mas o armazenamento de mídia e o crescimento do JSON são riscos de infraestrutura.
- **Integração ML:** O fluxo de atributos obrigatórios é o ponto mais frágil e propenso a erros de publicação.
- **Segurança de Tokens:** Existe um risco de "token drift" entre o `.env` e o `db.json`.
- **Gerenciamento de Recursos:** Não há limpeza automática de arquivos de imagem (`data/media`), o que causará esgotamento de disco.
- **UX no WhatsApp:** O bot é proativo, mas a falta de tratamento de mensagens de erro amigáveis em falhas de IA pode confundir o usuário.
- **Qualidade de Código:** Tipagem TypeScript sólida, exceto em integrações externas (Baileys), e boa modularização de serviços.

---

### Análise por Severidade

#### [CRÍTICO] Falta de Limpeza de Mídia (Storage Leak)
- **Arquivo:** `src/bot/WhatsAppMlBot.ts` (método `handleImage`)
- **Problema:** Cada foto recebida é salva em `data/media` com um UUID. Não há processo de limpeza (cleanup). Em um grupo ativo, o bot consumirá todo o espaço em disco rapidamente.
- **Risco:** Queda do serviço por falta de espaço em disco e corrupção do `db.json` ao tentar salvar sem espaço.
- **Melhoria:** Implementar um job diário ou baseado em eventos para deletar fotos de sessões marcadas como `done`, `cancelled` ou `error` com mais de 24h.

#### [ALTO] Drift de Refresh Token (OAuth)
- **Arquivos:** `src/config.ts` e `src/index.ts`
- **Problema:** O bot lê o `ML_REFRESH_TOKEN` inicial do `.env`, mas salva as atualizações no `db.json`. Se o processo reiniciar e o `db.json` for perdido ou ignorado, o token no `.env` pode já ter expirado (refresh tokens do ML expiram ao serem usados).
- **Risco:** Perda de acesso à conta do Mercado Livre, exigindo nova intervenção manual via `ml:oauth.ts`.
- **Melhoria:** Priorizar sempre o token do `db.json` e, em caso de erro `invalid_grant`, alertar o usuário via WhatsApp que a reautorização é necessária.

#### [ALTO] Fragilidade em Atributos Obrigatórios do ML
- **Arquivo:** `src/services/mercadoLivre.ts` e `src/bot/WhatsAppMlBot.ts`
- **Problema:** O Mercado Livre é extremamente rigoroso com atributos (ex: `BRAND`, `MODEL`, `GTIN`). O código atual tenta mapear alguns, mas falha se o atributo exigir um `value_id` específico em vez de um texto livre (`value_name`).
- **Risco:** Falha constante na publicação (`createItem`) para categorias como Eletrônicos ou Peças Automotivas.
- **Melhoria:** No `generatePreview`, se a categoria for identificada, buscar os atributos e já listar para o usuário quais opções (IDs) são aceitas para campos como "Cor" ou "Voltagem".

#### [MÉDIO] Concorrência e Race Conditions no DB JSON
- **Arquivo:** `src/storage/store.ts`
- **Problema:** Embora use `PQueue` com concorrência 1 para escritas, o método `read()` é livre. Se uma leitura ocorrer enquanto um `writeFileAtomic` está renomeando o arquivo, pode haver falhas intermitentes (embora o `rename` seja atômico no Unix). Além disso, o arquivo inteiro é lido/escrito a cada atualização.
- **Risco:** Performance degrada linearmente com o número de sessões.
- **Melhoria:** Usar um banco de dados SQLite (com o driver `better-sqlite3` ou `prisma`) para gerenciar sessões e tokens de forma mais performática e segura.

#### [MÉDIO] Hallucinação e Custo da OpenAI Vision
- **Arquivo:** `src/services/openaiVision.ts`
- **Problema:** O bot envia até 8 imagens em "high detail". Isso é excelente para precisão, mas caro. Além disso, a IA pode "inventar" detalhes técnicos se não houver zoom nas etiquetas.
- **Risco:** Custos inesperados na API da OpenAI e anúncios com informações técnicas erradas.
- **Melhoria:** Adicionar um aviso no `Preview` reforçando que os detalhes técnicos foram extraídos por IA e devem ser conferidos.

#### [BAIXO] Tipagem "any" no Baileys
- **Arquivo:** `src/bot/WhatsAppMlBot.ts`
- **Problema:** O uso de `any` para `WAMessage` e outros tipos do Baileys reduz a segurança do compilador.
- **Melhoria:** Importar os tipos corretos (ex: `proto.IWebMessageInfo`) para evitar erros de propriedade indefinida em tempo de execução.

---

### Proposta de Melhorias Implementáveis

1.  **Validação de Atributos Proativa:**
    *   No serviço `MercadoLivreClient`, criar um método que valide o `draft.attributes` contra o retorno de `getCategoryAttributes` antes de tentar o `createItem`.
    *   Se um atributo obrigatório faltar, mudar o status da sessão para `awaiting_user_info` imediatamente com uma lista clara de opções.

2.  **Sistema de Retentativa (Retry Logic):**
    *   Implementar retentativas exponenciais para a API da OpenAI e ML em caso de erros 5xx ou Rate Limit. O `p-retry` é uma boa biblioteca para isso.

3.  **Melhoria na UX de Erro:**
    *   Se a análise da visão falhar ou a confiança for baixa (< 0.5), o bot deve pedir fotos mais nítidas em vez de simplesmente falhar ou gerar um anúncio genérico.

---

### Sugestão de Testes Automatizados

1.  **Unitários (Essenciais):**
    *   `src/utils/stats.ts`: Testar cálculos de mediana e outliers (IQR) para garantir que preços absurdos de similares não quebrem a sugestão de preço.
    *   `src/services/listingDraft.ts`: Testar a lógica de merge entre o que a IA extraiu e o que o usuário sobrescreveu via `KV`.

2.  **Integração (Sandboxed):**
    *   Mockar a resposta da OpenAI com JSONs reais e testar se o `MercadoLivreClient` consegue processar a predição de categoria corretamente.
    *   Testar o fluxo de "Refresh Token" simulando um token expirado para garantir que a persistência no `db.json` funciona.

3.  **E2E (Fluxo Crítico):**
    *   Um script que simula o recebimento de uma mensagem com imagem, aguarda o timer, e verifica se o estado da sessão no banco de dados evoluiu para `awaiting_user_info`.

---

### Observações Específicas

-   **WhatsApp (Baileys):** O uso de `reuploadRequest` no `downloadMediaMessage` é uma excelente prática para lidar com mídias antigas/expiradas nos servidores do WhatsApp.
-   **Mercado Livre (OAuth):** A estratégia de capturar o erro `PolicyAgent` (403) e tentar com OAuth é necessária para certos endpoints de busca/predição que o ML "protege" aleatoriamente.
-   **Status Paused:** Criar o anúncio como `paused` é a decisão de design mais segura do projeto, pois transfere a responsabilidade final de conformidade para o usuário humano, mitigando riscos legais de anúncios errados.
