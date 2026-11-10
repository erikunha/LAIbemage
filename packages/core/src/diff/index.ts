import type { AnalysisCache, ProcessedResult } from '../types.js';

export type ChangeType =
  | 'added'
  | 'removed'
  | 'category_changed'
  | 'confidence_changed'
  | 'unchanged';

export interface ImageDiff {
  readonly file: string;
  readonly change: ChangeType;
  readonly before?: Pick<ProcessedResult, 'category' | 'confidence' | 'shortDescription'>;
  readonly after?: Pick<ProcessedResult, 'category' | 'confidence' | 'shortDescription'>;
  readonly confidenceDelta?: number;
}

export interface DiffSummary {
  readonly added: number;
  readonly removed: number;
  readonly categoryChanged: number;
  readonly confidenceChanged: number;
  readonly unchanged: number;
  readonly diffs: ImageDiff[];
}

/**
 * Compares two `AnalysisCache` objects by `originalFile` key and returns a
 * structured diff. Pure — no I/O, no SDKs.
 */
export function diffCaches(before: AnalysisCache, after: AnalysisCache): DiffSummary {
  const beforeMap = new Map(before.images.map((img) => [img.originalFile, img]));
  const afterMap = new Map(after.images.map((img) => [img.originalFile, img]));

  const diffs: ImageDiff[] = [];
  let added = 0,
    removed = 0,
    categoryChanged = 0,
    confidenceChanged = 0,
    unchanged = 0;

  const snap = (img: ProcessedResult) => ({
    category: img.category,
    confidence: img.confidence,
    shortDescription: img.shortDescription,
  });

  for (const [file, bImg] of beforeMap) {
    const aImg = afterMap.get(file);
    if (!aImg) {
      removed++;
      diffs.push({ file, change: 'removed', before: snap(bImg) });
      continue;
    }
    const confDelta = aImg.confidence - bImg.confidence;
    if (bImg.category !== aImg.category) {
      categoryChanged++;
      diffs.push({
        file,
        change: 'category_changed',
        before: snap(bImg),
        after: snap(aImg),
        confidenceDelta: confDelta,
      });
    } else if (Math.abs(confDelta) > 0.05) {
      confidenceChanged++;
      diffs.push({
        file,
        change: 'confidence_changed',
        before: snap(bImg),
        after: snap(aImg),
        confidenceDelta: confDelta,
      });
    } else {
      unchanged++;
      diffs.push({
        file,
        change: 'unchanged',
        before: snap(bImg),
        after: snap(aImg),
        confidenceDelta: confDelta,
      });
    }
  }

  for (const [file, aImg] of afterMap) {
    if (!beforeMap.has(file)) {
      added++;
      diffs.push({ file, change: 'added', after: snap(aImg) });
    }
  }

  return { added, removed, categoryChanged, confidenceChanged, unchanged, diffs };
}
