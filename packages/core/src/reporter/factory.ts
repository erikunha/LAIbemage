import type { Config } from '../config/index.js';
import { createHtmlReporter } from './adapters/html.js';
import { csvReporter } from './adapters/csv.js';
import { xlsxReporter } from './adapters/xlsx.js';
import { sqliteReporter } from './adapters/sqlite.js';
import type { Reporter } from './port.js';

export function buildReporters(config: Config, htmlOutPath?: string): Reporter[] {
  switch (config.outputFormat) {
    case 'csv':
      return [csvReporter];
    case 'xlsx':
      return [xlsxReporter];
    case 'sqlite':
      return [sqliteReporter];
    case 'none':
    case 'json':
    case 'pretty':
    default: {
      // If an htmlOutPath was explicitly provided (e.g. from the report subcommand),
      // return an HTML reporter regardless of outputFormat.
      if (htmlOutPath !== undefined) {
        return [createHtmlReporter(htmlOutPath)];
      }
      return [];
    }
  }
}
