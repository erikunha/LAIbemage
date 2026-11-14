#!/usr/bin/env node
/**
 * The golden parity gate of the vision adapter.
 *
 * The gate compares three things over the golden set and exits 1 when
 * any of them diverges:
 *
 *   1. the config fingerprint, computed by the live TypeScript
 *      `fingerprintV2` and compared with the one the golden file names;
 *   2. the manifest of the golden artifact, validated against the
 *      ratified schema of `packages/core/src/adapter/embedding-manifest.ts`;
 *   3. every golden vector, compared with the vectors of the artifact
 *      inside the tolerance the golden file documents.
 *
 * The gate NEVER writes the golden file. A golden file is a committed
 * fact, and a gate that rewrites it accepts anything.
 *
 * Run: `pnpm exec tsx scripts/benchmarks/vision-parity.ts`
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readGolden, runParity } from '../../packages/core/src/adapter/parity.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const goldenPath = path.join(repoRoot, 'benchmarks', 'parity', 'vision-embed.golden.json');
const artifactDir = path.join(repoRoot, 'benchmarks', 'parity', 'vision-embed.artifact');

function main(): number {
  const golden = readGolden(goldenPath);
  const report = runParity(golden, artifactDir);

  for (const tier of report.tiers) {
    console.log(`${tier.name}: ${tier.ok ? 'ok' : 'FAILED'}`);
    for (const issue of tier.issues) console.log('  ' + issue);
  }
  console.log(`images: ${golden.images.length}`);
  console.log(`tolerance: ${golden.tolerance.maxAbsoluteDifference} / ${golden.tolerance.minCosineSimilarity}`);
  if (!report.ok) {
    console.error('vision parity FAILED: the artifact and the golden file disagree');
    return 1;
  }
  console.log('vision parity passed: the artifact and the golden file agree');
  return 0;
}

process.exit(main());
