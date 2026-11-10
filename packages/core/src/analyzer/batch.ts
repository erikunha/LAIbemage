import pLimit from 'p-limit';
import sharp from 'sharp';
import { z } from 'zod';
import type { CategoryConfig, Config } from '../config/index.js';
import type { AnalysisResult, FileWithStats } from '../types.js';
import { logger } from '../utils/logger.js';
import { sleep, withRetry } from '../utils/retry.js';
import { sanitizeTextField } from '../utils/sanitize.js';
import type { ImageInput, LLMClient } from './client.js';

const BatchEnvelopeSchema = z.object({ images: z.array(z.unknown()) });

const IMAGE_RESIZE_PX = 768; // detail:low uses 512px — 768 adds no cost but improves crops

export function normalizeCategory(category: string): string {
  if (!category || !category.trim()) return 'unknown';
  const sanitized = category
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return sanitized || 'unknown';
}

function buildCategoriesBlock(categoryConfig: CategoryConfig): string {
  const lines = categoryConfig.categories.map((c) => {
    const pad = ' '.repeat(Math.max(1, 24 - c.name.length));
    return `- ${c.name}${pad}(${c.description})`;
  });
  lines.push('- You MAY create new lowercase_snake_case categories (e.g. "roof", "balcony")');
  lines.push('- Use "unknown" when the type cannot be determined with confidence');
  return lines.join('\n');
}

export function buildSystemPrompt(config: Config, feedbackNote = ''): string {
  return `You are an expert image analyst. Your task is to classify and describe images according to a user-defined taxonomy.

USE THE FULL SEQUENCE TO YOUR ADVANTAGE:
- A burst of similar shots taken in quick succession is almost certainly the same category
- If an image is ambiguous, use surrounding context from adjacent images to classify it

Available categories:
${buildCategoriesBlock(config.categoryConfig)}

Field guidance:
- shortDescription: 3-8 words, objective, factual description of what the image shows
- fullDescription: up to 250 characters describing everything visible — all objects, colors, spatial arrangement, lighting, textures, context and conditions. Be specific; this field powers keyword search
- elements: key visible elements or objects in the image
- confidence: your confidence in the classification 0.0–1.0
- extractedText: any readable text visible in the image (signs, labels, documents, screens). Empty string if none.${feedbackNote}`;
}

export function buildUserPrompt(count: number, startIndex: number): string {
  return `You will receive ${count} images in CHRONOLOGICAL ORDER (Image ${startIndex} to ${startIndex + count - 1}).

Respond with EXACTLY ${count} results in order:
{
  "images": [
    {
      "index": ${startIndex},
      "category": "category_name",
      "shortDescription": "3-8 word description",
      "fullDescription": "Detailed description up to 250 chars covering all visible objects, colors, spatial layout, lighting, and conditions.",
      "elements": ["element1"],
      "confidence": 0.9,
      "extractedText": ""
    },
    ...
  ]
}`;
}

export function buildBatchPrompt(config: Config, count: number, startIndex: number): string {
  return `${buildSystemPrompt(config)}\n\n${buildUserPrompt(count, startIndex)}`;
}

function parseNullableString(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'null' || trimmed.toLowerCase() === 'n/a') {
    return null;
  }
  return sanitizeTextField(trimmed, 500);
}

function parseAnalysisResult(raw: unknown): AnalysisResult {
  const obj = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const rawCategory =
    typeof obj['category'] === 'string' && obj['category'].trim() ? obj['category'].trim() : '';
  const rawDesc =
    typeof obj['shortDescription'] === 'string' && obj['shortDescription'].trim()
      ? obj['shortDescription'].trim()
      : 'unanalyzed image';
  const rawFull = typeof obj['fullDescription'] === 'string' ? obj['fullDescription'].trim() : '';
  const rawElements = Array.isArray(obj['elements']) ? (obj['elements'] as unknown[]) : [];
  const rawConfidence =
    typeof obj['confidence'] === 'number' &&
    isFinite(obj['confidence']) &&
    obj['confidence'] >= 0 &&
    obj['confidence'] <= 1
      ? obj['confidence']
      : 0;

  return {
    category: rawCategory,
    shortDescription: sanitizeTextField(rawDesc, 200),
    fullDescription: sanitizeTextField(rawFull, 250),
    elements: rawElements
      .filter((e): e is string => typeof e === 'string')
      .map((e) => sanitizeTextField(e, 100)),
    confidence: rawConfidence,
    extractedText: parseNullableString(obj['extractedText']),
  };
}

