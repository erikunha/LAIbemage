import Anthropic from '@anthropic-ai/sdk';
import type { Config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import type { AsyncBatchClient, AsyncBatchRequest, LLMClient } from '../client.js';
import { ANTHROPIC_BATCH_TOOL } from './schemas.js';

export function createAnthropicClient(config: Config): LLMClient {
  const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

  return {
    async complete(prompt, images, opts) {
      const content: Anthropic.MessageParam['content'] = [{ type: 'text', text: prompt }];

      for (const img of images) {
        content.push({ type: 'text', text: img.label });
        content.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/jpeg',
            data: img.base64,
          },
        });
      }

      const systemBlock: Anthropic.TextBlockParam[] | undefined = opts.systemPrompt
        ? [
            {
              type: 'text',
              text: opts.systemPrompt,
              cache_control: { type: 'ephemeral' },
            },
          ]
        : undefined;

      const response = await anthropic.messages.create({
        model: config.model,
        max_tokens: opts.maxTokens,
        ...(systemBlock && { system: systemBlock }),
        tools: [ANTHROPIC_BATCH_TOOL],
        tool_choice: { type: 'tool', name: 'submit_analysis' },
        messages: [{ role: 'user', content }],
      });

      const toolBlock = response.content.find(
        (b): b is Anthropic.Messages.ToolUseBlock =>
          b.type === 'tool_use' && b.name === 'submit_analysis',
      );
      const rawText = toolBlock ? JSON.stringify(toolBlock.input) : '{}';

      const usage = response.usage as Anthropic.Usage & {
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      };
      if (usage.cache_creation_input_tokens || usage.cache_read_input_tokens) {
        logger.verbose(
          `  Anthropic cache: created=${usage.cache_creation_input_tokens ?? 0} read=${usage.cache_read_input_tokens ?? 0}`,
        );
      }

      return {
        text: rawText,
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        tokensUsed: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
      };
    },
  };
}

export function createAnthropicAsyncBatchClient(config: Config): AsyncBatchClient {
  const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

  return {
    async submitBatch(requests: readonly AsyncBatchRequest[]) {
      const batchRequests: Anthropic.Messages.Batches.BatchCreateParams.Request[] = [];
      const customIds: string[] = [];

      for (const req of requests) {
        const content: Anthropic.MessageParam['content'] = [{ type: 'text', text: req.prompt }];
        for (const img of req.images) {
          content.push({ type: 'text', text: img.label });
          content.push({
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: img.base64 },
          });
        }
        const systemBlock: Anthropic.TextBlockParam[] | undefined = req.opts.systemPrompt
          ? [{ type: 'text', text: req.opts.systemPrompt, cache_control: { type: 'ephemeral' } }]
          : undefined;

        batchRequests.push({
          custom_id: req.customId,
          params: {
            model: config.model,
            max_tokens: req.opts.maxTokens,
            ...(systemBlock && { system: systemBlock }),
            tools: [ANTHROPIC_BATCH_TOOL],
            tool_choice: { type: 'tool', name: 'submit_analysis' },
            messages: [{ role: 'user', content }],
          },
        });
        customIds.push(req.customId);
      }

      const batch = await anthropic.messages.batches.create({ requests: batchRequests });
      logger.verbose(`  Anthropic async batch created: ${batch.id}`);
      return { jobId: batch.id, customIds };
    },

    async checkStatus(jobId: string) {
      const batch = await anthropic.messages.batches.retrieve(jobId);
      if (batch.processing_status === 'ended') return 'complete';
      if (batch.processing_status === 'canceling') return 'failed';
      return 'pending';
    },

    async retrieveResults(jobId: string, customIds: readonly string[]) {
      const resultsMap = new Map<string, string>();

      for await (const item of await anthropic.messages.batches.results(jobId)) {
        if (item.result.type === 'succeeded') {
          const toolBlock = item.result.message.content.find(
            (b): b is Anthropic.Messages.ToolUseBlock =>
              b.type === 'tool_use' && b.name === 'submit_analysis',
          );
          resultsMap.set(item.custom_id, toolBlock ? JSON.stringify(toolBlock.input) : '{}');
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
