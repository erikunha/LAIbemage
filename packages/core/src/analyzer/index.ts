import fs from 'fs-extra';
import sharp from 'sharp';
import { z } from 'zod';
import type { Config } from '../config/index.js';
import type { AnalysisResult, AnalyzedImage, FileWithStats } from '../types.js';
import { logger } from '../utils/logger.js';
import { sleep, withRetry } from '../utils/retry.js';
import { sanitizeTextField } from '../utils/sanitize.js';
import { analyzeBatch, normalizeCategory } from './batch.js';
import { createLLMClient, type LLMClient } from './client.js';
import { runSelfCritique } from './critique.js';
import { runHybridBatch } from './router.js';
import { applyTemporalConsensus } from './temporal.js';

const ReclassifyResponseSchema = z.object({
  category: z.string().optional(),
  shortDescription: z.string().optional(),
  elements: z.array(z.string()).optional(),
});

const RECLASSIFY_PROMPT = `You are an expert image analyst.

A previous analysis could NOT classify this image. Look more carefully with fresh eyes.

Classify by category type. If you truly cannot determine the type, return "unknown".

Respond ONLY with this JSON:
{
  "category": "category_name",
  "shortDescription": "3-8 word description",
  "elements": ["element1", "element2"]
}`;

async function reclassifyUnknowns(
  analyzedImages: AnalyzedImage[],
  config: Config,
  client: LLMClient,
): Promise<AnalyzedImage[]> {
  const unknownIndices = analyzedImages
    .map((img, i) => (img.analysis.category === 'unknown' ? i : -1))
    .filter((i) => i >= 0);

  if (unknownIndices.length === 0) return analyzedImages;

  logger.info(
    `\n Re-classifying ${unknownIndices.length} unknown image(s) with a second pass (higher detail)...`,
  );

  // Build patch map: index → new analysis fields
  const patches = new Map<
    number,
    Partial<{ category: string; shortDescription: string; elements: string[] }>
  >();

  for (const idx of unknownIndices) {
    const img = analyzedImages[idx]!;
    try {
      logger.verbose(`  Re-analyzing: ${img.file}`);

      const imageBuffer = await fs.readFile(img.fullPath);
      const resized = await sharp(imageBuffer)
        .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();

      const result = await withRetry(
        () =>
          client.complete(
            RECLASSIFY_PROMPT,
            [{ base64: resized.toString('base64'), label: img.file }],
            { maxTokens: 500, detail: 'high' },
          ),
        {
          maxAttempts: config.maxRetries,
          delayMs: config.retryDelayMs,
          label: `reclassify:${img.file}`,
        },
      );

      // 1.7 — validate shape before accessing fields; log raw text on mismatch
      const envelope = ReclassifyResponseSchema.safeParse(JSON.parse(result.text));
      if (!envelope.success) {
        logger.warn(
          `  Reclassify: unexpected response shape for ${img.file}.\n  Received: ${result.text.slice(0, 200)}`,
        );
        await sleep(config.delayBetweenCallsMs);
        continue;
      }

      const parsed = envelope.data;
      const newCategory = normalizeCategory(parsed.category ?? '');

      if (newCategory !== 'unknown') {
        logger.success(
          `  Reclassified: ${img.file} → ${newCategory} | "${parsed.shortDescription ?? ''}"`,
        );
        patches.set(idx, {
          category: newCategory,
          shortDescription: parsed.shortDescription
            ? sanitizeTextField(parsed.shortDescription, 200)
            : img.analysis.shortDescription,
          elements: parsed.elements
            ? parsed.elements.map((e) => sanitizeTextField(e, 100))
            : [...img.analysis.elements],
        });
      } else {
        logger.verbose(`  Still unknown after second pass: ${img.file}`);
      }

      await sleep(config.delayBetweenCallsMs);
    } catch (error) {
      const msg = (error as Error).message;
      if (msg.startsWith('QUOTA_EXCEEDED')) throw error;
      logger.error(`  Reclassify error for ${img.file}: ${msg}`);
    }
  }

  // Return new array with reclassified images replaced immutably
  if (patches.size === 0) return analyzedImages;
  return analyzedImages.map((img, i) => {
    const patch = patches.get(i);
    if (!patch) return img;
    return { ...img, analysis: { ...img.analysis, ...patch } };
  });
}

export async function analyzeImages(
  filesWithStats: FileWithStats[],
  config: Config,
  onProgress?: (
    processed: number,
    batch: number,
    tokensUsed: number,
    inputTokens: number,
    outputTokens: number,
  ) => void,
  onBatchComplete?: (processedCount: number, results: AnalysisResult[]) => Promise<void>,
  feedbackNote = '',
): Promise<{ images: AnalyzedImage[]; overrideCount: number }> {
  // First pass: batch analysis (hybrid uses two-tier local + cloud)
  const llmClient = createLLMClient(config);
  const batchResults =
    config.provider === 'hybrid'
      ? await runHybridBatch(
          filesWithStats,
          config,
          llmClient,
          onProgress,
          onBatchComplete,
          feedbackNote,
        )
      : await analyzeBatch(
          filesWithStats,
          config,
          llmClient,
          onProgress,
          onBatchComplete,
          feedbackNote,
        );

  let analyzedImages: AnalyzedImage[] = filesWithStats.map((f, i) => ({
    ...f,
    analysis: batchResults[i] ?? {
      category: 'unknown',
      shortDescription: 'unanalyzed image',
      elements: [],
      confidence: 0,
      extractedText: null,
    },
  }));

  // Second pass: re-analyze unknowns with higher detail (2.12 — skipped on --dry-run)
  if (!config.dryRun) {
    analyzedImages = await reclassifyUnknowns(analyzedImages, config, llmClient);
  } else {
    logger.info('\n [dry-run] Skipping reclassify pass.');
  }

  // Third pass: temporal consensus
  logger.info('\n Applying temporal consensus...');
  const preTemporalImages = analyzedImages;
  analyzedImages = applyTemporalConsensus(analyzedImages, {
    temporalWindowMinutes: config.temporalWindowMinutes,
    consensusThreshold: config.consensusThreshold,
    categoryConfig: config.categoryConfig,
  });
  const overrideCount = analyzedImages.filter(
    (img, i) => img.analysis.category !== (preTemporalImages[i]?.analysis.category ?? ''),
  ).length;

  // Fourth pass: self-critique (optional, --self-critique flag)
  if (config.selfCritique && !config.dryRun) {
    analyzedImages = await runSelfCritique(
      analyzedImages,
      llmClient,
      config.maxRetries,
      config.retryDelayMs,
    );
  }

  return { images: analyzedImages, overrideCount };
}
