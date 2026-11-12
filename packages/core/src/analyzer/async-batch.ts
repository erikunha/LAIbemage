import sharp from 'sharp';
import { z } from 'zod';
import type { Config } from '../config/index.js';
import type { AnalysisResult, AsyncJobState, FileWithStats } from '../types.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/retry.js';
import { sanitizeTextField } from '../utils/sanitize.js';
import { buildSystemPrompt, buildUserPrompt, normalizeCategory } from './batch.js';
import type { AsyncBatchClient, AsyncBatchRequest } from './client.js';

const IMAGE_RESIZE_PX = 768;
const POLL_INTERVAL_MS = 30_000;
const BatchEnvelopeSchema = z.object({ images: z.array(z.unknown()) });

function parseNullableString(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'null' || trimmed.toLowerCase() === 'n/a') {
    return null;
  }
  return sanitizeTextField(trimmed, 500);
}

function parseResult(raw: unknown): AnalysisResult {
  const obj = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const category =
    typeof obj['category'] === 'string' && obj['category'].trim() ? obj['category'].trim() : '';
  const shortDescription =
    typeof obj['shortDescription'] === 'string' && obj['shortDescription'].trim()
      ? obj['shortDescription'].trim()
      : 'unanalyzed image';
  const fullDescription =
    typeof obj['fullDescription'] === 'string' ? obj['fullDescription'].trim() : '';
  const elements = Array.isArray(obj['elements']) ? (obj['elements'] as unknown[]) : [];
  const confidence =
    typeof obj['confidence'] === 'number' &&
    isFinite(obj['confidence']) &&
    obj['confidence'] >= 0 &&
    obj['confidence'] <= 1
      ? obj['confidence']
      : 0;

  return {
    category,
    shortDescription: sanitizeTextField(shortDescription, 200),
    fullDescription: sanitizeTextField(fullDescription, 250),
    elements: elements
      .filter((e): e is string => typeof e === 'string')
      .map((e) => sanitizeTextField(e, 100)),
    confidence,
    extractedText: parseNullableString(obj['extractedText']),
  };
}

const UNKNOWN_RESULT: AnalysisResult = {
  category: 'unknown',
  shortDescription: 'unanalyzed image',
  fullDescription: '',
  elements: [],
  confidence: 0,
  extractedText: null,
};

/**
 * Submit all images as a single async batch job.
 * Builds the same request payloads as `analyzeBatch` but submits to the provider's
 * async batch API instead of executing synchronously.
 */
export async function submitAsyncBatch(
  filesWithStats: FileWithStats[],
  config: Config,
  asyncClient: AsyncBatchClient,
): Promise<AsyncJobState> {
  const { batchSize } = config;
  const systemPrompt = buildSystemPrompt(config);
  const totalBatches = Math.ceil(filesWithStats.length / batchSize);
  const batchRequests: AsyncBatchRequest[] = [];

  logger.info(
    `\n Encoding ${filesWithStats.length} image(s) for async submission (${totalBatches} batch group(s))...`,
  );

  for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
    const start = batchIdx * batchSize;
    const chunk = filesWithStats.slice(start, start + batchSize);
    const startIndex = start + 1;

    const images = [];
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
      images.push({
        base64: resizedBuffer.toString('base64'),
        label: `--- Image ${startIndex + i} (${item.file}) ---`,
      });
    }

    batchRequests.push({
      customId: `batch-${batchIdx}`,
      prompt: buildUserPrompt(chunk.length, startIndex),
      images,
      opts: { maxTokens: 4000, detail: 'low', systemPrompt },
    });
  }

  const { jobId, customIds } = await asyncClient.submitBatch(batchRequests);

  const state: AsyncJobState = {
    jobId,
    provider: config.provider as 'openai' | 'anthropic' | 'azure',
    model: config.model,
    submittedAt: new Date().toISOString(),
    status: 'submitted',
    outputDir: config.outputDir,
    imageCount: filesWithStats.length,
    batchSize,
    customIds,
    fileOrder: filesWithStats.map((f) => f.file),
  };

  return state;
}

/**
 * Poll an existing async batch job until complete, then retrieve and parse results.
 * Logs progress every 5 poll attempts.
 */
export async function resumeAsyncBatch(
  state: AsyncJobState,
  asyncClient: AsyncBatchClient,
): Promise<AnalysisResult[]> {
  logger.info(
    `\n Resuming async job: ${state.jobId}\n` +
      `  Provider  : ${state.provider}\n` +
      `  Submitted : ${state.submittedAt}\n` +
      `  Images    : ${state.imageCount}`,
  );

  let pollAttempts = 0;
  let status = await asyncClient.checkStatus(state.jobId);

  while (status === 'pending') {
    pollAttempts++;
    if (pollAttempts === 1 || pollAttempts % 5 === 0) {
      logger.info(`  Batch in progress — polling (attempt ${pollAttempts})...`);
    }
    await sleep(POLL_INTERVAL_MS);
    status = await asyncClient.checkStatus(state.jobId);
  }

  if (status === 'failed') {
    throw new Error(`Async batch job failed: ${state.jobId}`);
  }

  logger.info(`  Batch complete. Retrieving results...`);
  const batchResults = await asyncClient.retrieveResults(state.jobId, state.customIds);
  const resultsMap = new Map(batchResults.map((r) => [r.customId, r]));

  const allResults: AnalysisResult[] = [];

  for (let batchIdx = 0; batchIdx < state.customIds.length; batchIdx++) {
    const customId = `batch-${batchIdx}`;
    const batchResult = resultsMap.get(customId);
    const start = batchIdx * state.batchSize;
    const chunkSize = Math.min(state.batchSize, state.imageCount - start);

    let rawImages: unknown[] = [];
    if (batchResult?.status === 'success') {
      try {
        const envelope = BatchEnvelopeSchema.safeParse(JSON.parse(batchResult.text));
        if (envelope.success) rawImages = envelope.data.images;
      } catch {
        logger.warn(`  Batch group ${batchIdx}: could not parse response — padding with unknown`);
      }
    } else {
      logger.warn(`  Batch group ${batchIdx}: failed — padding with unknown`);
    }

    if (rawImages.length !== chunkSize) {
      logger.warn(
        `  Batch group ${batchIdx}: expected ${chunkSize} results, got ${rawImages.length} — padding`,
      );
    }

    for (let i = 0; i < chunkSize; i++) {
      const r = parseResult(rawImages[i] ?? {});
      allResults.push({ ...r, category: normalizeCategory(r.category) });
    }
  }

  // Pad any shortfall with unknowns
  while (allResults.length < state.imageCount) {
    allResults.push({ ...UNKNOWN_RESULT });
  }

  return allResults.slice(0, state.imageCount);
}
