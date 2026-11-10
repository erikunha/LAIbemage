import { describe, expect, it } from 'vitest';
import { diffCaches } from '../../src/diff/index.js';
import type { AnalysisCache, ProcessedResult } from '../../src/types.js';

function makeResult(overrides: Partial<ProcessedResult> = {}): ProcessedResult {
  return {
    originalFile: 'img1.jpg',
    outputFile: '1. img1.jpg',
    category: 'kitchen',
    number: 1,
    shortDescription: 'a kitchen',
    elements: [],
    confidence: 0.9,
    extractedText: null,
    timestamp: 0,
    ...overrides,
  };
}

function makeCache(images: ProcessedResult[]): AnalysisCache {
  return {
    schemaVersion: 1,
    processedDate: '2024-01-01T00:00:00Z',
    totalImages: images.length,
    categories: [...new Set(images.map((i) => i.category))],
    categoriesHash: 'abc123',
    images,
  };
}

describe('diffCaches', () => {
  it('returns all zeros for two identical caches', () => {
    const r = makeResult();
    const cache = makeCache([r]);
    const summary = diffCaches(cache, cache);
    expect(summary.added).toBe(0);
    expect(summary.removed).toBe(0);
    expect(summary.categoryChanged).toBe(0);
    expect(summary.confidenceChanged).toBe(0);
    expect(summary.unchanged).toBe(1);
  });

  it('detects added images', () => {
    const before = makeCache([makeResult({ originalFile: 'a.jpg', number: 1 })]);
    const after = makeCache([
      makeResult({ originalFile: 'a.jpg', number: 1 }),
      makeResult({ originalFile: 'b.jpg', number: 2 }),
    ]);
    const summary = diffCaches(before, after);
    expect(summary.added).toBe(1);
    expect(summary.removed).toBe(0);
    const added = summary.diffs.find((d) => d.change === 'added');
    expect(added?.file).toBe('b.jpg');
    expect(added?.before).toBeUndefined();
    expect(added?.after?.category).toBe('kitchen');
  });

  it('detects removed images', () => {
    const before = makeCache([
      makeResult({ originalFile: 'a.jpg', number: 1 }),
      makeResult({ originalFile: 'b.jpg', number: 2 }),
    ]);
    const after = makeCache([makeResult({ originalFile: 'a.jpg', number: 1 })]);
    const summary = diffCaches(before, after);
    expect(summary.removed).toBe(1);
    const removed = summary.diffs.find((d) => d.change === 'removed');
    expect(removed?.file).toBe('b.jpg');
    expect(removed?.after).toBeUndefined();
    expect(removed?.before?.category).toBe('kitchen');
  });

  it('detects category changes', () => {
    const before = makeCache([makeResult({ originalFile: 'a.jpg', category: 'kitchen' })]);
    const after = makeCache([makeResult({ originalFile: 'a.jpg', category: 'bedroom' })]);
    const summary = diffCaches(before, after);
    expect(summary.categoryChanged).toBe(1);
    const d = summary.diffs.find((x) => x.change === 'category_changed');
    expect(d?.before?.category).toBe('kitchen');
    expect(d?.after?.category).toBe('bedroom');
  });

  it('detects confidence changes above 0.05 delta', () => {
    const before = makeCache([makeResult({ originalFile: 'a.jpg', confidence: 0.9 })]);
    const after = makeCache([makeResult({ originalFile: 'a.jpg', confidence: 0.8 })]);
    const summary = diffCaches(before, after);
    expect(summary.confidenceChanged).toBe(1);
    const d = summary.diffs.find((x) => x.change === 'confidence_changed');
    expect(d?.confidenceDelta).toBeCloseTo(-0.1);
  });

  it('treats confidence delta <= 0.05 as unchanged', () => {
    const before = makeCache([makeResult({ originalFile: 'a.jpg', confidence: 0.9 })]);
    const after = makeCache([makeResult({ originalFile: 'a.jpg', confidence: 0.93 })]);
    const summary = diffCaches(before, after);
    expect(summary.unchanged).toBe(1);
    expect(summary.confidenceChanged).toBe(0);
  });

  it('handles empty caches', () => {
    const summary = diffCaches(makeCache([]), makeCache([]));
    expect(summary.added).toBe(0);
    expect(summary.removed).toBe(0);
    expect(summary.unchanged).toBe(0);
    expect(summary.diffs).toHaveLength(0);
  });

  it('counts confidenceDelta correctly for positive change', () => {
    const before = makeCache([makeResult({ originalFile: 'a.jpg', confidence: 0.5 })]);
    const after = makeCache([makeResult({ originalFile: 'a.jpg', confidence: 0.9 })]);
    const summary = diffCaches(before, after);
    expect(summary.confidenceChanged).toBe(1);
    const d = summary.diffs[0];
    expect(d?.confidenceDelta).toBeCloseTo(0.4);
  });
});
