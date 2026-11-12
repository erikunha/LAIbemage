import path from 'node:path';
import type { AnalysisCache } from '../../types.js';
import type { Reporter } from '../port.js';
import { writeSqlite } from '../sqlite.js';

export const sqliteReporter: Reporter = {
  format: 'sqlite',
  async write(cache: AnalysisCache, outputDir: string): Promise<void> {
    const dbFile = path.join(outputDir, 'analysis_results.db');
    await writeSqlite(cache, dbFile);
  },
};
