import type { CategoryConfig } from '../config/index.js';
import type { AnalyzedImage } from '../types.js';
import { logger } from '../utils/logger.js';

export interface TemporalConsensusOpts {
  readonly temporalWindowMinutes: number;
  readonly consensusThreshold: number;
  readonly categoryConfig: CategoryConfig;
}

export function applyTemporalConsensus(
  analyzedImages: AnalyzedImage[],
  opts: TemporalConsensusOpts,
): AnalyzedImage[] {
  if (analyzedImages.length < 2) return analyzedImages;

  const immune = new Set(opts.categoryConfig.immune);
  const overridable = new Set(opts.categoryConfig.overridable);
  const clusterWindowMs = opts.temporalWindowMinutes * 60 * 1000;
  const minMajorityRatio = opts.consensusThreshold;

  // Sort by creation time to build temporal clusters
  const sorted = [...analyzedImages].sort((a, b) => a.createdAt - b.createdAt);

  const clusters: AnalyzedImage[][] = [];
  let current: AnalyzedImage[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].createdAt - sorted[i - 1].createdAt <= clusterWindowMs) {
      current.push(sorted[i]);
    } else {
      clusters.push(current);
      current = [sorted[i]];
    }
  }
  clusters.push(current);

  // Build a map of overrides: file → new category
  const overrideMap = new Map<string, string>();
  let overrideCount = 0;

  for (const cluster of clusters) {
    if (cluster.length < 2) continue;

    // Tally votes from confident (non-immune, non-overridable) images only
    const votes: Record<string, number> = {};
    for (const img of cluster) {
      const cat = img.analysis.category;
      if (immune.has(cat) || overridable.has(cat)) continue;
      votes[cat] = (votes[cat] ?? 0) + 1;
    }

    const totalVotes = Object.values(votes).reduce((a, b) => a + b, 0);
    if (totalVotes === 0) continue;

    const [majorityCategory, majorityCount] = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];

    // Threshold against all non-immune images in the cluster
    const eligible = cluster.filter((img) => !immune.has(img.analysis.category)).length;
    if (majorityCount / eligible < minMajorityRatio) continue;

    // Override overridable images
    for (const img of cluster) {
      if (!overridable.has(img.analysis.category)) continue;
      const from = img.analysis.category;
      overrideMap.set(img.file, majorityCategory);
      const pct = Math.round((majorityCount / eligible) * 100);
      logger.verbose(
        `  ${img.file}: ${from} → ${majorityCategory} (cluster ${cluster.length}, ${pct}% agreement)`,
      );
      overrideCount++;
    }
  }

  if (overrideCount > 0) {
    logger.success(`  Temporal consensus corrected ${overrideCount} image(s)`);
  } else {
    logger.info('  No temporal corrections needed');
  }

  // Return new array with overridden images having new analysis objects (immutable)
  return analyzedImages.map((img) => {
    const newCategory = overrideMap.get(img.file);
    if (newCategory !== undefined) {
      return { ...img, analysis: { ...img.analysis, category: newCategory } };
    }
    return img;
  });
}
