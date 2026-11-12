/**
 * Interactive review mode — shown between analysis and processing.
 * Requires a TTY (process.stdin.isTTY). Automatically disabled otherwise.
 */
import input from '@inquirer/input';
import select from '@inquirer/select';
import type { Config } from '../config/index.js';
import type { AnalyzedImage, ReviewOverride } from '../types.js';
import { logger } from '../utils/logger.js';

export interface ReviewResult {
  /** Images to pass on to classification and processing (excludes skipped). */
  readonly images: AnalyzedImage[];
  /** Category overrides made by the user. */
  readonly overrides: ReviewOverride[];
  /** Filenames of images the user chose to exclude. */
  readonly skipped: string[];
}

type ReviewAction = 'accept' | 'change' | 'skip' | 'quit';

/**
 * Run the interactive review loop for each image.
 *
 * Returns immediately (accepting all images) when `process.stdin.isTTY` is falsy.
 */
export async function runInteractiveReview(
  images: readonly AnalyzedImage[],
  config: Config,
): Promise<ReviewResult> {
  if (!process.stdin.isTTY) {
    logger.warn('Interactive review skipped: stdin is not a TTY.');
    return { images: [...images], overrides: [], skipped: [] };
  }

  const categories = config.categoryConfig.categories.map((c) => c.name);
  const reviewed: AnalyzedImage[] = [];
  const overrides: ReviewOverride[] = [];
  const skipped: string[] = [];

  logger.info(`\n Interactive review — ${images.length} image(s). Press Ctrl-C to abort.\n`);

  for (let i = 0; i < images.length; i++) {
    const img = images[i];

    // Display image summary
    logger.info(
      `[${i + 1}/${images.length}] ${img.file}\n` +
        `  Category    : ${img.analysis.category}\n` +
        `  Description : ${img.analysis.shortDescription}`,
    );

    let action: ReviewAction;
    try {
      action = await select<ReviewAction>({
        message: 'Action',
        choices: [
          { name: '[A] Accept', value: 'accept' },
          { name: '[C] Change category', value: 'change' },
          { name: '[S] Skip (exclude)', value: 'skip' },
          { name: '[Q] Quit review (keep remaining as-is)', value: 'quit' },
        ],
      });
    } catch {
      // User pressed Ctrl-C inside the prompt — treat as quit
      action = 'quit';
    }

    if (action === 'accept') {
      reviewed.push(img);
    } else if (action === 'change') {
      const newCategory = await pickCategory(categories, img.analysis.category);
      if (newCategory !== img.analysis.category) {
        overrides.push({
          file: img.file,
          originalCategory: img.analysis.category,
          overriddenCategory: newCategory,
        });
        reviewed.push({
          ...img,
          analysis: { ...img.analysis, category: newCategory },
        });
      } else {
        reviewed.push(img);
      }
    } else if (action === 'skip') {
      skipped.push(img.file);
      logger.info(`  → Skipped: ${img.file}`);
    } else {
      // quit — keep all remaining images as-is
      reviewed.push(img);
      for (let j = i + 1; j < images.length; j++) {
        reviewed.push(images[j]);
      }
      break;
    }
  }

  logger.info(
    `\n Review complete — ${reviewed.length} accepted, ${overrides.length} overridden, ${skipped.length} skipped.\n`,
  );

  return { images: reviewed, overrides, skipped };
}

/**
 * Prompt the user to choose a new category.
 * Falls back to free-text input if `@inquirer/input` is needed for unlisted categories.
 */
async function pickCategory(categories: string[], current: string): Promise<string> {
  // Offer the full category list plus a "type custom…" sentinel
  const CUSTOM_SENTINEL = '__custom__';

  const choices = categories.map((c) => ({
    name: c === current ? `${c} (current)` : c,
    value: c,
  }));
  choices.push({ name: 'Type a custom value…', value: CUSTOM_SENTINEL });

  const selected = await select<string>({
    message: 'New category',
    choices,
  });

  if (selected === CUSTOM_SENTINEL) {
    const custom = await input({
      message: 'Enter category name',
      validate: (v) => v.trim().length > 0 || 'Category name cannot be empty',
    });
    return custom.trim();
  }

  return selected;
}
