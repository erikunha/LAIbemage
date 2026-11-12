/**
 * H9.3 / H9.4 — Semantic search and keyword fallback search.
 *
 * Semantic search: embed the query, rank by cosine similarity against the stored index.
 * Keyword search: scan shortDescription, elements, extractedText for the keyword.
 *
 * This module does NOT import LLM SDKs directly — it calls generateEmbeddings from
 * src/analyzer/embeddings.ts (which is the only file allowed to import SDKs for embeddings).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '../config/index.js';
import type { AnalysisCache, ProcessedResult } from '../types.js';
import { generateEmbeddings } from '../analyzer/embeddings.js';
import { defaultIndexPath, loadIndex, rankResults } from './index.js';

export interface SearchResult {
  readonly number: number;
  readonly file: string;
  readonly outputFile: string;
  readonly category: string;
  /** Cosine similarity (0–1) for semantic mode; match-field count for keyword mode. */
  readonly score: number;
  readonly shortDescription: string;
  readonly fullDescription?: string;
}

/**
 * Semantic search: embed query text and rank all indexed images by cosine similarity.
 *
 * Requires:
 *   - analysis_results.json in outputDir
 *   - analysis_embeddings.index.json in outputDir (created by --embed)
 *
 * @throws if analysis_results.json is missing.
 * @throws if analysis_embeddings.index.json is missing or invalid.
 */
export async function searchSemantic(
  query: string,
  outputDir: string,
  config: Config,
  opts: { topK: number; minScore: number },
): Promise<SearchResult[]> {
  // Load the processed results for metadata join
  const cachePath = join(outputDir, 'analysis_results.json');
  let cacheRaw: string;
  try {
    cacheRaw = await readFile(cachePath, 'utf-8');
  } catch {
    throw new Error(`analysis_results.json not found in ${outputDir}. Run analysis first.`);
  }
  const cache = JSON.parse(cacheRaw) as AnalysisCache;
  const imageMap = new Map<number, ProcessedResult>(cache.images.map((img) => [img.number, img]));

  // Load the embedding index
  const indexPath = defaultIndexPath(outputDir);
  const entries = await loadIndex(indexPath);
  if (!entries) {
    throw new Error(
      `analysis_embeddings.index.json not found or invalid in ${outputDir}. Run with --embed first.`,
    );
  }

  // Embed the query text — we create a synthetic ProcessedResult with the query as description
  const queryResult: ProcessedResult = {
    number: 0,
    originalFile: '__query__',
    outputFile: '__query__',
    category: 'query',
    shortDescription: query,
    elements: [],
    confidence: 0,
    extractedText: null,
    timestamp: 0,
  };
  const [queryEmbedding] = await generateEmbeddings([queryResult], config);
  if (!queryEmbedding) {
    throw new Error('[search] Failed to generate query embedding.');
  }

  const ranked = rankResults(queryEmbedding.vector, entries, opts.topK, opts.minScore);

  return ranked.map((r) => {
    const img = imageMap.get(r.number);
    return {
      number: r.number,
      file: img?.originalFile ?? r.file,
      outputFile: img?.outputFile ?? r.file,
      category: img?.category ?? 'unknown',
      score: r.score,
      shortDescription: img?.shortDescription ?? '',
      ...(img?.fullDescription ? { fullDescription: img.fullDescription } : {}),
    };
  });
}

/**
 * Keyword search: scan each image's text fields for the keyword (case-insensitive).
 * Ranks by the number of fields that contain the keyword (descending).
 *
 * Fields scanned: shortDescription, elements (each element), extractedText.
 *
 * @param keyword - The search term (case-insensitive).
 * @param images  - All ProcessedResult records from analysis_results.json.
 * @param opts.topK - Maximum number of results to return.
 */
export function searchKeyword(
  keyword: string,
  images: ProcessedResult[],
  opts: { topK: number },
): SearchResult[] {
  const needle = keyword.toLowerCase();

  const scored = images
    .map((img) => {
      let score = 0;
      if (img.shortDescription.toLowerCase().includes(needle)) score++;
      if (img.fullDescription && img.fullDescription.toLowerCase().includes(needle)) score++;
      for (const el of img.elements) {
        if (el.toLowerCase().includes(needle)) {
          score++;
          break; // count each image's elements as a single match
        }
      }
      if (img.extractedText && img.extractedText.toLowerCase().includes(needle)) score++;
      return { img, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.topK);

  return scored.map(({ img, score }) => ({
    number: img.number,
    file: img.originalFile,
    outputFile: img.outputFile,
    category: img.category,
    score,
    shortDescription: img.shortDescription,
    ...(img.fullDescription ? { fullDescription: img.fullDescription } : {}),
  }));
}
