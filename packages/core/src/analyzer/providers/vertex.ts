import { VertexAI } from '@google-cloud/vertexai';
import type { Config } from '../../config/index.js';
import type { CompleteOptions, CompleteResult, ImageInput, LLMClient } from '../client.js';
import { extractJson } from './schemas.js';

export function createVertexClient(config: Config): LLMClient {
  const vertexAI = new VertexAI({
    project: config.vertexProjectId ?? process.env['GOOGLE_CLOUD_PROJECT'] ?? '',
    location: config.vertexLocation ?? 'us-central1',
  });

  return {
    async complete(
      prompt: string,
      images: ImageInput[],
      opts: CompleteOptions,
    ): Promise<CompleteResult> {
      const generativeModel = vertexAI.getGenerativeModel({
        model: config.model,
        generationConfig: {
          maxOutputTokens: opts.maxTokens,
          responseMimeType: 'application/json',
        },
        ...(opts.systemPrompt ? { systemInstruction: opts.systemPrompt } : {}),
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parts: any[] = [{ text: prompt }];
      for (const img of images) {
        parts.push({ text: img.label });
        parts.push({ inlineData: { mimeType: 'image/jpeg', data: img.base64 } });
      }

      const result = await generativeModel.generateContent({
        contents: [{ role: 'user', parts }],
      });

      const response = result.response;
      const rawText = response.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';

      const inputTokens = response.usageMetadata?.promptTokenCount ?? 0;
      const outputTokens = response.usageMetadata?.candidatesTokenCount ?? 0;

      return {
        text: extractJson(rawText),
        inputTokens,
        outputTokens,
        tokensUsed: inputTokens + outputTokens,
      };
    },
  };
}
