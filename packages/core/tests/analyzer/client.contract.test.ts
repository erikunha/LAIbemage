/**
 * Contract tests for LLMClient adapters.
 *
 * These tests make REAL API calls to verify that provider SDK upgrades do not
 * silently break the adapter layer.
 *
 * Skipped unless CI_CONTRACT=1 is set in the environment.
 * Run via: CI_CONTRACT=1 npx vitest run tests/analyzer/client.contract.test.ts
 *
 * Requires the following env vars (or .env file):
 *   OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT = process.env['CI_CONTRACT'] === '1';

// Conditional skip: all tests in this file are skipped unless CI_CONTRACT=1
const maybeDescribe = CONTRACT ? describe : describe.skip;

// Load a real fixture JPEG as base64 for the API calls
async function loadFixtureBase64(name: string): Promise<string> {
  const fixturePath = path.join(__dirname, '..', 'fixtures', 'images', name);
  const buf = await readFile(fixturePath);
  return buf.toString('base64');
}

// Minimal categories config matching the expected response shape
const CATEGORIES_PROMPT = `You will receive 1 image.
Available categories:
- test_image   (a solid-colour test image)
- unknown      (cannot be determined)

Respond with JSON: { "images": [{ "index": 1, "category": "test_image", "shortDescription": "solid colour test", "elements": [], "confidence": 0.9, "extractedText": "" }] }`;

function assertValidResult(result: { text: string; tokensUsed: number }): void {
  expect(typeof result.text).toBe('string');
  expect(result.text.length).toBeGreaterThan(0);
  expect(result.tokensUsed).toBeGreaterThan(0);

  const stripped = result.text
    .replace(/```(?:json)?\s*/g, '')
    .replace(/```/g, '')
    .trim();
  const parsed = JSON.parse(stripped) as { images?: unknown[] };
  expect(Array.isArray(parsed.images)).toBe(true);
  expect(parsed.images!.length).toBe(1);
}

maybeDescribe('LLMClient contract — OpenAI', () => {
  it('returns a valid AnalysisResult shape for a real image', async () => {
    const { createLLMClient } = await import('../../src/analyzer/client.js');
    const base64 = await loadFixtureBase64('red.jpg');

    const config = {
      provider: 'openai' as const,
      apiKey: process.env['OPENAI_API_KEY'] ?? '',
      model: 'gpt-4o',
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = createLLMClient(config as any);
    const result = await client.complete(
      CATEGORIES_PROMPT,
      [{ base64, label: '--- Image 1 ---' }],
      {
        maxTokens: 256,
        detail: 'low',
      },
    );
    assertValidResult(result);
  });
});

maybeDescribe('LLMClient contract — Anthropic', () => {
  it('returns a valid AnalysisResult shape for a real image', async () => {
    const { createLLMClient } = await import('../../src/analyzer/client.js');
    const base64 = await loadFixtureBase64('green.jpg');

    const config = {
      provider: 'anthropic' as const,
      anthropicApiKey: process.env['ANTHROPIC_API_KEY'] ?? '',
      model: 'claude-opus-4-7',
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = createLLMClient(config as any);
    const result = await client.complete(
      CATEGORIES_PROMPT,
      [{ base64, label: '--- Image 1 ---' }],
      {
        maxTokens: 256,
      },
    );
    assertValidResult(result);
  });
});

maybeDescribe('LLMClient contract — Google', () => {
  it('returns a valid AnalysisResult shape for a real image', async () => {
    const { createLLMClient } = await import('../../src/analyzer/client.js');
    const base64 = await loadFixtureBase64('blue.jpg');

    const config = {
      provider: 'google' as const,
      googleApiKey: process.env['GOOGLE_API_KEY'] ?? '',
      model: 'gemini-2.0-flash',
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = createLLMClient(config as any);
    const result = await client.complete(
      CATEGORIES_PROMPT,
      [{ base64, label: '--- Image 1 ---' }],
      {
        maxTokens: 256,
      },
    );
    assertValidResult(result);
  });
});
