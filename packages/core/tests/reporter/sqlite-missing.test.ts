import { describe, expect, it, vi } from 'vitest';
import type { AnalysisCache } from '../../src/types.js';

// H16.3: better-sqlite3 is an optionalDependency of @vision-lens/core —
// simulate a machine where it is NOT installed. The mock factory throws on
// any import of the module, so the guarded dynamic import inside writeSqlite
// rejects and the guard must surface the actionable install hint instead of
// a raw MODULE_NOT_FOUND stack.
vi.mock('better-sqlite3', () => {
  throw new Error("Cannot find package 'better-sqlite3' (mocked absence)");
});

function makeEmptyCache(): AnalysisCache {
  return {
    schemaVersion: 1,
    processedDate: '2024-01-15T10:00:00.000Z',
    totalImages: 0,
    categories: [],
    categoriesHash: 'abc123',
    images: [],
  };
}

describe('writeSqlite missing better-sqlite3 guard (H16.3)', () => {
  it('throws an actionable error when better-sqlite3 is absent', async () => {
    const { writeSqlite } = await import('../../src/reporter/sqlite.js');

    await expect(writeSqlite(makeEmptyCache(), '/nowhere/test.db')).rejects.toThrow(
      /better-sqlite3 is not installed[\s\S]*pnpm add better-sqlite3/,
    );
  });

  it('does not create the output file when the guard trips', async () => {
    const { writeSqlite } = await import('../../src/reporter/sqlite.js');

    // The guard fires before `new Database(outPath)` — even though the path
    // is invalid, the rejection must be the guard's message, not an ENOENT.
    await expect(
      writeSqlite(makeEmptyCache(), '/definitely/not/a/dir/test.db'),
    ).rejects.toThrow('better-sqlite3 is not installed');
  });
});
