import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import type { Config } from '../../config/index.js';
import type { CompleteOptions, CompleteResult, ImageInput, LLMClient } from '../client.js';
import { extractJson } from './schemas.js';

export function createBedrockClient(config: Config): LLMClient {
  const client = new BedrockRuntimeClient({
    region: config.bedrockRegion ?? 'us-east-1',
    ...(config.bedrockAccessKeyId && config.bedrockSecretAccessKey
      ? {
          credentials: {
            accessKeyId: config.bedrockAccessKeyId,
            secretAccessKey: config.bedrockSecretAccessKey,
          },
        }
      : {}),
  });

  return {
    async complete(
      prompt: string,
      images: ImageInput[],
      opts: CompleteOptions,
    ): Promise<CompleteResult> {
      // Build Anthropic-style messages for Bedrock's Claude
      const content: unknown[] = [{ type: 'text', text: prompt }];
      for (const img of images) {
        content.push({ type: 'text', text: img.label });
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: img.base64 },
        });
      }

      const body = {
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: opts.maxTokens,
        ...(opts.systemPrompt ? { system: opts.systemPrompt } : {}),
        messages: [{ role: 'user', content }],
      };

      const command = new InvokeModelCommand({
        modelId: config.model,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(body),
      });

      const response = await client.send(command);
      const responseBody = JSON.parse(new TextDecoder().decode(response.body)) as {
        content: Array<{ type: string; text?: string }>;
        usage?: { input_tokens: number; output_tokens: number };
      };

      const textBlock = responseBody.content.find((b) => b.type === 'text');
      const rawText = textBlock?.text ?? '{}';

      const inputTokens = responseBody.usage?.input_tokens ?? 0;
      const outputTokens = responseBody.usage?.output_tokens ?? 0;

      return {
        text: extractJson(rawText),
        inputTokens,
        outputTokens,
        tokensUsed: inputTokens + outputTokens,
      };
    },
  };
}
