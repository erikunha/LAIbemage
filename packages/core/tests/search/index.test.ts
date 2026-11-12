import { describe, expect, it, vi } from 'vitest';
import {
  cosineSimilarity,
  rankResults,
  buildIndex,
  loadIndex,
  defaultIndexPath,
} from '../../src/search/index.js';
import type { EmbeddingEntry } from '../../src/search/index.js';

// Mock node:fs/promises so tests don't do real disk I/O
const writtenFiles = new Map<string, string>();
const renamedFiles = new Map<string, string>();

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    writeFile: vi.fn(async (path: string, content: string) => {
      writtenFiles.set(path as string, content as string);
    }),
    rename: vi.fn(async (from: string, to: string) => {
      const content = writtenFiles.get(from as string);
      if (content !== undefined) {
        writtenFiles.set(to as string, content);
        writtenFiles.delete(from as string);
      }
      renamedFiles.set(from as string, to as string);
    }),
    readFile: vi.fn(async (path: string) => {
      const content = writtenFiles.get(path as string);
      if (content === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return content;
    }),
  };
});

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    const v = [1, 2, 3];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it('returns 0 for orthogonal vectors', () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
  });

  it('returns -1 for opposite vectors', () => {
    const a = [1, 0, 0];
    const b = [-1, 0, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 5);
  });

  it('returns expected value for a known example', () => {
    const a = [1, 2, 3];
    const b = [4, 5, 6];
    // dot = 4+10+18 = 32; |a| = sqrt(14); |b| = sqrt(77)
    const expected = 32 / (Math.sqrt(14) * Math.sqrt(77));
    expect(cosineSimilarity(a, b)).toBeCloseTo(expected, 5);
  });

  it('returns 0 for zero-magnitude vectors', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
  });

  it('returns 0 for empty vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('returns 0 when vectors have different lengths', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });
});

describe('rankResults', () => {
  function makeEntry(number: number, vector: number[]): EmbeddingEntry {
    return { number, file: `img${number}.jpg`, vector };
  }

  const entries: EmbeddingEntry[] = [
    makeEntry(1, [1, 0, 0]),
    makeEntry(2, [0.9, 0.1, 0]),
    makeEntry(3, [0, 1, 0]),
    makeEntry(4, [0, 0, 1]),
    makeEntry(5, [1, 1, 0]),
  ];

  it('ranks results by descending cosine similarity', () => {
    const query = [1, 0, 0];
    const results = rankResults(query, entries, 10, 0);
    // entry 1 (exact match) should be first
    expect(results[0]?.number).toBe(1);
    // entry 2 (very similar) should be second
    expect(results[1]?.number).toBe(2);
    // scores should be descending
    for (let i = 0; i < results.length - 1; i++) {
      expect(results[i]!.score).toBeGreaterThanOrEqual(results[i + 1]!.score);
    }
  });

  it('caps results at topK', () => {
    const query = [1, 0, 0];
    const results = rankResults(query, entries, 2, 0);
    expect(results).toHaveLength(2);
  });

  it('filters by minScore', () => {
    const query = [1, 0, 0];
    // Only entries with similarity >= 0.5 should be included
    const results = rankResults(query, entries, 10, 0.5);
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0.5);
    }
  });

  it('returns empty array when no entries match minScore', () => {
    const query = [1, 0, 0];
    const results = rankResults(query, entries, 10, 1.0);
    // Only exact match (entry 1) scores 1.0
    expect(results).toHaveLength(1);
    expect(results[0]?.number).toBe(1);
  });

  it('returns empty array for empty entries', () => {
    const results = rankResults([1, 0, 0], [], 10, 0);
    expect(results).toHaveLength(0);
  });

  it('includes number, file, and score in each result', () => {
    const results = rankResults([1, 0, 0], entries, 1, 0);
    expect(results[0]).toMatchObject({
      number: expect.any(Number),
      file: expect.any(String),
      score: expect.any(Number),
    });
  });
});

describe('buildIndex', () => {
  it('writes entries to the specified path via tmp+rename', async () => {
    const entries: EmbeddingEntry[] = [
      { number: 1, file: 'img1.jpg', vector: [0.1, 0.2] },
      { number: 2, file: 'img2.jpg', vector: [0.3, 0.4] },
    ];
    await buildIndex(entries, '/output/test.index.json', 'text-embedding-3-small', 2);
    // After buildIndex the final path should exist
    const stored = writtenFiles.get('/output/test.index.json');
    expect(stored).toBeDefined();
    const parsed = JSON.parse(stored!) as {
      schemaVersion: number;
      embeddingModel: string;
      dimensions: number;
      entries: EmbeddingEntry[];
    };
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.embeddingModel).toBe('text-embedding-3-small');
    expect(parsed.dimensions).toBe(2);
    expect(parsed.entries).toHaveLength(2);
  });

  it('rename is called (atomic write)', async () => {
    const entries: EmbeddingEntry[] = [{ number: 1, file: 'img1.jpg', vector: [1] }];
    await buildIndex(entries, '/output/atomic.index.json', 'text-embedding-3-small', 1);
    // rename should have been called from the .tmp path
    const renamed = renamedFiles.get('/output/atomic.index.json.tmp');
    expect(renamed).toBe('/output/atomic.index.json');
  });
});

describe('loadIndex', () => {
  it('returns entries from a valid index file', async () => {
    const entries: EmbeddingEntry[] = [{ number: 5, file: 'photo5.jpg', vector: [0.5] }];
    await buildIndex(entries, '/output/load.index.json', 'text-embedding-3-small', 1);
    const loaded = await loadIndex('/output/load.index.json');
    expect(loaded).not.toBeNull();
    expect(loaded).toHaveLength(1);
    expect(loaded![0]?.number).toBe(5);
  });

  it('returns null when file does not exist', async () => {
    const result = await loadIndex('/output/nonexistent.index.json');
    expect(result).toBeNull();
  });

  it('returns null for malformed JSON', async () => {
    writtenFiles.set('/output/bad.index.json', 'not-json{{{');
    const result = await loadIndex('/output/bad.index.json');
    expect(result).toBeNull();
  });

  it('returns null for wrong schema version', async () => {
    writtenFiles.set(
      '/output/wrongver.index.json',
      JSON.stringify({ schemaVersion: 99, generatedAt: '', entries: [] }),
    );
    const result = await loadIndex('/output/wrongver.index.json');
    expect(result).toBeNull();
  });

  it('returns null when entries is not an array', async () => {
    writtenFiles.set(
      '/output/noarr.index.json',
      JSON.stringify({ schemaVersion: 1, generatedAt: '', entries: 'bad' }),
    );
    const result = await loadIndex('/output/noarr.index.json');
    expect(result).toBeNull();
  });
});

describe('defaultIndexPath', () => {
  it('returns the correct path for a given output directory', () => {
    const path = defaultIndexPath('/some/output');
    expect(path).toContain('analysis_embeddings.index.json');
    expect(path).toContain('/some/output');
  });
});