export async function analyzeBatch(
  filesWithStats: FileWithStats[],
  config: Config,
  client: LLMClient,
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
  const {
    batchSize,
    maxRetries: maxAttempts,
    retryDelayMs,
    delayBetweenCallsMs,
    concurrency,
  } = config;
  const totalBatches = Math.ceil(filesWithStats.length / batchSize);
  const systemPrompt = buildSystemPrompt(config, feedbackNote);

  // Pre-allocated results array keeps results in original batch order
  const orderedResults: Array<AnalysisResult[] | null> = new Array(totalBatches).fill(null);

  // Serialized flush chain: onBatchComplete is always invoked in ascending batch order
  let nextFlushBatch = 0;
  let flushChain = Promise.resolve();

  const limit = pLimit(concurrency);

  const batchTasks = Array.from({ length: totalBatches }, (_, batchIdx) =>
    limit(async () => {
      const start = batchIdx * batchSize;
      const chunk = filesWithStats.slice(start, start + batchSize);
      const startIndex = start + 1;
      const batchNumber = batchIdx + 1;

      logger.info(
        `\n Batch ${batchNumber}/${totalBatches}: images ${startIndex}–${startIndex + chunk.length - 1} (${chunk.length} images)`,
      );

      // Resize and encode images for the LLM
      const imageInputs: ImageInput[] = [];
      for (let i = 0; i < chunk.length; i++) {
        const item = chunk[i];
        const resizedBuffer = await sharp(item.fullPath)
          .resize({
            width: IMAGE_RESIZE_PX,
            height: IMAGE_RESIZE_PX,
            fit: 'inside',
            withoutEnlargement: true,
          })
          .jpeg({ quality: 80 })
          .toBuffer();
        imageInputs.push({
          base64: resizedBuffer.toString('base64'),
          label: `--- Image ${startIndex + i} (${item.file}) ---`,
        });
      }

      let batchResults: AnalysisResult[] = [];
      let tokensUsed = 0;
      let inputTokens = 0;
      let outputTokens = 0;

      try {
        const result = await withRetry(
          () =>
            client.complete(buildUserPrompt(chunk.length, startIndex), imageInputs, {
              maxTokens: 6000,
              detail: 'low',
              systemPrompt,
            }),
          { maxAttempts, delayMs: retryDelayMs, label: `batch ${batchNumber}` },
        );

        tokensUsed = result.tokensUsed;
        inputTokens = result.inputTokens;
        outputTokens = result.outputTokens;
        logger.verbose(
          `  Batch ${batchNumber} tokens: input=${inputTokens} output=${outputTokens} total=${tokensUsed}`,
        );
        // JSON.parse throws on invalid JSON → caught by outer catch and padded with unknown
        const envelope = BatchEnvelopeSchema.safeParse(JSON.parse(result.text));
        let rawImages: unknown[] = [];
        if (envelope.success) {
          rawImages = envelope.data.images;
        } else {
          logger.warn(
            `  Batch ${batchNumber}: LLM response missing expected "images" array — padding with unknown.\n` +
              `  Received: ${result.text.slice(0, 300)}`,
          );
        }

        if (rawImages.length !== chunk.length) {
          logger.warn(
            `  Expected ${chunk.length} results, got ${rawImages.length} — padding with unknown`,
          );
        }

        for (let i = 0; i < chunk.length; i++) {
          const r = parseAnalysisResult(rawImages[i] ?? {});
          const normalized = { ...r, category: normalizeCategory(r.category) };
          logger.verbose(
            `  [${startIndex + i}] ${chunk[i].file}: ${normalized.category} | "${normalized.shortDescription}"`,
          );
          batchResults.push(normalized);
        }
      } catch (error) {
        const msg = (error as Error).message;
        if (msg.startsWith('QUOTA_EXCEEDED')) throw error;
        logger.error(`  Batch ${batchNumber} failed: ${msg}`);
        batchResults = chunk.map(() => ({
          category: 'unknown',
          shortDescription: 'unanalyzed image',
          fullDescription: '',
          elements: [],
          confidence: 0,
          extractedText: null,
        }));
      }

      orderedResults[batchIdx] = batchResults;

      // Count completed batches for the progress callback
      const completedCount = orderedResults.filter((r) => r !== null).length;
      onProgress?.(
        Math.min(completedCount * batchSize, filesWithStats.length),
        batchNumber,
        tokensUsed,
        inputTokens,
        outputTokens,
      );

      // Append to the flush chain so onBatchComplete is called in strict batch order
      flushChain = flushChain.then(async () => {
        while (nextFlushBatch < totalBatches && orderedResults[nextFlushBatch] !== null) {
          const processedCount = Math.min((nextFlushBatch + 1) * batchSize, filesWithStats.length);
          const allSoFar = (
            orderedResults.slice(0, nextFlushBatch + 1) as AnalysisResult[][]
          ).flat();
          await onBatchComplete?.(processedCount, allSoFar);
          nextFlushBatch++;
        }
      });

      // Per-slot rate-limit delay: prevents a free slot from hammering the API
      if (delayBetweenCallsMs > 0) {
        await sleep(delayBetweenCallsMs);
      }
    }),
  );

  await Promise.all(batchTasks);
  await flushChain; // drain any pending ordered flushes

  return (orderedResults as AnalysisResult[][]).flat();
}
