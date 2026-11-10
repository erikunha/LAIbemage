import { access, rename } from 'node:fs/promises';
import path from 'node:path';
import type { ProcessedResult } from '../types.js';
import { logger } from '../utils/logger.js';
import { buildOutputName } from './exporter.js';

/** Returns true if the file exists on disk. */
async function fileExists(filePath: string): Promise<boolean> {
  return access(filePath).then(
    () => true,
    () => false,
  );
}

/**
 * Reorders output files in `outputDir` to a clean 1-based sequence.
 *
 * Uses a two-phase rename strategy to avoid collisions when a new name
 * for one image equals the current name of another (e.g. after manual
 * JSON edits or category changes).
 *
 * Returns a new array of ProcessedResult with updated `outputFile` and `number`
 * for each successfully renamed file. Files missing from disk are skipped with a warning.
 */
export async function reorderImages(
  outputDir: string,
  images: ProcessedResult[],
  timezone: string,
): Promise<ProcessedResult[]> {
  // Phase 1: move every existing output file to a temp name.
  // This prevents collisions when building the final sequence in phase 2.
  for (const img of images) {
    const src = path.join(outputDir, img.outputFile);
    const tmp = path.join(outputDir, `__tmp__${img.outputFile}`);
    if (await fileExists(src)) {
      await rename(src, tmp);
    }
  }

  // Phase 2: rename temp files to final sequential names.
  let seq = 1;
  const result: ProcessedResult[] = [];
  for (const img of images) {
    const tmp = path.join(outputDir, `__tmp__${img.outputFile}`);
    const newName = buildOutputName(seq, img.category, img.timestamp, timezone);
    const dst = path.join(outputDir, newName);

    if (await fileExists(tmp)) {
      await rename(tmp, dst);
      result.push({ ...img, outputFile: newName, number: seq });
    } else {
      logger.warn(`  Missing temp file for ${img.originalFile}, skipping`);
      result.push(img);
    }
    seq++;
  }

  return result;
}
