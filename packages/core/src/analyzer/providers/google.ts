import { GoogleGenerativeAI } from '@google/generative-ai';
import type { Config } from '../../config/index.js';
import type { LLMClient } from '../client.js';
import { BATCH_RESPONSE_SCHEMA, extractJson } from './schemas.js';

export function createGoogleClient(config: Config): LLMClient {
  const genAI = new GoogleGenerativeAI(config.googleApiKey);

  return {
    async complete(prompt, images, opts) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const modelOptions: any = {
        model: config.model,
        generationConfig: {
          maxOutputTokens: opts.maxTokens,
          responseMimeType: 'application/json',
          responseSchema: BATCH_RESPONSE_SCHEMA,
        },
      };
      if (opts.systemPrompt) {
        modelOptions.systemInstruction = opts.systemPrompt;
      }
      const model = genAI.getGenerativeModel(modelOptions);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parts: any[] = [{ text: prompt }];
      for (const img of images) {
        parts.push({ text: img.label });
        parts.push({ inlineData: { mimeType: 'image/jpeg', data: img.base64 } });
      }

      const result = await model.generateContent({ contents: [{ role: 'user', parts }] });
      const rawText = result.response.text();

      return {
        text: extractJson(rawText),
        inputTokens: result.response.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: result.response.usageMetadata?.candidatesTokenCount ?? 0,
        tokensUsed: result.response.usageMetadata?.totalTokenCount ?? 0,
      };
    },
  };
}
