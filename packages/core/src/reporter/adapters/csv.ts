import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AnalysisCache } from '../../types.js';
import { buildCsvContent } from '../csv.js';
import type { Reporter } from '../port.js';

export const csvReporter: Reporter = {
  format: 'csv',
  async write(cache: AnalysisCache, outputDir: string): Promise<void> {
    const csvFile = path.join(outputDir, 'analysis_results.csv');
    await writeFile(csvFile, buildCsvContent(cache.images), 'utf8');
  },
};
