import fs from 'node:fs/promises';

import OpenAI from 'openai';
import type { ResponseInputItem } from 'openai/resources/responses/responses';
import { z } from 'zod';

import { config } from '../config.js';
import { logger } from '../logger.js';
import type { VisionResult } from '../types.js';
import { extractFirstJsonObject } from '../utils/json.js';

const visionResultZ = z.object({
  confidence: z.number().min(0).max(1),
  product: z.object({
    short_name: z.string().min(1),
    likely_category: z.string().min(1),
    brand: z.string().nullable(),
    model: z.string().nullable(),
    variant: z.string().nullable(),
    condition: z.enum(['new', 'used', 'refurbished', 'unknown']),
    color: z.string().nullable(),
    material: z.string().nullable(),
    quantity: z.number().int().positive().nullable(),
    included: z.array(z.string()),
    defects: z.array(z.string()),
    notes: z.array(z.string()),
  }),
  listing: z.object({
    title: z.string().min(1),
    title_alternatives: z.array(z.string()),
    description_ptbr: z.string().min(1),
    search_query: z.string().min(1),
    keywords: z.array(z.string()),
  }),
  questions: z.array(
    z.object({
      key: z.string().min(1),
      question: z.string().min(1),
      kind: z.enum(['text', 'choice', 'boolean']),
      options: z.array(z.string()).optional(),
    }),
  ),
});

function visionJsonSchema(): Record<string, unknown> {
  // Keep it simple; Structured Outputs supports a subset of JSON Schema when strict=true.
  return {
    type: 'object',
    additionalProperties: false,
    required: ['confidence', 'product', 'listing', 'questions'],
    properties: {
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      product: {
        type: 'object',
        additionalProperties: false,
        required: [
          'short_name',
          'likely_category',
          'brand',
          'model',
          'variant',
          'condition',
          'color',
          'material',
          'quantity',
          'included',
          'defects',
          'notes',
        ],
        properties: {
          short_name: { type: 'string' },
          likely_category: { type: 'string' },
          brand: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          model: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          variant: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          condition: { type: 'string', enum: ['new', 'used', 'refurbished', 'unknown'] },
          color: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          material: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          quantity: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
          included: { type: 'array', items: { type: 'string' } },
          defects: { type: 'array', items: { type: 'string' } },
          notes: { type: 'array', items: { type: 'string' } },
        },
      },
      listing: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'title_alternatives', 'description_ptbr', 'search_query', 'keywords'],
        properties: {
          title: { type: 'string' },
          title_alternatives: { type: 'array', items: { type: 'string' } },
          description_ptbr: { type: 'string' },
          search_query: { type: 'string' },
          keywords: { type: 'array', items: { type: 'string' } },
        },
      },
      questions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['key', 'question', 'kind'],
          properties: {
            key: { type: 'string' },
            question: { type: 'string' },
            kind: { type: 'string', enum: ['text', 'choice', 'boolean'] },
            options: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  };
}

function buildPrompt(): string {
  return [
    'Você é um assistente especialista em criar anúncios no Mercado Livre (Brasil).',
    '',
    'Tarefa: dado 1+ fotos de um produto, identificar o produto o melhor possível e produzir:',
    '- um rascunho de anúncio (título e descrição pt-BR)',
    '- uma query de busca para encontrar similares no Mercado Livre',
    '- perguntas objetivas para completar dados faltantes (se necessário)',
    '',
    'Regras:',
    '- Responda em pt-BR.',
    '- Se houver texto/etiquetas/códigos na foto, extraia e use como evidência para marca/modelo.',
    '- Não invente marca/modelo: se não tiver certeza, use null.',
    '- O título deve ser curto e claro (sem CAPS exagerado, sem emojis).',
    '- A descrição deve ser honesta, com seções: "O que é", "Estado/Condição", "O que acompanha", "Observações".',
    '- Em "questions", pergunte apenas o mínimo necessário para publicar um anúncio correto.',
    '',
    'Campo condition: new/used/refurbished/unknown.',
  ].join('\n');
}

function dataUrlFromBuffer(mimeType: string, buf: Buffer): string {
  const b64 = buf.toString('base64');
  return `data:${mimeType};base64,${b64}`;
}

function guessMimeType(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  return 'image/jpeg';
}

export class OpenAIVisionService {
  private client: OpenAI;

  constructor() {
    this.client = new OpenAI({ apiKey: config.openai.apiKey, baseURL: config.openai.baseUrl });
  }

  async analyzeProduct(imagePaths: string[]): Promise<VisionResult> {
    const images = await Promise.all(
      imagePaths.slice(0, 8).map(async (p) => {
        const buf = await fs.readFile(p);
        const mime = guessMimeType(p);
        return {
          type: 'input_image' as const,
          detail: 'high' as const,
          image_url: dataUrlFromBuffer(mime, buf),
        };
      }),
    );

    const input: ResponseInputItem[] = [
      {
        role: 'user',
        content: [{ type: 'input_text', text: buildPrompt() }, ...images],
      },
    ];

    // 1) Try Responses API Structured Outputs (json_schema).
    try {
      const rsp = await this.client.responses.parse({
        model: config.openai.modelVision,
        input,
        text: {
          format: {
            type: 'json_schema',
            name: 'ml_product_vision',
            strict: true,
            schema: visionJsonSchema(),
          },
        },
      });

      const parsed = rsp.output_parsed;
      const validated = visionResultZ.parse(parsed);
      return validated as VisionResult;
    } catch (err) {
      logger.warn({ err }, 'OpenAI Responses structured output failed; trying fallbacks');
    }

    // 2) Try Responses API json_object + zod validation.
    try {
      const rsp = await this.client.responses.create({
        model: config.openai.modelVision,
        input,
        text: { format: { type: 'json_object' } },
      });

      const outputText: string = (rsp as any).output_text ?? '';
      const obj = extractFirstJsonObject(outputText);
      const validated = visionResultZ.parse(obj);
      return validated as VisionResult;
    } catch (err) {
      logger.warn({ err }, 'OpenAI Responses json_object failed; trying chat.completions');
    }

    // 3) OpenAI-compatible fallback: Chat Completions (many gateways implement this but not /responses).
    const chatMessages: any[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: `${buildPrompt()}\n\nResponda SOMENTE com um JSON válido.` },
          ...images.map((img) => ({
            type: 'image_url',
            image_url: { url: img.image_url, detail: img.detail },
          })),
        ],
      },
    ];

    // First attempt with response_format (if supported).
    try {
      const rsp = await (this.client as any).chat.completions.create({
        model: config.openai.modelVision,
        messages: chatMessages,
        response_format: { type: 'json_object' },
      });
      const content = String(rsp?.choices?.[0]?.message?.content ?? '').trim();
      const obj = extractFirstJsonObject(content);
      const validated = visionResultZ.parse(obj);
      return validated as VisionResult;
    } catch (err) {
      logger.warn({ err }, 'chat.completions with response_format failed; retrying without response_format');
    }

    const rsp2 = await (this.client as any).chat.completions.create({
      model: config.openai.modelVision,
      messages: chatMessages,
    });
    const content2 = String(rsp2?.choices?.[0]?.message?.content ?? '').trim();
    const obj2 = extractFirstJsonObject(content2);
    const validated2 = visionResultZ.parse(obj2);
    return validated2 as VisionResult;
  }
}
