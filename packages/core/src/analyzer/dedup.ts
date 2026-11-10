import sharp from 'sharp';
import type { FileWithStats } from '../types.js';

const HASH_SIZE = 8; // 8×8 difference grid → 64-bit hash
// Compare within 60 s — tight enough for burst sequences, avoids false positives across visits
const BURST_WINDOW_MS = 60_000;

async function computeDHash(filePath: string): Promise<bigint> {
  // Resize to (HASH_SIZE+1)×HASH_SIZE so each row has HASH_SIZE left-right pixel pairs
  const { data } = await sharp(filePath)
    .resize(HASH_SIZE + 1, HASH_SIZE, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let hash = 0n;
  const stride = HASH_SIZE + 1;
  for (let row = 0; row < HASH_SIZE; row++) {
    for (let col = 0; col < HASH_SIZE; col++) {
      const idx = row * stride + col;
      hash = (hash << 1n) | (data[idx]! < data[idx + 1]! ? 1n : 0n);
    }
  }
  return hash;
}

export function hammingDistance(a: bigint, b: bigint): number {
  let diff = a ^ b;
  let n = 0;
  while (diff > 0n) {
    n += Number(diff & 1n);
    diff >>= 1n;
  }
  return n;
}

export interface DedupeResult {
  unique: FileWithStats[];
  /** Maps duplicate file.file → its representative's file.file */
  duplicateMap: Map<string, string>;
}

/**
 * Identify near-identical images within burst windows before sending to the LLM.
 * Images are assumed to be sorted ascending by createdAt.
 * @param threshold Hamming distance threshold (0–64). 0 = disabled.
 * @param hashFn Injectable for tests; defaults to computeDHash.
 */
export async function deduplicateImages(
  filesWithStats: FileWithStats[],
  threshold: number,
  hashFn: (filePath: string) => Promise<bigint> = computeDHash,
): Promise<DedupeResult> {
  if (threshold === 0 || filesWithStats.length < 2) {
    return { unique: [...filesWithStats], duplicateMap: new Map() };
  }

  const hashes: Array<bigint | null> = [];
  for (const f of filesWithStats) {
    try {
      hashes.push(await hashFn(f.fullPath));
    } catch {
      hashes.push(null); // unreadable → treat as unique
    }
  }

  const unique: FileWithStats[] = [];
  const uniqueHashes: Array<bigint | null> = [];
  const uniqueTimestamps: number[] = [];
  const duplicateMap = new Map<string, string>();

  for (let i = 0; i < filesWithStats.length; i++) {
    const file = filesWithStats[i];
    const hash = hashes[i];

    if (hash === null) {
      unique.push(file);
      uniqueHashes.push(null);
      uniqueTimestamps.push(file.createdAt);
      continue;
    }

    // Compare against unique images within the burst window
    let repFile: string | null = null;
    for (let j = unique.length - 1; j >= 0; j--) {
      if (file.createdAt - uniqueTimestamps[j] > BURST_WINDOW_MS) break;
      const repHash = uniqueHashes[j];
      if (repHash !== null && hammingDistance(hash, repHash) <= threshold) {
        repFile = unique[j].file;
        break;
      }
    }

    if (repFile !== null) {
      duplicateMap.set(file.file, repFile);
    } else {
      unique.push(file);
      uniqueHashes.push(hash);
      uniqueTimestamps.push(file.createdAt);
    }
  }

  return { unique, duplicateMap };
}
