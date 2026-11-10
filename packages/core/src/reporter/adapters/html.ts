import { writeFile } from 'node:fs/promises';
import type { AnalysisCache } from '../../types.js';
import { generateHtmlReport } from '../html.js';
import type { Reporter } from '../port.js';

export function createHtmlReporter(outPath: string): Reporter {
  return {
    format: 'html',
    async write(cache: AnalysisCache, outputDir: string): Promise<void> {
      const html = await generateHtmlReport(cache, outputDir);
      await writeFile(outPath, html, 'utf8');
    },
  };
}
