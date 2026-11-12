import OpenAI, { toFile } from 'openai';
import type { Config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import type { AsyncBatchClient, AsyncBatchRequest, LLMClient } from '../client.js';
import { BATCH_RESPONSE_SCHEMA } from './schemas.js';

export function createOpenAIClient(config: Config): LLMClient {
  const openai = new OpenAI({ apiKey: config.apiKey });

  return {
    async complete(prompt, images, opts) {
      const content: OpenAI.Chat.ChatCompletionContentPart[] = [{ type: 'text', text: prompt }];

      for (const img of images) {
        content.push({ type: 'text', text: img.label });
        content.push({
          type: 'image_url',
          image_url: {
            url: `data:image/jpeg;base64,${img.base64}`,
            detail: opts.detail ?? 'low',
          },
        });
      }

      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
      if (opts.systemPrompt) {
        messages.push({ role: 'system', content: opts.systemPrompt });
      }
      messages.push({ role: 'user', content });

      const response = await openai.chat.completions.create({
        model: config.model,
        messages,
        max_tokens: opts.maxTokens,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'batch_analysis', strict: true, schema: BATCH_RESPONSE_SCHEMA },
        },
      });

      return {
        text: response.choices[0]?.message.content ?? '{}',
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
        tokensUsed: response.usage?.total_tokens ?? 0,
      };
    },
  };
}

export function createOpenAIAsyncBatchClient(config: Config): AsyncBatchClient {
  const openai = new OpenAI({ apiKey: config.apiKey });

  return {
    async submitBatch(requests: readonly AsyncBatchRequest[]) {
      const lines: string[] = [];
      const customIds: string[] = [];

      for (const req of requests) {
        const content: OpenAI.Chat.ChatCompletionContentPart[] = [
          { type: 'text', text: req.prompt },
        ];
        for (const img of req.images) {
          content.push({ type: 'text', text: img.label });
          content.push({
            type: 'image_url',
            image_url: {
              url: `data:image/jpeg;base64,${img.base64}`,
              detail: req.opts.detail ?? 'low',
            },
          });
        }
        const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
        if (req.opts.systemPrompt) {
          messages.push({ role: 'system', content: req.opts.systemPrompt });
        }
        messages.push({ role: 'user', content });

        lines.push(
          JSON.stringify({
            custom_id: req.customId,
            method: 'POST',
            url: '/v1/chat/completions',
            body: {
              model: config.model,
              messages,
              max_tokens: req.opts.maxTokens,
              response_format: {
                type: 'json_schema',
                json_schema: {
                  name: 'batch_analysis',
                  strict: true,
                  schema: BATCH_RESPONSE_SCHEMA,
                },
              },
            },
          }),
        );
        customIds.push(req.customId);
      }

      const jsonl = lines.join('\n');
      const file = await openai.files.create({
        file: await toFile(Buffer.from(jsonl, 'utf-8'), 'batch.jsonl', {
          type: 'application/json',
        }),
        purpose: 'batch',
      });

      const batch = await openai.batches.create({
        input_file_id: file.id,
        endpoint: '/v1/chat/completions',
        completion_window: '24h',
      });

      logger.verbose(`  OpenAI async batch created: ${batch.id} (file: ${file.id})`);
      return { jobId: batch.id, customIds };
    },

    async checkStatus(jobId: string) {
      const batch = await openai.batches.retrieve(jobId);
      if (batch.status === 'completed') return 'complete';
      if (['failed', 'expired', 'cancelled', 'cancelling'].includes(batch.status)) return 'failed';
      return 'pending';
    },

    async retrieveResults(jobId: string, customIds: readonly string[]) {
      const batch = await openai.batches.retrieve(jobId);
      if (!batch.output_file_id) {
        throw new Error(`Batch ${jobId} has no output file (status: ${batch.status})`);
      }

      const fileContent = await openai.files.content(batch.output_file_id);
      const text = await fileContent.text();

      const resultsMap = new Map<string, string>();
      for (const line of text.split('\n').filter((l) => l.trim())) {
        const entry = JSON.parse(line) as {
          custom_id: string;
          response: {
            status_code: number;
            body: { choices: Array<{ message: { content: string | null } }> };
          };
          error?: unknown;
        };
        if (entry.response?.status_code === 200) {
          resultsMap.set(entry.custom_id, entry.response.body.choices[0]?.message.content ?? '{}');
        }
      }

      return customIds.map((id) => ({
        customId: id,
        text: resultsMap.get(id) ?? '{}',
        status: (resultsMap.has(id) ? 'success' : 'failed') as 'success' | 'failed',
      }));
    },
  };
}
