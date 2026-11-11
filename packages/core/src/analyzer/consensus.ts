import type { AnalyzedImage, FileWithStats } from '../types.js';
import type { Config, LLMProvider } from '../config/index.js';
import { analyzeImages } from './index.js';

export interface ConsensusResult {
  readonly images: AnalyzedImage[];
  /** Filenames of images where the two providers disagreed on the category. */
  readonly lowConsensusFiles: Set<string>;
}

/**
 * Progress callback of a consensus run. The provider that served the batch is
 * passed along, so a run served by two providers is priced with the rate of
 * each provider instead of a single one.
 */
export type ConsensusProgress = (
  processed: number,
  batch: number,
  tokensUsed: number,
  inputTokens: number,
  outputTokens: number,
  provider?: LLMProvider,
) => void;

const VALID_PROVIDERS = new Set<string>([
  'openai',
  'anthropic',
  'google',
  'azure',
  'ollama',
  'bedrock',
  'vertex',
]);

/** Wrap a progress callback so every event carries the provider that served it. */
function withProviderOf(
  provider: LLMProvider,
  onProgress?: ConsensusProgress,
): ConsensusProgress {
  return (processed, batch, tokensUsed, inputTokens, outputTokens) => {
    onProgress?.(processed, batch, tokensUsed, inputTokens, outputTokens, provider);
  };
}

/**
 * Runs two independent LLM analysis passes (one per provider in `providers`)
 * and merges the results by majority vote. When the two providers disagree on
 * a category, the image is flagged in `lowConsensusFiles` and the higher-
 * confidence result wins.
 */
export async function runConsensus(
  files: FileWithStats[],
  config: Config,
  providers: string[],
  onProgress?: ConsensusProgress,
): Promise<ConsensusResult> {
  const valid = providers.filter((p) => VALID_PROVIDERS.has(p));
  if (valid.length < 2) {
    const { images } = await analyzeImages(files, config, withProviderOf(config.provider, onProgress));
    return { images, lowConsensusFiles: new Set() };
  }

  const [p1, p2] = valid as [string, string];
  const config1: Config = { ...config, provider: p1 as LLMProvider };
  const config2: Config = { ...config, provider: p2 as LLMProvider };

  // Each pass reports with its own provider, so the caller can price it.
  const withProvider = (provider: LLMProvider): ConsensusProgress =>
    (processed, batch, tokensUsed, inputTokens, outputTokens) => {
      onProgress?.(processed, batch, tokensUsed, inputTokens, outputTokens, provider);
    };

  const [{ images: r1 }, { images: r2 }] = await Promise.all([
    analyzeImages(files, config1, withProvider(p1 as LLMProvider)),
    analyzeImages(files, config2, withProvider(p2 as LLMProvider)),
  ]);

  const lowConsensusFiles = new Set<string>();
  const merged: AnalyzedImage[] = r1.map((img, i) => {
    const other = r2[i];
    if (!other) return img;
    if (img.analysis.category === other.analysis.category) return img;
    lowConsensusFiles.add(img.file);
    // Winner = higher confidence
    return img.analysis.confidence >= other.analysis.confidence ? img : other;
  });

  return { images: merged, lowConsensusFiles };
}
