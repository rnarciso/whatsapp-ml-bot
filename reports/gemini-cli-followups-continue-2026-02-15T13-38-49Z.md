I will examine the codebase to identify more technical nuances and potential risks, then generate 10 additional follow-up questions (11-20) for the project.

I will read the cleanup and entry point files to further refine my understanding of the bot's operational lifecycle and data management.

Com base na análise técnica do código-fonte e da arquitetura do projeto **whatsapp-ml-bot**, aqui estão as perguntas de follow-up adicionais (11-20) para garantir a robustez e escalabilidade do sistema:

### 11. Integridade do Banco de Dados (JSON) sob Concorrência
**Pergunta:** Como garantiremos a atomicidade das gravações no `db.json` se múltiplas sessões tentarem atualizar o estado simultaneamente (ex: dois usuários confirmando anúncios ao mesmo tempo)?
- **Por que importa:** O uso de um único arquivo JSON como banco de dados é propenso a *race conditions*. Se um processo ler o arquivo enquanto outro está escrevendo, ou se dois processos escreverem quase simultaneamente, o arquivo pode ser corrompido ou dados de sessões podem ser perdidos.
- **Default seguro:** Implementar um mecanismo de trava (locking) no `JsonDbStore` ou garantir que todas as operações de escrita sejam sequencializadas através de uma fila única.

### 12. Limites de Caracteres e Regras de Descrição do ML
**Pergunta:** Qual será o limite máximo de caracteres na descrição e como filtraremos termos proibidos (ex: links externos, e-mails) que a IA pode gerar?
- **Por que importa:** O Mercado Livre possui regras rígidas que proíbem dados de contato nas descrições. Além disso, descrições muito longas podem ser cortadas. O código atual faz um `slice(0, 800)` apenas no preview, mas não no envio final.
- **Default seguro:** Limitar a descrição final a 50.000 caracteres (limite do ML) e aplicar um filtro de Regex para remover padrões de URLs e e-mails antes do `setDescription`.

### 13. Agrupamento de Mensagens de Álbum (WhatsApp)
**Pergunta:** Como o bot deve lidar com o envio de "Álbuns" no WhatsApp, onde as imagens chegam como mensagens separadas quase instantaneamente?
- **Por que importa:** O bot usa um `photoCollectWindowSec` (janela de coleta). Se a janela for muito curta (ex: 10s), o bot pode iniciar a análise apenas com a primeira foto antes das outras terminarem de baixar, resultando em uma análise incompleta.
- **Default seguro:** Definir o padrão de `PHOTO_COLLECT_WINDOW_SEC` para 30 segundos e debouncing no gatilho de análise para cada nova imagem recebida na mesma sessão.

### 14. Correção Manual de Categorias Incorretas
**Pergunta:** Se o `predictCategory` do Mercado Livre falhar ou sugerir uma categoria errada, como o usuário pode forçar um `category_id` específico via chat?
- **Por que importa:** Atributos obrigatórios dependem diretamente da categoria. Se a categoria estiver errada, o bot pedirá atributos inúteis e o anúncio nunca será publicado com sucesso.
- **Default seguro:** Permitir que o usuário envie o comando `categoria_id=MLB12345` a qualquer momento para resetar os atributos e buscar as regras da nova categoria informada.

### 15. Gestão de Memória no Processamento de Imagens
**Pergunta:** Qual o limite de imagens por sessão e como evitaremos estouro de memória ao enviar múltiplas fotos em alta resolução para a API da OpenAI?
- **Por que importa:** Fotos de celulares modernos podem ter 10MB+. Processar 10 fotos simultâneas pode consumir centenas de megabytes de RAM, especialmente se houver múltiplas sessões ativas.
- **Default seguro:** Limitar a 6 fotos por anúncio e realizar o redimensionamento/compressão local das imagens (usando `sharp` ou similar) antes de enviá-las para a OpenAI Vision.

### 16. Tratamento de Throttling (Rate Limiting) das APIs
**Pergunta:** Qual a estratégia de retry para erros `429 (Too Many Requests)` das APIs do Mercado Livre e OpenAI?
- **Por que importa:** Em picos de uso ou se o bot processar muitas imagens rapidamente, as APIs externas podem bloquear o bot temporariamente. O código atual lança uma exceção que coloca a sessão em estado de `error`.
- **Default seguro:** Implementar um *exponential backoff* nas chamadas de API, especialmente no upload de imagens e na criação do item.

### 17. Desconexão e Reautenticação do Baileys
**Pergunta:** O bot deve alertar o administrador (via log ou mensagem) quando a sessão do WhatsApp for desconectada por "Logged Out" ou quando o QR Code expirar?
- **Por que importa:** Se o bot desconectar silenciosamente, o serviço para de funcionar e ninguém percebe até que os usuários reclamem.
- **Default seguro:** Configurar um webhook de notificação (ex: Discord/Slack) que dispara um alerta sempre que o estado da conexão mudar para `close` com motivo diferente de manutenção.

### 18. Robustez do Parser de Entrada do Usuário
**Pergunta:** Como o parser de `chave=valor` deve lidar com entradas malformadas, como espaços extras, emojis ou múltiplas linhas?
- **Por que importa:** Usuários de WhatsApp tendem a digitar de forma informal. Se o parser for muito rígido (ex: exigir exatamente `condicao=novo`), o bot pode ignorar correções importantes.
- **Default seguro:** Usar um parser flexível que ignore maiúsculas/minúsculas, remova espaços ao redor do `=` e suporte aliases comuns (ex: `condição`, `estado`, `novo!`).

### 19. Suporte a Variações de Produto
**Pergunta:** O bot terá suporte inicial para produtos com variações (ex: camisetas com diferentes tamanhos e cores) ou focará apenas em itens únicos?
- **Por que importa:** O payload de variações no Mercado Livre é significativamente mais complexo e requer uma estrutura de dados diferente na criação do item.
- **Default seguro:** No MVP, focar apenas em itens únicos (`single listing`). Se a IA detectar variações, o bot deve avisar que criará um anúncio para a unidade principal e o usuário deve ajustar as variações no painel do ML.

### 20. Logs e Auditoria de Transações
**Pergunta:** Devemos mascarar dados sensíveis nos logs (como o conteúdo das mensagens dos usuários ou IDs de sessão) para conformidade com segurança interna?
- **Por que importa:** Logs de debug podem acabar expondo PII (Informações Identificáveis Pessoais) se não forem tratados, especialmente em ambientes de nuvem onde os logs são agregados.
- **Default seguro:** Configurar o `pino-logger` para sanitizar strings que pareçam tokens de autenticação e garantir que o `db.json` não seja incluído em backups de logs públicos.
