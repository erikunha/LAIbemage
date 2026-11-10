import { z } from 'zod';
import type { AnalyzedImage } from '../types.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import { sanitizeTextField } from '../utils/sanitize.js';
import { normalizeCategory } from './batch.js';
import type { LLMClient } from './client.js';

const CritiqueFlagSchema = z.object({
  imageNumber: z.number().int(),
  reason: z.string(),
});

const CritiqueResponseSchema = z.object({
  flags: z.array(CritiqueFlagSchema),
});

const RECLASSIFY_SCHEMA = z.object({
  category: z.string().optional(),
  shortDescription: z.string().optional(),
  elements: z.array(z.string()).optional(),
});

function buildCritiquePrompt(images: readonly AnalyzedImage[]): string {
  const summaries = images
    .map((img, i) => {
      const date = new Date(img.createdAt).toISOString().slice(0, 10);
      return `Image ${i + 1} (${img.file}, ${date}): category="${img.analysis.category}", confidence=${img.analysis.confidence.toFixed(2)}, desc="${img.analysis.shortDescription}"`;
    })
    .join('\n');

  return (
    `You are reviewing a sequence of classified images.\n\n` +
    `Images:\n${summaries}\n\n` +
    `Flag any images that are:\n` +
    `1. Inconsistent with their immediate neighbors in the sequence\n` +
    `2. Contradicted by their timestamp proximity to differently-classified images\n` +
    `3. Assigned with low confidence (below 0.6)\n\n` +
    `Return a JSON object: { "flags": [{ "imageNumber": 1, "reason": "..." }] }\n` +
    `Use the sequential 1-based imageNumber from the list above.\n` +
    `Return {"flags":[]} if no images need reconsidering.\n` +
    `Respond ONLY with valid JSON.`
  );
}

/**
 * Self-critique pass: sends the full classified sequence to the LLM, which flags
 * suspicious or low-confidence classifications for targeted reanalysis.
 * Returns a new array with any reclassified images replaced (immutable).
 */
export async function runSelfCritique(
  analyzedImages: AnalyzedImage[],
  client: LLMClient,
  maxAttempts: number,
  retryDelayMs: number,
): Promise<AnalyzedImage[]> {
  if (analyzedImages.length === 0) return analyzedImages;

  logger.info(`\n Running self-critique pass on ${analyzedImages.length} image(s)...`);

  const prompt = buildCritiquePrompt(analyzedImages);
  let flags: z.infer<typeof CritiqueFlagSchema>[];

  try {
    const result = await withRetry(() => client.complete(prompt, [], { maxTokens: 2000 }), {
      maxAttempts,
      delayMs: retryDelayMs,
      label: 'self-critique',
    });
    const parsed = CritiqueResponseSchema.safeParse(JSON.parse(result.text));
    if (!parsed.success) {
      logger.warn(`  Self-critique: unexpected response shape — skipping reanalysis`);
      return analyzedImages;
    }
    flags = parsed.data.flags;
  } catch (err) {
    logger.warn(`  Self-critique: failed — ${String(err)}`);
    return analyzedImages;
  }

  if (flags.length === 0) {
    logger.info(`  Self-critique: no issues flagged.`);
    return analyzedImages;
  }

  logger.info(`  Self-critique: ${flags.length} image(s) flagged for reanalysis.`);

  // Build a mutable copy of overrides (index → new analysis fields)
  const overrides = new Map<
    number,
    Partial<{ category: string; shortDescription: string; elements: string[] }>
  >();

  for (const flag of flags) {
    const idx = flag.imageNumber - 1;
    const img = analyzedImages[idx];
    if (!img) continue;

    logger.verbose(`  Reconsidering: ${img.file} — ${flag.reason}`);

    const reclassifyPrompt =
      `A previous classification of this image was flagged as potentially incorrect.\n` +
      `Reason: ${flag.reason}\n\n` +
      `Original classification: category="${img.analysis.category}", description="${img.analysis.shortDescription}"\n\n` +
      `Look at the image carefully and classify it. If the original is correct, return the same category.\n` +
      `Respond ONLY with JSON: { "category": "name", "shortDescription": "...", "elements": [] }`;

    try {
      const result = await withRetry(
        () => client.complete(reclassifyPrompt, [], { maxTokens: 500 }),
        { maxAttempts, delayMs: retryDelayMs, label: `critique-reclassify:${img.file}` },
      );
      const parsed = RECLASSIFY_SCHEMA.safeParse(JSON.parse(result.text));
      if (!parsed.success) continue;
      const { category, shortDescription, elements } = parsed.data;
      const newCategory = normalizeCategory(category ?? '');
      const patch: Partial<{ category: string; shortDescription: string; elements: string[] }> = {};
      if (newCategory && newCategory !== 'unknown') {
        patch.category = newCategory;
      }
      if (shortDescription) {
        patch.shortDescription = sanitizeTextField(shortDescription, 200);
      }
      if (elements) {
        patch.elements = elements.map((e) => sanitizeTextField(e, 100));
      }
      if (Object.keys(patch).length > 0) {
        overrides.set(idx, patch);
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.startsWith('QUOTA_EXCEEDED')) throw err;
      logger.warn(`  Critique reanalysis failed for ${img.file}: ${msg}`);
    }
  }

  // Build new array with overridden images replaced immutably
  return analyzedImages.map((img, i) => {
    const patch = overrides.get(i);
    if (!patch) return img;
    return { ...img, analysis: { ...img.analysis, ...patch } };
  });
}
