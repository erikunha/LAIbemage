import { readdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import type { CategoryConfig, Config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import type { LLMClient } from './client.js';

const IMAGE_REGEX = /\.(jpe?g|png|webp|tiff?|avif)$/i;
const IMAGE_RESIZE_PX = 512;

const SuggestResponseSchema = z.object({
  description: z.string().optional(),
  categories: z
    .array(
      z.object({
        name: z.string().regex(/^[a-z][a-z0-9_]*$/, 'category names must be lowercase_snake_case'),
        description: z.string().min(1),
        examples: z.array(z.string()).optional(),
      }),
    )
    .min(2)
    .max(20),
  pinnedLast: z.array(z.string()).default([]),
  immune: z.array(z.string()).default([]),
  overridable: z.array(z.string()).default([]),
  timezone: z.string().default('UTC'),
});

const SUGGEST_SYSTEM_PROMPT = `You are an expert image taxonomy designer.

You will see sample images from a dataset. Design a domain-appropriate category taxonomy for classifying ALL images in this dataset.

Rules:
- Use lowercase_snake_case for all category names (e.g. "living_room", "bank_transfer")
- Suggest 5-12 categories that cover the domain comprehensively
- Be specific enough to be useful, general enough to apply across the full dataset
- pinnedLast: administrative or meta categories (receipts, documents, screenshots) — sorted last in output
- immune: categories that must never be overridden by temporal cluster voting
- overridable: ambiguous categories that benefit from majority-vote correction (typically includes "unknown")

Respond ONLY with valid JSON — no markdown, no prose:
{
  "description": "One sentence describing this image domain",
  "categories": [
    { "name": "category_name", "description": "What belongs here", "examples": ["example1", "example2"] }
  ],
  "pinnedLast": [],
  "immune": [],
  "overridable": ["unknown"],
  "timezone": "UTC"
}`;

function buildSuggestUserPrompt(count: number): string {
  return `I am showing you ${count} sample image${count === 1 ? '' : 's'} from a dataset. Study them carefully and design a taxonomy that would classify ALL images in this dataset — not just the samples shown.`;
}

/**
 * Sample images from inputDir, send to the LLM, and return a suggested CategoryConfig.
 * The returned config can be written directly to a categories.json file.
 */
export async function suggestCategories(
  inputDir: string,
  sampleSize: number,
  client: LLMClient,
  config: Config,
): Promise<CategoryConfig> {
  const allFiles = await readdir(inputDir);
  const imageFiles = allFiles.filter((f) => IMAGE_REGEX.test(f));

  if (imageFiles.length === 0) {
    throw new Error(`[error] No images found in ${inputDir}`);
  }

  // Shuffle for representativeness, then cap at sampleSize
  const shuffled = [...imageFiles].sort(() => Math.random() - 0.5);
  const sample = shuffled.slice(0, Math.min(sampleSize, imageFiles.length));

  logger.info(`\n Sampling ${sample.length} of ${imageFiles.length} image(s) from ${inputDir}...`);

  const images: Array<{ base64: string; label: string }> = [];
  for (let i = 0; i < sample.length; i++) {
    const file = sample[i]!;
    const fullPath = path.join(inputDir, file);
    const buf = await sharp(fullPath)
      .resize({
        width: IMAGE_RESIZE_PX,
        height: IMAGE_RESIZE_PX,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 80 })
      .toBuffer();
    images.push({ base64: buf.toString('base64'), label: `Image ${i + 1}: ${file}` });
    logger.verbose(`  Encoded: ${file}`);
  }

  logger.info(`\n Asking ${config.provider} to suggest a category taxonomy...`);

  const result = await withRetry(
    () =>
      client.complete(buildSuggestUserPrompt(sample.length), images, {
        maxTokens: 2000,
        detail: 'low',
        systemPrompt: SUGGEST_SYSTEM_PROMPT,
      }),
    { maxAttempts: config.maxRetries, delayMs: config.retryDelayMs, label: 'suggest-categories' },
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.text);
  } catch {
    throw new Error(
      `[error] LLM returned invalid JSON. Try a different model or run again.\n` +
        `Received: ${result.text.slice(0, 300)}`,
    );
  }

  const validated = SuggestResponseSchema.safeParse(parsed);
  if (!validated.success) {
    const issues = validated.error.issues
      .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(
      `[error] LLM suggestion did not match expected schema:\n${issues}\n\n` +
        `Received: ${result.text.slice(0, 500)}`,
    );
  }

  const data = validated.data;
  const defined = new Set(data.categories.map((c) => c.name));

  // Silently drop any list entries that reference undefined categories
  for (const [field, values] of [
    ['pinnedLast', data.pinnedLast],
    ['immune', data.immune],
    ['overridable', data.overridable],
  ] as const) {
    for (const name of values) {
      if (!defined.has(name) && name !== 'unknown') {
        logger.warn(`  suggest: "${name}" in ${field} is not a defined category — removed.`);
      }
    }
  }

  return {
    description: data.description,
    categories: data.categories,
    pinnedLast: data.pinnedLast.filter((n) => defined.has(n) || n === 'unknown'),
    immune: data.immune.filter((n) => defined.has(n) || n === 'unknown'),
    overridable: data.overridable.filter((n) => defined.has(n) || n === 'unknown'),
    timezone: data.timezone,
  };
}
