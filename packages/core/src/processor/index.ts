import type { Config } from '../config/index.js';
import type { AnalyzedImage } from '../types.js';
import { logger } from '../utils/logger.js';
import { buildOutputName, exportImage } from './exporter.js';

export interface ProcessImageResult {
  readonly outputName: string;
}

export async function processImage(
  img: AnalyzedImage,
  number: number,
  config: Config,
  keepOriginalBasename?: string,
): Promise<ProcessImageResult> {
  const { file, fullPath, createdAt, analysis } = img;
  const timezone = config.categoryConfig.timezone ?? 'UTC';
  const isDocCategory =
    analysis.category === 'payment_receipt' || analysis.category === 'conversation_screenshot';

  const outputName = buildOutputName(
    number,
    analysis.category,
    createdAt,
    timezone,
    keepOriginalBasename,
    config.filenameTemplate,
    analysis.shortDescription,
  );

  const outputPath = `${config.outputDir}/${outputName}`;

  await exportImage({
    inputPath: fullPath,
    outputPath,
    timestampMs: createdAt,
    skipOverlay: isDocCategory,
    timezone,
    dryRun: config.dryRun,
  });

  const tag = isDocCategory ? ' [no overlay]' : '';
  logger.success(`  ${file} → ${outputName}${tag}`);

  return { outputName };
}
