import path from 'node:path';
import type { AnalysisCache } from '../../types.js';
import type { Reporter } from '../port.js';
import { writeXlsx } from '../xlsx.js';

export const xlsxReporter: Reporter = {
  format: 'xlsx',
  async write(cache: AnalysisCache, outputDir: string): Promise<void> {
    const xlsxFile = path.join(outputDir, 'analysis_results.xlsx');
    await writeXlsx(cache.images, xlsxFile);
  },
};
