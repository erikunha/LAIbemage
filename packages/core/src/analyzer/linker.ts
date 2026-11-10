import { z } from 'zod';
import type { ImageLink, ProcessedResult } from '../types.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import type { LLMClient } from './client.js';

const LINK_RELATIONS = ['same_location', 'same_defect', 'progression'] as const;

const LinkResponseSchema = z.object({
  links: z.array(
    z.object({
      imageA: z.number().int(),
      imageB: z.number().int(),
      relation: z.enum(LINK_RELATIONS),
    }),
  ),
});

function buildLinkPrompt(category: string, images: ProcessedResult[], windowDays: number): string {
  const summaries = images
    .map((img) => {
      const date = new Date(img.timestamp).toISOString().slice(0, 10);
      const parts = [`Image ${img.number} (${date}): ${img.shortDescription}`];
      if (img.elements.length > 0) parts.push(`elements: ${img.elements.join(', ')}`);
      return parts.join(', ');
    })
    .join('\n');

  return (
    `You are analyzing a set of images from the "${category}" category captured within a ${windowDays}-day window.\n\n` +
    `Images:\n${summaries}\n\n` +
    `Identify pairs of images that appear to show the same physical location, the same defect, or a defect progressing over time.\n` +
    `Return a JSON object with a "links" array. Each link has imageA (number), imageB (number), and relation ("same_location", "same_defect", or "progression").\n` +
    `Only include meaningful links where you are confident. Return {"links":[]} if no links exist.\n` +
    `Respond ONLY with valid JSON.`
  );
}

/**
 * Cross-image linking pass.
 * Groups processed images by category and time window, calls the LLM to identify related pairs,
 * and returns a map of image number → ImageLink[].
 */
export async function linkImages(
  images: readonly ProcessedResult[],
  client: LLMClient,
  windowDays: number,
  maxAttempts: number,
  retryDelayMs: number,
): Promise<Map<number, ImageLink[]>> {
  const relationsMap = new Map<number, ImageLink[]>();
  for (const img of images) relationsMap.set(img.number, []);

  const byCategory = new Map<string, ProcessedResult[]>();
  for (const img of images) {
    if (img.category === 'unknown') continue;
    const group = byCategory.get(img.category) ?? [];
    group.push(img);
    byCategory.set(img.category, group);
  }

  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  let totalLinks = 0;

  for (const [category, group] of byCategory) {
    const sorted = [...group].sort((a, b) => a.timestamp - b.timestamp);

    // Split into time windows anchored at the first image of each window
    const windows: ProcessedResult[][] = [];
    let currentWindow: ProcessedResult[] = [];
    for (const img of sorted) {
      if (currentWindow.length === 0 || img.timestamp - currentWindow[0]!.timestamp <= windowMs) {
        currentWindow.push(img);
      } else {
        if (currentWindow.length > 1) windows.push(currentWindow);
        currentWindow = [img];
      }
    }
    if (currentWindow.length > 1) windows.push(currentWindow);

    for (const window of windows) {
      const prompt = buildLinkPrompt(category, window, windowDays);
      try {
        const result = await withRetry(() => client.complete(prompt, [], { maxTokens: 1000 }), {
          maxAttempts,
          delayMs: retryDelayMs,
          label: `link:${category}`,
        });

        const parsed = LinkResponseSchema.safeParse(JSON.parse(result.text));
        if (!parsed.success) {
          logger.warn(`  Link pass: unexpected response for category "${category}" — skipping`);
          continue;
        }

        for (const link of parsed.data.links) {
          const aLinks = relationsMap.get(link.imageA);
          const bLinks = relationsMap.get(link.imageB);
          if (aLinks) {
            aLinks.push({ number: link.imageB, relation: link.relation });
            totalLinks++;
          }
          if (bLinks) {
            bLinks.push({ number: link.imageA, relation: link.relation });
          }
        }
      } catch (err) {
        logger.warn(`  Link pass: failed for category "${category}" — ${String(err)}`);
      }
    }
  }

  logger.info(`  Link pass complete: ${totalLinks} relationship(s) found.`);
  return relationsMap;
}
