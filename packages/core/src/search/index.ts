/**
 * H9.2 — Lightweight vector index.
 *
 * Pure TypeScript cosine-similarity search. No LLM SDKs, no Sharp, no fs-extra.
 * I/O uses node:fs/promises only. All writes are atomic (tmp+rename).
 *
 * Index stored as: analysis_embeddings.index.json
 */
import { rename, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EmbeddingEntry } from '../analyzer/embeddings.js';

export type { EmbeddingEntry };

export interface RankedResult {
  readonly number: number;
  readonly file: string;
  readonly score: number;
}

interface IndexFile {
  schemaVersion: number;
  generatedAt: string;
  /** Embedding model used to generate vectors — required to detect provider switches. */
  embeddingModel: string;
  /** Vector dimensions — required to detect model/provider switches. */
  dimensions: number;
  entries: EmbeddingEntry[];
}

const INDEX_SCHEMA_VERSION = 2;
const INDEX_FILE_NAME = 'analysis_embeddings.index.json';

/**
 * Compute cosine similarity between two equal-length vectors.
 * Returns a value in [-1, 1]. Returns 0 if either vector has zero magnitude.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += (a[i] as number) * (b[i] as number);
    magA += (a[i] as number) * (a[i] as number);
    magB += (b[i] as number) * (b[i] as number);
  }

  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  if (denom === 0) return 0;
  return dot / denom;
}

/**
 * Rank embedding entries by cosine similarity to a query vector.
 *
 * @param queryVector  - Embedding of the search query.
 * @param entries      - All index entries to rank.
 * @param topK         - Maximum number of results to return.
 * @param minScore     - Minimum similarity score to include (0–1).
 * @returns Descending-sorted array of RankedResult (length ≤ topK).
 */
export function rankResults(
  queryVector: number[],
  entries: EmbeddingEntry[],
  topK: number,
  minScore: number,
): RankedResult[] {
  const scored = entries
    .map((entry) => ({
      number: entry.number,
      file: entry.file,
      score: cosineSimilarity(queryVector, entry.vector),
    }))
    .filter((r) => r.score >= minScore)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, topK);
}

/**
 * Persist an array of EmbeddingEntry objects to an index file.
 * Write is atomic: writes to a `.tmp` file then renames.
 * Stores embeddingModel and dimensions so loadIndex can detect provider switches.
 */
export async function buildIndex(
  entries: EmbeddingEntry[],
  indexPath: string,
  embeddingModel: string,
  dimensions: number,
): Promise<void> {
  const indexData: IndexFile = {
    schemaVersion: INDEX_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    embeddingModel,
    dimensions,
    entries,
  };
  const json = JSON.stringify(indexData, null, 2) + '\n';
  const tmpPath = `${indexPath}.tmp`;
  await writeFile(tmpPath, json, 'utf-8');
  await rename(tmpPath, indexPath);
}

/**
 * Load the embedding index from disk.
 * Returns null if the file does not exist, has an unrecognised schema version,
 * or if the stored model/dimensions don't match the expected values.
 * A null return means the caller must re-generate embeddings before searching.
 */
export async function loadIndex(
  indexPath: string,
  expectedModel?: string,
  expectedDimensions?: number,
): Promise<EmbeddingEntry[] | null> {
  let raw: string;
  try {
    raw = await readFile(indexPath, 'utf-8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const data = parsed as Partial<IndexFile>;
  if (data.schemaVersion !== INDEX_SCHEMA_VERSION || !Array.isArray(data.entries)) {
    return null;
  }

  if (expectedModel !== undefined && data.embeddingModel !== expectedModel) {
    return null;
  }

  if (expectedDimensions !== undefined && data.dimensions !== expectedDimensions) {
    return null;
  }

  return data.entries;
}

/**
 * Returns the default index file path for a given output directory.
 */
export function defaultIndexPath(outputDir: string): string {
  return join(outputDir, INDEX_FILE_NAME);
}
