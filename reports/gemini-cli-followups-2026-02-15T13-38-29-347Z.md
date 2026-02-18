# Gemini CLI Follow-up Questions

- model: gemini-2.5-flash-lite
- generated_at: 2026-02-15T13:38:29.348Z
- files_sent: 27
- total_bytes_sent: 215296

Como tech lead do projeto **whatsapp-ml-bot**, identifiquei pontos de ambiguidade técnica e riscos operacionais que precisam ser sanados antes do deploy em produção. Abaixo estão as perguntas de follow-up priorizadas:

### 1. Estratégia de Resiliência Anti-Ban (WhatsApp)
**Pergunta:** Qual o plano de contingência para o banimento do número (chip) e como será feita a rotação de instâncias?
- **Por que importa:** O Baileys utiliza uma implementação não-oficial. O WhatsApp é agressivo no banimento de bots em grupos, especialmente se houver denúncias de spam ou comportamento automatizado rápido.
- **Default seguro:** Usar um número de telefone dedicado (burner), implementar um "warm-up" de mensagens e limitar o bot a no máximo 3 grupos controlados inicialmente.

### 2. Controle de Custos e Quotas da OpenAI
**Pergunta:** Existe um limite de orçamento mensal para a API da OpenAI e qual a quota máxima de sessões de análise por usuário/dia?
- **Por que importa:** O modelo `gpt-4o-mini` com visão, embora mais barato, pode gerar custos significativos se um usuário decidir enviar dezenas de fotos aleatórias ("trollagem") ou se o bot entrar em loop.
- **Default seguro:** Limitar a 5 sessões completas por usuário/dia e rejeitar imagens acima de 5MB (já configurável, mas deve ser estrito).

### 3. Persistência e Segurança de Tokens do Mercado Livre
**Pergunta:** Como pretendemos proteger o `db.json` em produção, dado que ele armazena o `access_token` e `refresh_token` em texto puro?
- **Por que importa:** Se o servidor for comprometido, o atacante terá acesso total à conta do Mercado Livre do usuário para criar anúncios ou acessar dados sensíveis.
- **Default seguro:** Em produção, mover os tokens para um Secret Manager (AWS Secrets Manager, HashiCorp Vault) ou, no mínimo, criptografar o campo `mlTokens` no JSON em repouso.

### 4. Transição de Contexto (Grupo vs. Privado)
**Pergunta:** Devemos manter o fluxo de "revisão e confirmação" no grupo ou o bot deve chamar o usuário no privado (DM) para finalizar o anúncio?
- **Por que importa:** Privacidade e UX. Outros membros do grupo verão as fotos, preços e dados de quem está anunciando. Além disso, o fluxo de mensagens `chave=valor` pode poluir a conversa do grupo.
- **Default seguro:** Manter no grupo apenas se `WA_REQUIRE_COMMAND_FOR_IMAGES=true`, mas adicionar um comando `!ml-bot pv` para migrar sessões sensíveis para o privado.

### 5. Responsabilidade Legal e Alinhamento de Expectativas
**Pergunta:** Como lidaremos com erros de precificação ou identificação de itens proibidos/falsificados?
- **Por que importa:** O bot pode sugerir um preço errado ou identificar um item que viola as políticas do Mercado Livre, levando à suspensão da conta do vendedor.
- **Default seguro:** Adicionar um disclaimer obrigatório no rascunho: "IA-Generated: revise todos os campos". Manter o status fixo em `paused` (já feito) e nunca permitir publicação direta em `active`.

### 6. Retenção de Mídias e LGPD
**Pergunta:** Qual o prazo legal de retenção das fotos no servidor e elas serão usadas para algum treinamento posterior?
- **Por que importa:** Fotos de produtos em ambientes domésticos podem conter PII (rostos de familiares, documentos sobre mesas, etc). O armazenamento local (`data/media`) precisa de expurgo rigoroso.
- **Default seguro:** Reduzir `MEDIA_RETENTION_HOURS` para 4 horas e garantir que o cleanup delete os arquivos imediatamente após o status mudar para `done` ou `cancelled`.

### 7. Tratamento de Atributos Obrigatórios Complexos
**Pergunta:** Como o bot deve reagir quando o Mercado Livre exigir atributos que a visão não consegue extrair (ex: voltagem, validade, composição técnica)?
- **Por que importa:** O payload de criação de item falhará sistematicamente em certas categorias se esses campos não forem preenchidos, frustrando a UX.
- **Default seguro:** O bot deve listar explicitamente os atributos faltantes e impedir o comando `confirmar` até que o usuário responda com `CHAVE=VALOR`.

### 8. Monitoramento e Observabilidade
**Pergunta:** Qual ferramenta será usada para alertar quando o `refresh_token` expirar ou o Baileys desconectar?
- **Por que importa:** Sem monitoramento, o bot ficará "morto" no grupo e os usuários não saberão o porquê, perdendo confiança na ferramenta.
- **Default seguro:** Integrar um check de saúde (Healthcheck.io) e enviar erros `CRITICAL` do log para um webhook de Discord/Slack.

### 9. Concorrência e Limites de Hardware
**Pergunta:** Qual o volume esperado de usuários simultâneos e qual a capacidade de memória/CPU do ambiente de hospedagem?
- **Por que importa:** O processamento de imagens e as filas do `p-queue` consomem memória. Baileys mantém uma conexão socket pesada.
- **Default seguro:** Limitar a 10 sessões globais simultâneas e rodar em uma instância com no mínimo 1GB de RAM disponível.

### 10. Suporte a Múltiplos Sites (MLB, MLM, MLC)
**Pergunta:** O bot será exclusivo para o Brasil (`MLB`) ou deve suportar outros países do ecossistema Mercado Livre?
- **Por que importa:** Muda a moeda, o predictor de categorias e as regras de frete/impostos.
- **Default seguro:** Hardcode `MLB` e `BRL` (como está no `config.ts`), mas validar se o `ML_SITE_ID` no `.env` bate com o país da conta do `ML_REFRESH_TOKEN`.
