import type { CategoryConfig } from '../config/index.js';
import type { AnalyzedImage } from '../types.js';
import { getSortedCategories, groupByCategory } from './rules.js';

export interface ClassifyOpts {
  readonly categoryConfig: CategoryConfig;
}

export interface ClassifiedResult {
  readonly grouped: Record<string, AnalyzedImage[]>;
  readonly sortedCategories: string[];
}

export function classifyAndSort(images: AnalyzedImage[], opts: ClassifyOpts): ClassifiedResult {
  const grouped = groupByCategory(images);
  // Within each category, sort by creation time
  for (const cat of Object.keys(grouped)) {
    grouped[cat].sort((a, b) => a.createdAt - b.createdAt);
  }
  const sortedCategories = getSortedCategories(grouped, opts);
  return { grouped, sortedCategories };
}
