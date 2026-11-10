import sharp from 'sharp';
import { z } from 'zod';
import type { Config } from '../config/index.js';
import type { AnalysisResult, FileWithStats } from '../types.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import { sanitizeTextField } from '../utils/sanitize.js';
import { analyzeBatch, buildSystemPrompt, normalizeCategory } from './batch.js';
import { createCloudClientForHybrid, type LLMClient } from './client.js';

const IMAGE_RESIZE_PX = 1024;

const SingleResultSchema = z.object({
  category: z.string().optional(),
  shortDescription: z.string().optional(),
  fullDescription: z.string().optional(),
  elements: z.array(z.string()).optional(),
  confidence: z.number().optional(),
  extractedText: z.string().optional().nullable(),
});

function parseNullableString(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'null' || trimmed.toLowerCase() === 'n/a') {
    return null;
  }
  return sanitizeTextField(trimmed, 500);
}

function parseSingleResult(raw: unknown): AnalysisResult {
  const parsed = SingleResultSchema.safeParse(raw);
  const obj = parsed.success ? parsed.data : {};
  const category = typeof obj.category === 'string' ? obj.category.trim() : '';
  return {
    category,
    shortDescription: sanitizeTextField(
      typeof obj.shortDescription === 'string' ? obj.shortDescription : 'unanalyzed image',
      200,
    ),
    fullDescription: sanitizeTextField(
      typeof obj.fullDescription === 'string' ? obj.fullDescription : '',
      250,
    ),
    elements: (obj.elements ?? []).map((e) => sanitizeTextField(e, 100)),
    confidence:
      typeof obj.confidence === 'number' && isFinite(obj.confidence) && obj.confidence >= 0
        ? obj.confidence
        : 0,
    extractedText: parseNullableString(obj.extractedText),
  };
}

/**
 * Two-tier hybrid analysis pipeline.
 * Tier 1: Run ALL images through the local Ollama model (fast, free).
 * Tier 2: Escalate images below `config.localConfidenceThreshold` to the cloud provider.
 */
export async function runHybridBatch(
  filesWithStats: FileWithStats[],
  config: Config,
  localClient: LLMClient,
  onProgress?: (
    processed: number,
    batch: number,
    tokensUsed: number,
    inputTokens: number,
    outputTokens: number,
  ) => void,
  onBatchComplete?: (processedCount: number, results: AnalysisResult[]) => Promise<void>,
  feedbackNote = '',
): Promise<AnalysisResult[]> {
  logger.info(
    `\n [hybrid] Tier-1: analyzing ${filesWithStats.length} image(s) via local Ollama (${config.localModel})...`,
  );

  const localResults = await analyzeBatch(
    filesWithStats,
    config,
    localClient,
    onProgress,
    onBatchComplete,
    feedbackNote,
  );

  const escalateIndices: number[] = [];
  for (let i = 0; i < localResults.length; i++) {
    const r = localResults[i]!;
    if (r.confidence < config.localConfidenceThreshold || r.category === 'unknown') {
      escalateIndices.push(i);
    }
  }

  if (escalateIndices.length === 0) {
    logger.info(`  [hybrid] All images above confidence threshold — no cloud escalation needed.`);
    return localResults;
  }

  logger.info(
    `  [hybrid] Tier-2: escalating ${escalateIndices.length} low-confidence image(s) to ${config.cloudProvider}...`,
  );

  const cloudClient = createCloudClientForHybrid(config);
  const systemPrompt = buildSystemPrompt(config, feedbackNote);

  for (const idx of escalateIndices) {
    const file = filesWithStats[idx];
    if (!file) continue;

    try {
      const resizedBuffer = await sharp(file.fullPath)
        .resize({
          width: IMAGE_RESIZE_PX,
          height: IMAGE_RESIZE_PX,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: 85 })
        .toBuffer();

      const prompt =
        `Analyze this single image carefully.\n\n` +
        `Respond ONLY with valid JSON:\n` +
        `{"category":"name","shortDescription":"3-8 words","elements":[],"confidence":0.9,"extractedText":""}`;

      const result = await withRetry(
        () =>
          cloudClient.complete(
            prompt,
            [{ base64: resizedBuffer.toString('base64'), label: file.file }],
            { maxTokens: 500, detail: 'high', systemPrompt },
          ),
        {
          maxAttempts: config.maxRetries,
          delayMs: config.retryDelayMs,
          label: `hybrid:${file.file}`,
        },
      );

      const parsed = parseSingleResult(JSON.parse(result.text));
      localResults[idx] = { ...parsed, category: normalizeCategory(parsed.category) };
      logger.verbose(
        `  [hybrid] Escalated: ${file.file} → ${parsed.category} (conf: ${parsed.confidence.toFixed(2)})`,
      );
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.startsWith('QUOTA_EXCEEDED')) throw err;
      logger.warn(`  [hybrid] Cloud escalation failed for ${file.file}: ${msg}`);
    }
  }

  return localResults;
}
