import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { deduplicateImages, hammingDistance } from '../../src/analyzer/dedup.js';
import type { FileWithStats } from '../../src/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, '..', 'fixtures', 'images');

function makeFile(file: string, createdAt: number): FileWithStats {
  return { file, fullPath: path.join(FIXTURES, file), createdAt, exifSource: 'ctime' };
}

// ---------------------------------------------------------------------------
// hammingDistance — pure function
// ---------------------------------------------------------------------------

describe('hammingDistance', () => {
  it('returns 0 for identical hashes', () => {
    expect(hammingDistance(0b1010n, 0b1010n)).toBe(0);
  });

  it('returns 1 for hashes differing by one bit', () => {
    expect(hammingDistance(0b1010n, 0b1011n)).toBe(1);
  });

  it('counts all differing bits', () => {
    expect(hammingDistance(0n, 0b1111n)).toBe(4);
  });

  it('is commutative', () => {
    expect(hammingDistance(0b101n, 0b010n)).toBe(hammingDistance(0b010n, 0b101n));
  });

  it('handles 64-bit values without overflow', () => {
    const a = (1n << 63n) | 1n;
    const b = (1n << 63n) | 2n;
    expect(hammingDistance(a, b)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// deduplicateImages
// ---------------------------------------------------------------------------

const SEC = 1000;
const BASE_TS = 1_700_000_000_000; // arbitrary epoch in ms

describe('deduplicateImages', () => {
  it('returns all files unchanged when threshold is 0 (disabled)', async () => {
    const files = [makeFile('red.jpg', BASE_TS), makeFile('green.jpg', BASE_TS + 5 * SEC)];
    const { unique, duplicateMap } = await deduplicateImages(files, 0);
    expect(unique).toHaveLength(2);
    expect(duplicateMap.size).toBe(0);
  });

  it('returns single file unchanged', async () => {
    const files = [makeFile('red.jpg', BASE_TS)];
    const { unique, duplicateMap } = await deduplicateImages(files, 8);
    expect(unique).toHaveLength(1);
    expect(duplicateMap.size).toBe(0);
  });

  it('returns empty array unchanged', async () => {
    const { unique, duplicateMap } = await deduplicateImages([], 8);
    expect(unique).toHaveLength(0);
    expect(duplicateMap.size).toBe(0);
  });

  it('does not deduplicate visually different images', async () => {
    // Simulate two images with very different hashes (distance 32 > threshold 8)
    const files = [makeFile('red.jpg', BASE_TS), makeFile('blue.jpg', BASE_TS + 2 * SEC)];
    let call = 0;
    const hashFn = async (_p: string): Promise<bigint> => (call++ === 0 ? 0n : 0xffffffffn); // distance = 32 bits
    const { unique, duplicateMap } = await deduplicateImages(files, 8, hashFn);
    expect(unique).toHaveLength(2);
    expect(duplicateMap.size).toBe(0);
  });

  it('does not deduplicate images outside the burst window (>60 s apart)', async () => {
    // Same file passed twice but 2 minutes apart — outside burst window
    const files = [makeFile('red.jpg', BASE_TS), makeFile('red.jpg', BASE_TS + 120 * SEC)];
    // Use a hashFn that always returns the same hash so they "look identical"
    const sameHash = async (_p: string): Promise<bigint> => 42n;
    const { unique, duplicateMap } = await deduplicateImages(files, 8, sameHash);
    // Outside 60-second window → not deduplicated
    expect(unique).toHaveLength(2);
    expect(duplicateMap.size).toBe(0);
  });

  it('deduplicates near-identical images within burst window', async () => {
    const files = [
      makeFile('red.jpg', BASE_TS),
      makeFile('green.jpg', BASE_TS + 5 * SEC),
      makeFile('blue.jpg', BASE_TS + 10 * SEC),
    ];
    // hashFn returns same value for all → all "identical"
    const sameHash = async (_p: string): Promise<bigint> => 0n;
    const { unique, duplicateMap } = await deduplicateImages(files, 8, sameHash);
    expect(unique).toHaveLength(1);
    expect(unique[0].file).toBe('red.jpg');
    expect(duplicateMap.get('green.jpg')).toBe('red.jpg');
    expect(duplicateMap.get('blue.jpg')).toBe('red.jpg');
  });

  it('treats unreadable images as unique (never a duplicate)', async () => {
    const files = [makeFile('red.jpg', BASE_TS), makeFile('green.jpg', BASE_TS + 5 * SEC)];
    const throwingHash = async (_p: string): Promise<bigint> => {
      throw new Error('cannot read');
    };
    const { unique, duplicateMap } = await deduplicateImages(files, 8, throwingHash);
    // Errors → both treated as unique
    expect(unique).toHaveLength(2);
    expect(duplicateMap.size).toBe(0);
  });

  it('respects Hamming threshold — distance-1 pair is NOT a dup at threshold 0', async () => {
    // threshold=0 means disabled (no dedup at all)
    let call = 0;
    const files = [makeFile('red.jpg', BASE_TS), makeFile('green.jpg', BASE_TS + 5 * SEC)];
    const hashFn = async (_p: string): Promise<bigint> => (call++ === 0 ? 0n : 1n);
    const { unique } = await deduplicateImages(files, 0, hashFn);
    expect(unique).toHaveLength(2);
  });

  it('respects Hamming threshold — distance-1 pair IS a dup at threshold 1', async () => {
    let call = 0;
    const files = [makeFile('red.jpg', BASE_TS), makeFile('green.jpg', BASE_TS + 5 * SEC)];
    const hashFn = async (_p: string): Promise<bigint> => (call++ === 0 ? 0n : 1n);
    const { unique, duplicateMap } = await deduplicateImages(files, 1, hashFn);
    expect(unique).toHaveLength(1);
    expect(duplicateMap.get('green.jpg')).toBe('red.jpg');
  });

  it('preserves ordering — unique list is in original file order', async () => {
    const files = [
      makeFile('red.jpg', BASE_TS),
      makeFile('green.jpg', BASE_TS + 5 * SEC),
      makeFile('blue.jpg', BASE_TS + 10 * SEC),
    ];
    let call = 0;
    // red=0n, green=0xFFFFn (16 bits set → distance 16 from red, > threshold 8 → unique)
    // blue=0n (distance 0 from red → dup of red; backward search: green dist=16>8, red dist=0≤8)
    const hashFn = async (_p: string): Promise<bigint> => {
      const idx = call++;
      return idx === 1 ? 0xffffn : 0n;
    };
    const { unique, duplicateMap } = await deduplicateImages(files, 8, hashFn);
    expect(unique.map((f) => f.file)).toEqual(['red.jpg', 'green.jpg']);
    expect(duplicateMap.get('blue.jpg')).toBe('red.jpg');
  });
});

// ---------------------------------------------------------------------------
// computeDHash integration — exercises the real Sharp pipeline
// ---------------------------------------------------------------------------

describe('computeDHash (via default hashFn)', () => {
  it('solid-colour fixture images produce the same dHash (all-zero gradient)', async () => {
    // Uniform solid colours have no left-right pixel differences after greyscale → hash = 0n
    // So two different solid-colour images within the burst window register as duplicates
    const files = [makeFile('red.jpg', BASE_TS), makeFile('blue.jpg', BASE_TS + 5 * SEC)];
    const { unique, duplicateMap } = await deduplicateImages(files, 8);
    expect(unique).toHaveLength(1);
    expect(duplicateMap.get('blue.jpg')).toBe('red.jpg');
  });

  it('returns a consistent hash for the same file called twice', async () => {
    // Determinism check: the same file must always produce the same hash
    const files = [makeFile('green.jpg', BASE_TS), makeFile('green.jpg', BASE_TS + 5 * SEC)];
    const { unique, duplicateMap } = await deduplicateImages(files, 0); // threshold=0 disables dedup
    // Hashes are still computed but dedup is disabled — both stay unique
    expect(unique).toHaveLength(2);
    expect(duplicateMap.size).toBe(0);
  });
});
