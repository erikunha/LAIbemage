import type { CategoryConfig } from '../config/index.js';

export interface CategoryOpts {
  readonly categoryConfig: CategoryConfig;
}

export function getSortedCategories(
  groupedByCategory: Record<string, unknown[]>,
  opts: CategoryOpts,
): string[] {
  const pinnedSet = new Set(opts.categoryConfig.pinnedLast);
  const unpinned = Object.keys(groupedByCategory)
    .filter((c) => !pinnedSet.has(c))
    .sort();
  const pinned = opts.categoryConfig.pinnedLast.filter((c) => !!groupedByCategory[c]);
  return [...unpinned, ...pinned];
}

export function groupByCategory<T extends { analysis: { category: string } }>(
  images: T[],
): Record<string, T[]> {
  const grouped: Record<string, T[]> = {};
  for (const img of images) {
    const cat = img.analysis.category;
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(img);
  }
  return grouped;
}

export function isImmune(category: string, opts: CategoryOpts): boolean {
  return opts.categoryConfig.immune.includes(category);
}
