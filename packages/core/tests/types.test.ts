import { describe, expect, it } from 'vitest';
import type { PartialAnalysisCache } from '../src/types.js';

// H16.1: every PartialAnalysisCache field must be readonly. The assertions
// below are compile-time only — the assignments live in a function that is
// never invoked, so nothing mutates at runtime. If a field loses `readonly`,
// tsc reports "Unused '@ts-expect-error' directive" and `pnpm typecheck`
// fails (enforced through packages/core/tests/tsconfig.json).
describe('PartialAnalysisCache (H16.1 readonly)', () => {
  it('rejects mutation of every field at type level', () => {
    const mutate = (cache: PartialAnalysisCache): void => {
      // @ts-expect-error schemaVersion is readonly
      cache.schemaVersion = 2;
      // @ts-expect-error startedAt is readonly
      cache.startedAt = '2025-01-01T00:00:00.000Z';
      // @ts-expect-error categoriesHash is readonly
      cache.categoriesHash = 'def456';
      // @ts-expect-error images is readonly
      cache.images = [];
    };
    void mutate;

    const cache: PartialAnalysisCache = {
      schemaVersion: 1,
      startedAt: '2024-01-15T10:00:00.000Z',
      categoriesHash: 'abc123',
      images: [],
    };
    expect(cache.schemaVersion).toBe(1);
    expect(cache.startedAt).toBe('2024-01-15T10:00:00.000Z');
    expect(cache.categoriesHash).toBe('abc123');
    expect(cache.images).toHaveLength(0);
  });
});
