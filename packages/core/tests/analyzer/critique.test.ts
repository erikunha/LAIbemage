import { describe, expect, it, vi } from 'vitest';
import { runSelfCritique } from '../../src/analyzer/critique.js';
import type { LLMClient } from '../../src/analyzer/client.js';
import type { AnalyzedImage } from '../../src/types.js';

function makeImage(overrides: Partial<AnalyzedImage> = {}): AnalyzedImage {
  return {
    file: 'IMG_001.jpeg',
    fullPath: '/input/IMG_001.jpeg',
    createdAt: 1705312800000,
    exifSource: 'ctime',
    analysis: {
      category: 'kitchen',
      shortDescription: 'clean kitchen',
      elements: ['sink'],
      confidence: 0.9,
      extractedText: null,
    },
    ...overrides,
  };
}

function makeClient(responses: string[]): LLMClient {
  const fns = responses.map((r) =>
    vi.fn().mockResolvedValueOnce({ text: r, tokensUsed: 10, inputTokens: 8, outputTokens: 2 }),
  );
  let callIdx = 0;
  return {
    complete: vi.fn((...args) => {
      const fn = fns[callIdx] ?? fns[fns.length - 1]!;
      callIdx++;
      return fn(...args);
    }),
  };
}

describe('runSelfCritique', () => {
  it('does nothing when images array is empty', async () => {
    const client = makeClient(['{"flags":[]}']);
    await runSelfCritique([], client, 1, 0);
    expect(client.complete).not.toHaveBeenCalled();
  });

  it('makes no reanalysis calls when no flags returned', async () => {
    const client = makeClient(['{"flags":[]}']);
    const images = [makeImage()];
    await runSelfCritique(images, client, 1, 0);
    // Only the critique pass — no reclassify calls
    expect(client.complete).toHaveBeenCalledOnce();
  });

  it('calls complete twice: once for critique, once for flagged reclassify', async () => {
    const client = makeClient([
      JSON.stringify({ flags: [{ imageNumber: 1, reason: 'low confidence' }] }),
      JSON.stringify({ category: 'bathroom', shortDescription: 'white tiles', elements: [] }),
    ]);
    const images = [makeImage()];
    await runSelfCritique(images, client, 1, 0);
    expect(client.complete).toHaveBeenCalledTimes(2);
  });

  it('updates the category of a flagged image (returns new array)', async () => {
    const client = makeClient([
      JSON.stringify({ flags: [{ imageNumber: 1, reason: 'wrong category' }] }),
      JSON.stringify({ category: 'living_room', shortDescription: 'spacious room', elements: [] }),
    ]);
    const images = [makeImage({ analysis: { ...makeImage().analysis, category: 'kitchen' } })];
    const result = await runSelfCritique(images, client, 1, 0);
    expect(result[0]?.analysis.category).toBe('living_room');
    // original array is not mutated
    expect(images[0]?.analysis.category).toBe('kitchen');
  });

  it('ignores out-of-bounds image numbers gracefully', async () => {
    const client = makeClient([
      JSON.stringify({ flags: [{ imageNumber: 99, reason: 'ghost image' }] }),
    ]);
    const images = [makeImage()];
    const result = await runSelfCritique(images, client, 1, 0);
    // returns the original array unchanged when no valid flags applied
    expect(result).toHaveLength(1);
    expect(result[0]?.analysis.category).toBe('kitchen');
  });

  it('handles malformed critique response without throwing', async () => {
    const client = makeClient(['NOT VALID JSON']);
    const images = [makeImage()];
    const result = await runSelfCritique(images, client, 1, 0);
    expect(result).toHaveLength(1);
    expect(result[0]?.analysis.category).toBe('kitchen');
  });
});
