import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireWebhook } from '../../src/utils/webhook.js';
import type { AnalysisCache } from '../../src/types.js';

const makeCache = (): AnalysisCache => ({
  schemaVersion: 1,
  processedDate: '2026-01-01T00:00:00.000Z',
  totalImages: 1,
  categories: ['kitchen'],
  categoriesHash: 'abc123def456',
  images: [
    {
      originalFile: 'img.jpg',
      outputFile: '1. img.jpg',
      category: 'kitchen',
      number: 1,
      shortDescription: 'A clean kitchen',
      elements: ['sink'],
      confidence: 0.9,
      extractedText: null,
      timestamp: 1000000,
    },
  ],
});

describe('fireWebhook', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('logs verbose on a successful (2xx) response and does not throw', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
    });
    vi.stubGlobal('fetch', mockFetch);

    const cache = makeCache();
    await expect(fireWebhook('https://example.com/hook', cache)).resolves.toBeUndefined();

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch).toHaveBeenCalledWith('https://example.com/hook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cache),
    });
  });

  it('logs a warning on a non-OK response and does not throw', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });
    vi.stubGlobal('fetch', mockFetch);

    const cache = makeCache();
    await expect(fireWebhook('https://example.com/hook', cache)).resolves.toBeUndefined();

    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('logs a warning when fetch throws a network error and does not throw', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', mockFetch);

    const cache = makeCache();
    await expect(fireWebhook('https://example.com/hook', cache)).resolves.toBeUndefined();

    expect(mockFetch).toHaveBeenCalledOnce();
  });
});
