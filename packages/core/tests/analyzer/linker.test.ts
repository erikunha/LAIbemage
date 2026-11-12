import { describe, expect, it, vi } from 'vitest';
import { linkImages } from '../../src/analyzer/linker.js';
import type { LLMClient } from '../../src/analyzer/client.js';
import type { ProcessedResult } from '../../src/types.js';

function makeResult(overrides: Partial<ProcessedResult> = {}): ProcessedResult {
  return {
    originalFile: 'IMG_001.jpeg',
    outputFile: '001. Photo.jpeg',
    category: 'kitchen',
    number: 1,
    shortDescription: 'kitchen overview',
    elements: [],
    confidence: 0.9,
    extractedText: null,
    timestamp: 0,
    ...overrides,
  };
}

function makeClient(responseText: string): LLMClient {
  return {
    complete: vi.fn().mockResolvedValue({
      text: responseText,
      tokensUsed: 10,
      inputTokens: 8,
      outputTokens: 2,
    }),
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

describe('linkImages', () => {
  it('returns empty map when no images provided', async () => {
    const client = makeClient('{"links":[]}');
    const result = await linkImages([], client, 7, 1, 0);
    expect(result.size).toBe(0);
  });

  it('skips groups of only one image (no LLM call)', async () => {
    const client = makeClient('{"links":[]}');
    const images = [makeResult({ number: 1, category: 'kitchen', timestamp: 0 })];
    await linkImages(images, client, 7, 1, 0);
    expect(client.complete).not.toHaveBeenCalled();
  });

  it('calls LLM for groups with 2+ images in same window', async () => {
    const client = makeClient('{"links":[]}');
    const images = [
      makeResult({ number: 1, category: 'kitchen', timestamp: 0 }),
      makeResult({ number: 2, category: 'kitchen', timestamp: DAY_MS }),
    ];
    await linkImages(images, client, 7, 1, 0);
    expect(client.complete).toHaveBeenCalledOnce();
  });

  it('populates relatedImages bidirectionally for a link', async () => {
    const responseText = JSON.stringify({
      links: [{ imageA: 1, imageB: 2, relation: 'same_location' }],
    });
    const client = makeClient(responseText);
    const images = [
      makeResult({ number: 1, category: 'bathroom', timestamp: 0 }),
      makeResult({ number: 2, category: 'bathroom', timestamp: DAY_MS }),
    ];
    const result = await linkImages(images, client, 7, 1, 0);

    expect(result.get(1)).toEqual([{ number: 2, relation: 'same_location' }]);
    expect(result.get(2)).toEqual([{ number: 1, relation: 'same_location' }]);
  });

  it('splits into separate time windows', async () => {
    const client = makeClient('{"links":[]}');
    const images = [
      makeResult({ number: 1, category: 'kitchen', timestamp: 0 }),
      makeResult({ number: 2, category: 'kitchen', timestamp: DAY_MS }),
      // Gap of 10 days — starts a new window
      makeResult({ number: 3, category: 'kitchen', timestamp: 10 * DAY_MS }),
      makeResult({ number: 4, category: 'kitchen', timestamp: 11 * DAY_MS }),
    ];
    await linkImages(images, client, 7, 1, 0);
    // Two windows, each with 2 images → 2 LLM calls
    expect(client.complete).toHaveBeenCalledTimes(2);
  });

  it('skips images with unknown category', async () => {
    const client = makeClient('{"links":[]}');
    const images = [
      makeResult({ number: 1, category: 'unknown', timestamp: 0 }),
      makeResult({ number: 2, category: 'unknown', timestamp: DAY_MS }),
    ];
    await linkImages(images, client, 7, 1, 0);
    expect(client.complete).not.toHaveBeenCalled();
  });

  it('handles malformed LLM response gracefully without throwing', async () => {
    const client = makeClient('NOT JSON');
    const images = [
      makeResult({ number: 1, category: 'bathroom', timestamp: 0 }),
      makeResult({ number: 2, category: 'bathroom', timestamp: DAY_MS }),
    ];
    await expect(linkImages(images, client, 7, 1, 0)).resolves.toBeDefined();
    // Both images have empty relations
    const result = await linkImages(images, client, 7, 1, 0);
    expect(result.get(1)).toEqual([]);
    expect(result.get(2)).toEqual([]);
  });
});
