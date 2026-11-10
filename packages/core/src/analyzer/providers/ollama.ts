import OpenAI from 'openai';
import type { Config } from '../../config/index.js';
import type { LLMClient } from '../client.js';
import { extractJson } from './schemas.js';

export function createOllamaClient(config: Config): LLMClient {
  // Ollama exposes an OpenAI-compatible REST API at <base-url>/v1
  const ollama = new OpenAI({
    baseURL: `${(config.ollamaUrl ?? 'http://localhost:11434').replace(/\/$/, '')}/v1`,
    apiKey: 'ollama', // Ollama does not require an API key; placeholder required by SDK
  });

  return {
    async complete(prompt, images, opts) {
      const content: OpenAI.Chat.ChatCompletionContentPart[] = [{ type: 'text', text: prompt }];

      for (const img of images) {
        content.push({ type: 'text', text: img.label });
        content.push({
          type: 'image_url',
          image_url: {
            url: `data:image/jpeg;base64,${img.base64}`,
            // Ollama does not support detail:low/high — omit to avoid server-side errors
          },
        });
      }

      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
      if (opts.systemPrompt) {
        messages.push({ role: 'system', content: opts.systemPrompt });
      }
      messages.push({ role: 'user', content });

      const response = await ollama.chat.completions.create({
        model: config.model,
        messages,
        max_tokens: opts.maxTokens,
      });

      return {
        text: extractJson(response.choices[0]?.message.content ?? '{}'),
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
        tokensUsed: response.usage?.total_tokens ?? 0,
      };
    },
  };
}
