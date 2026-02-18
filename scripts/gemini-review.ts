import 'dotenv/config';

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

type CollectedFile = {
  relPath: string;
  absPath: string;
  languageHint: string;
  content: string;
  bytes: number;
};

const EXCLUDE_DIRS = new Set([
  'node_modules',
  'dist',
  'data',
  '.git',
  '.idea',
  '.vscode',
  '.next',
  '.turbo',
  '.cache',
  '.DS_Store',
  'reports',
]);

const MAX_FILE_BYTES = 200_000;
const MAX_TOTAL_BYTES = 2_500_000;

function extToLangHint(filePath: string): string {
  const base = path.basename(filePath);
  if (base === 'package.json') return 'json';
  if (base === 'tsconfig.json') return 'json';
  if (base === '.gitignore') return 'gitignore';
  if (base.endsWith('.env.example')) return 'dotenv';
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.ts') return 'ts';
  if (ext === '.js') return 'js';
  if (ext === '.json') return 'json';
  if (ext === '.md') return 'md';
  if (ext === '.yml' || ext === '.yaml') return 'yaml';
  if (ext === '.toml') return 'toml';
  return '';
}

function shouldIncludeFile(relPath: string): boolean {
  const base = path.basename(relPath);
  if (base === '.env') return false;
  if (base.startsWith('.env.')) return false;

  const ext = path.extname(relPath).toLowerCase();
  return (
    base === '.gitignore' ||
    base === 'package.json' ||
    base === 'tsconfig.json' ||
    base === 'README.md' ||
    base.endsWith('.env.example') ||
    ['.ts', '.js', '.json', '.md', '.yml', '.yaml', '.toml'].includes(ext)
  );
}

async function collectFiles(rootDir: string): Promise<CollectedFile[]> {
  const out: CollectedFile[] = [];

  async function walk(currentAbs: string): Promise<void> {
    const entries = await fs.readdir(currentAbs, { withFileTypes: true });
    for (const ent of entries) {
      const absPath = path.join(currentAbs, ent.name);
      const relPath = path.relative(rootDir, absPath);

      if (ent.isDirectory()) {
        if (EXCLUDE_DIRS.has(ent.name)) continue;
        await walk(absPath);
        continue;
      }

      if (!ent.isFile()) continue;
      if (!shouldIncludeFile(relPath)) continue;

      const st = await fs.stat(absPath);
      if (st.size > MAX_FILE_BYTES) continue;

      const content = await fs.readFile(absPath, 'utf8');
      out.push({
        relPath,
        absPath,
        languageHint: extToLangHint(relPath),
        content,
        bytes: Buffer.byteLength(content, 'utf8'),
      });
    }
  }

  await walk(rootDir);
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));

  let total = 0;
  const capped: CollectedFile[] = [];
  for (const f of out) {
    if (total + f.bytes > MAX_TOTAL_BYTES) break;
    capped.push(f);
    total += f.bytes;
  }
  return capped;
}

function buildReviewPrompt(): string {
  return [
    'Você é um revisor de código sênior.',
    '',
    'A entrada (stdin) contém:',
    '1) contexto do produto, e',
    '2) um bundle do código-fonte com múltiplos arquivos.',
    '',
    'Tarefa:',
    '- Faça um code review completo e pragmático do projeto.',
    '- Aponte problemas e riscos por severidade: CRITICO / ALTO / MEDIO / BAIXO.',
    '- Cite arquivos e trechos relevantes (pelo nome do arquivo) e descreva por que é um problema.',
    '- Proponha melhorias implementáveis (o que mudar e por que).',
    '- Sugira testes automatizados essenciais.',
    '- Inclua observações específicas sobre: WhatsApp via Baileys (não-oficial), OpenAI vision e API do Mercado Livre (OAuth, atributos obrigatórios, status paused).',
    '',
    'Restrições:',
    '- Não execute comandos, não faça web search, não suponha acesso ao runtime.',
    '- Não reescreva o projeto inteiro; foque em melhorias de alto impacto.',
    '',
    'Saída:',
    '- Markdown.',
    '- Comece com um resumo de 5 a 10 bullets.',
  ].join('\n');
}

