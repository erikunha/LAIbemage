/**
 * H9.1 — Text-embedding generation.
 *
 * After a batch run, when --embed is passed, embed each image's classification
 * text using the provider's embedding API.
 *
 * Only this file imports provider SDKs for embeddings — it follows the same
 * constraint as src/analyzer/client.ts.
 */
import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import type { Config } from '../config/index.js';
import type { ProcessedResult } from '../types.js';

export interface EmbeddingEntry {
  readonly number: number;
  readonly file: string;
  readonly vector: number[];
}

/**
 * Build the embedding input text for a single ProcessedResult.
 * Includes fullDescription when present for richer semantic retrieval.
 */
function buildEmbeddingText(result: ProcessedResult): string {
  const base = `${result.category}: ${result.shortDescription}. Elements: ${result.elements.join(', ')}`;
  return result.fullDescription ? `${base}. ${result.fullDescription}` : base;
}

/** Embed a single text string via OpenAI (or Azure OpenAI) using text-embedding-3-small. */
async function embedWithOpenAI(text: string, apiKey: string): Promise<number[]> {
  const client = new OpenAI({ apiKey });
  const response = await client.embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
  });
  const embedding = response.data[0]?.embedding;
  if (!embedding) {
    throw new Error('[embeddings] OpenAI returned an empty embedding response.');
  }
  return embedding;
}

/** Embed a single text string via Google Generative AI using text-embedding-004. */
async function embedWithGoogle(text: string, apiKey: string): Promise<number[]> {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'text-embedding-004' });
  const result = await model.embedContent(text);
  const values = result.embedding?.values;
  if (!values || values.length === 0) {
    throw new Error('[embeddings] Google returned an empty embedding response.');
  }
  return values;
}

/** Embed a single text string via Ollama using nomic-embed-text. */
async function embedWithOllama(text: string, ollamaUrl: string): Promise<number[]> {
  const url = `${ollamaUrl.replace(/\/$/, '')}/api/embeddings`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'nomic-embed-text', prompt: text }),
  });
  if (!response.ok) {
    throw new Error(
      `[embeddings] Ollama embedding request failed: ${response.status} ${response.statusText}`,
    );
  }
  const data = (await response.json()) as { embedding?: number[] };
  if (!data.embedding || data.embedding.length === 0) {
    throw new Error('[embeddings] Ollama returned an empty embedding response.');
  }
  return data.embedding;
}

/**
 * Generate embeddings for a list of ProcessedResults using the configured provider.
 *
 * Provider routing:
 * - openai / azure  → text-embedding-3-small (1536 dims)
 * - google / vertex → text-embedding-004 (768 dims)
 * - anthropic / bedrock → falls back to OpenAI if apiKey is set, else throws
 * - ollama → nomic-embed-text via POST /api/embeddings
 * - hybrid → uses the cloud provider embedding path (openai/google/anthropic)
 *
 * Processing is sequential — embeddings are a post-run step and do not need concurrency.
 */
export async function generateEmbeddings(
  results: ProcessedResult[],
  config: Config,
): Promise<EmbeddingEntry[]> {
  const entries: EmbeddingEntry[] = [];

  for (const result of results) {
    const text = buildEmbeddingText(result);
    let vector: number[];

    switch (config.provider) {
      case 'openai':
      case 'azure':
        vector = await embedWithOpenAI(text, config.apiKey);
        break;

      case 'google':
      case 'vertex':
        vector = await embedWithGoogle(text, config.googleApiKey);
        break;

      case 'anthropic':
      case 'bedrock':
        if (!config.apiKey) {
          throw new Error(
            'Anthropic/Bedrock provider does not support embeddings. Set OPENAI_API_KEY to use OpenAI embeddings as a fallback.',
          );
        }
        vector = await embedWithOpenAI(text, config.apiKey);
        break;

      case 'ollama':
        vector = await embedWithOllama(text, config.ollamaUrl ?? 'http://localhost:11434');
        break;

      case 'hybrid': {
        // Use the cloud provider's embedding path
        const cloud = config.cloudProvider;
        if (cloud === 'google') {
          vector = await embedWithGoogle(text, config.googleApiKey);
        } else if (cloud === 'anthropic') {
          if (!config.apiKey) {
            throw new Error(
              'Anthropic/Bedrock provider does not support embeddings. Set OPENAI_API_KEY to use OpenAI embeddings as a fallback.',
            );
          }
          vector = await embedWithOpenAI(text, config.apiKey);
        } else {
          // default openai
          vector = await embedWithOpenAI(text, config.apiKey);
        }
        break;
      }

      default:
        vector = await embedWithOpenAI(text, config.apiKey);
    }

    entries.push({ number: result.number, file: result.originalFile, vector });
  }

  return entries;
}
