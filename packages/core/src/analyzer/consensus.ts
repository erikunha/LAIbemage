import type { AnalyzedImage, FileWithStats } from '../types.js';
import type { Config, LLMProvider } from '../config/index.js';
import { analyzeImages } from './index.js';

export interface ConsensusResult {
  readonly images: AnalyzedImage[];
  /** Filenames of images where the two providers disagreed on the category. */
  readonly lowConsensusFiles: Set<string>;
}

const VALID_PROVIDERS = new Set<string>([
  'openai',
  'anthropic',
  'google',
  'azure',
  'ollama',
  'bedrock',
  'vertex',
]);

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
): Promise<ConsensusResult> {
  const valid = providers.filter((p) => VALID_PROVIDERS.has(p));
  if (valid.length < 2) {
    const { images } = await analyzeImages(files, config);
    return { images, lowConsensusFiles: new Set() };
  }

  const [p1, p2] = valid as [string, string];
  const config1: Config = { ...config, provider: p1 as LLMProvider };
  const config2: Config = { ...config, provider: p2 as LLMProvider };

  const [{ images: r1 }, { images: r2 }] = await Promise.all([
    analyzeImages(files, config1),
    analyzeImages(files, config2),
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