function buildContextBlock(): string {
  return [
    'Contexto do projeto:',
    '',
    'Queremos um bot em grupo de WhatsApp que:',
    '- Recebe fotos de produtos no grupo.',
    '- Identifica o produto o melhor possível (visão + texto), podendo fazer perguntas curtas para completar informações.',
    '- Busca itens similares no Mercado Livre para estimar: preço justo e preço para vender rápido.',
    '- Monta um anúncio no Mercado Livre e publica como PAUSADO (desativado) para o usuário revisar antes de ativar.',
    '',
    'Implementação atual (resumo):',
    '- Integra com WhatsApp via Baileys (WhatsApp Web, não-oficial) e roda com QR code.',
    '- Agrupa várias fotos em uma sessão por usuário no grupo, com janela PHOTO_COLLECT_WINDOW_SEC.',
    '- Usa OpenAI (Responses API com vision) para extrair um JSON estruturado com: produto, título/descrição pt-BR, query de busca, perguntas.',
    '- Usa API do Mercado Livre para category predictor, search, atributos obrigatórios, upload de imagens e criação de item (status paused) + descrição.',
    '- Persistência simples em JSON (data/db.json) e mídias em data/media.',
    '',
    'Requisitos de qualidade:',
    '- Robustez (queda/reconexão WhatsApp, erros de rede, rate limits).',
    '- Segurança e privacidade: não vazar tokens, não expor fotos indevidamente, minimizar PII.',
    '- Corretude do anúncio: categoria correta, atributos obrigatórios, condição, preço e descrição honestos.',
    '- Boa UX no grupo: mensagens claras, evitar spam, permitir cancelar/reanalisar.',
    '',
  ].join('\n');
}

function buildCodeBundle(files: CollectedFile[]): string {
  const parts: string[] = [];
  for (const f of files) {
    const lang = f.languageHint || '';
    parts.push(`\n\n# File: ${f.relPath}\n\n\`\`\`${lang}\n${f.content}\n\`\`\`\n`);
  }
  return parts.join('');
}

function extractFirstJsonObject(text: string): any {
  const start = text.indexOf('{');
  if (start === -1) throw new Error('Gemini CLI did not output JSON.');

  let inString = false;
  let escape = false;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\\\') {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        const jsonStr = text.slice(start, i + 1);
        return JSON.parse(jsonStr);
      }
    }
  }

  throw new Error('Failed to parse JSON from Gemini CLI output.');
}

async function runGeminiCli(prompt: string, stdinText: string, model?: string): Promise<any> {
  const args: string[] = ['-p', prompt, '--output-format', 'json'];
  if (model) args.push('-m', model);

  const child = spawn('gemini', args, { stdio: ['pipe', 'pipe', 'pipe'] });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));

  child.stdin.write(stdinText);
  child.stdin.end();

  const code = await new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });

  if (code !== 0) {
    throw new Error(`gemini CLI failed (exit=${code}).\n${stderr || stdout}`);
  }

  return extractFirstJsonObject(stdout || stderr);
}

async function main(): Promise<void> {
  const rootDir = path.resolve(process.cwd());
  const model = process.env.GEMINI_MODEL || process.env.GEMINI_CLI_MODEL || undefined;

  const files = await collectFiles(rootDir);
  const totalBytes = files.reduce((sum, f) => sum + f.bytes, 0);

  const stdinText = `${buildContextBlock()}\nArquivos (${files.length}) total_bytes=${totalBytes}:\n${buildCodeBundle(files)}`;
  const prompt = buildReviewPrompt();

  const data = await runGeminiCli(prompt, stdinText, model);

  const responseText = String(data?.response ?? '');
  const models = (data?.stats?.models ?? {}) as Record<string, unknown>;
  const usedModel = Object.keys(models)[0] ?? model ?? 'unknown';

  const reportsDir = path.join(rootDir, 'reports');
  await fs.mkdir(reportsDir, { recursive: true });
  const outPath = path.join(reportsDir, `gemini-cli-review-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);

  const header = [
    `# Gemini CLI Code Review`,
    ``,
    `- model: ${usedModel}`,
    `- generated_at: ${new Date().toISOString()}`,
    `- files_sent: ${files.length}`,
    `- total_bytes_sent: ${totalBytes}`,
    ``,
  ].join('\n');

  await fs.writeFile(outPath, `${header}\n${responseText}\n`, 'utf8');

  // eslint-disable-next-line no-console
  console.log(`Saved: ${outPath}\n`);
  // eslint-disable-next-line no-console
  console.log(responseText);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

