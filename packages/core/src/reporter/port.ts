import type { AnalysisCache } from '../types.js';

export interface Reporter {
  readonly format: string;
  write(cache: AnalysisCache, outputDir: string): Promise<void>;
}
