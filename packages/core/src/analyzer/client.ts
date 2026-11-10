/**
 * Unified LLM client adapter.
 *
 * Provides a single `LLMClient` interface backed by OpenAI, Anthropic, Google Gemini,
 * Azure OpenAI, or Ollama. Only this file (and the provider files it imports) imports
 * provider SDKs — all other analyzer code uses `LLMClient` / `AsyncBatchClient`.
 */
import type { Config } from '../config/index.js';
import { createAnthropicAsyncBatchClient, createAnthropicClient } from './providers/anthropic.js';
import { createAzureAsyncBatchClient, createAzureOpenAIClient } from './providers/azure.js';
import { createBedrockClient } from './providers/bedrock.js';
import { createGoogleClient } from './providers/google.js';
import { createOllamaClient } from './providers/ollama.js';
import { createOpenAIAsyncBatchClient, createOpenAIClient } from './providers/openai.js';
import { createVertexClient } from './providers/vertex.js';

export interface ImageInput {
  /** JPEG image encoded as base64. */
  readonly base64: string;
  /** Short human-readable label inserted before the image (e.g. "--- Image 3 (photo.jpg) ---"). */
  readonly label: string;
}

export interface CompleteOptions {
  readonly maxTokens: number;
  /** Hint for providers that support tiered image processing (OpenAI only). */
  readonly detail?: 'low' | 'high';
  /** Static system prompt — passed as a system message and cached by providers that support it. */
  readonly systemPrompt?: string;
}

export interface CompleteResult {
  /** Raw text returned by the model — already JSON-safe (markdown fences stripped). */
  readonly text: string;
  readonly tokensUsed: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface LLMClient {
  complete(prompt: string, images: ImageInput[], opts: CompleteOptions): Promise<CompleteResult>;
}

export interface AsyncBatchRequest {
  readonly customId: string;
  readonly prompt: string;
  readonly images: ImageInput[];
  readonly opts: CompleteOptions;
}

export interface AsyncBatchJobInfo {
  readonly jobId: string;
  readonly customIds: readonly string[];
}

export interface AsyncBatchResult {
  readonly customId: string;
  readonly text: string;
  readonly status: 'success' | 'failed';
}

export interface AsyncBatchClient {
  submitBatch(requests: readonly AsyncBatchRequest[]): Promise<AsyncBatchJobInfo>;
  checkStatus(jobId: string): Promise<'pending' | 'complete' | 'failed'>;
  retrieveResults(jobId: string, customIds: readonly string[]): Promise<AsyncBatchResult[]>;
}

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

/**
 * Returns an async batch client for providers that support async batching (OpenAI, Anthropic, Azure).
 * Returns null for providers that fall back to synchronous execution (Google, Ollama).
 */
export function createAsyncBatchClient(config: Config): AsyncBatchClient | null {
  switch (config.provider) {
    case 'openai':
      return createOpenAIAsyncBatchClient(config);
    case 'anthropic':
      return createAnthropicAsyncBatchClient(config);
    case 'azure':
      return createAzureAsyncBatchClient(config);
    default:
      return null;
  }
}

export function createLLMClient(config: Config): LLMClient {
  switch (config.provider) {
    case 'anthropic':
      return createAnthropicClient(config);
    case 'google':
      return createGoogleClient(config);
    case 'azure':
      return createAzureOpenAIClient(config);
    case 'ollama':
      return createOllamaClient(config);
    case 'hybrid':
      // Tier-1 local client: Ollama with localModel
      return createOllamaClient({ ...config, model: config.localModel });
    case 'bedrock':
      return createBedrockClient(config);
    case 'vertex':
      return createVertexClient(config);
    default:
      return createOpenAIClient(config);
  }
}

/** Create the cloud client used for tier-2 escalation in hybrid mode. */
export function createCloudClientForHybrid(config: Config): LLMClient {
  switch (config.cloudProvider) {
    case 'anthropic':
      return createAnthropicClient(config);
    case 'google':
      return createGoogleClient(config);
    default:
      return createOpenAIClient(config);
  }
}
