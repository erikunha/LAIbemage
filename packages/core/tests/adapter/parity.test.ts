import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { fingerprintV2 } from '@vision-lens/contracts';

import {
  compareVector,
  cosineSimilarity,
  goldenVectorsDigest,
  maxAbsoluteDifference,
  readGolden,
  runParity,
} from '../../src/adapter/parity.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

const goldenPath = path.join(repoRoot, 'benchmarks', 'parity', 'vision-embed.golden.json');
const artifactDir = path.join(repoRoot, 'benchmarks', 'parity', 'vision-embed.artifact');

describe('the golden file', () => {
  it('carries the digest of the vectors it holds', () => {
    const golden = readGolden(goldenPath);

    expect(golden.vectorsDigest).toBe(goldenVectorsDigest(golden.images));
  });

  it('carries the fingerprint the live TypeScript implementation computes', () => {
    // SC-003: the config fingerprint computed on both sides is byte-equal.
    const golden = readGolden(goldenPath);

    expect(fingerprintV2(golden.config)).toBe(golden.configFingerprint);
  });

  it('carries the tolerance and the reason of the tolerance', () => {
    const golden = readGolden(goldenPath);

    expect(golden.tolerance.maxAbsoluteDifference).toBeGreaterThan(0);
    expect(golden.tolerance.minCosineSimilarity).toBeLessThanOrEqual(1);
    expect(golden.tolerance.reason.length).toBeGreaterThan(0);
  });

  it('is refused when its vectors were edited', () => {
    // Task 3.6: an edited golden file is detected, and the gate never
    // rewrites the file.
    const golden = JSON.parse(readFileSync(goldenPath, 'utf8')) as {
      images: { name: string; vector: number[] }[];
    };
    const edited = {
      ...golden,
      images: golden.images.map((image, index) =>
        index === 0 ? { ...image, vector: [...image.vector] } : image,
      ),
    };
    edited.images[0]!.vector[0] = (edited.images[0]!.vector[0] ?? 0) + 1;
    const original = readFileSync(goldenPath, 'utf8');

    try {
      writeFileSync(goldenPath, JSON.stringify(edited), 'utf8');
      expect(() => readGolden(goldenPath)).toThrow(/was edited/);
    } finally {
      writeFileSync(goldenPath, original, 'utf8');
    }
  });
});

describe('the parity gate', () => {
  it('passes the three tiers over the committed artifact', () => {
    const golden = readGolden(goldenPath);

    const report = runParity(golden, artifactDir);

    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.tiers.map((tier) => tier.name)).toEqual([
      'config-fingerprint',
      'manifest',
      'vectors',
    ]);
  });

  it('names the tier that diverges', () => {
    const golden = readGolden(goldenPath);

    const report = runParity(golden, path.join(repoRoot, 'benchmarks', 'parity', 'does-not-exist'));

    expect(report.ok).toBe(false);
    expect(report.tiers.find((tier) => tier.name === 'manifest')?.ok).toBe(false);
  });

  it('refuses a config whose fingerprint was computed over another configuration', () => {
    const golden = readGolden(goldenPath);
    const other = {
      ...golden,
      config: { ...golden.config, dataVersion: 'another-snapshot' },
    };

    const report = runParity(other, artifactDir);

    expect(report.ok).toBe(false);
    const tier = report.tiers.find((entry) => entry.name === 'config-fingerprint');
    expect(tier?.ok).toBe(false);
    expect(tier?.issues.join(' ')).toContain('configFingerprint');
  });
});

describe('the vector comparison', () => {
  it('reports the cosine similarity and the largest difference', () => {
    const golden = readGolden(goldenPath);
    const image = golden.images[0]!;

    const comparison = compareVector(image, [...image.vector], golden.tolerance);

    expect(comparison.maxAbsoluteDifference).toBe(0);
    expect(comparison.cosineSimilarity).toBeCloseTo(1, 10);
    expect(comparison.ok).toBe(true);
  });

  it('refuses a vector that is outside the tolerance', () => {
    const golden = readGolden(goldenPath);
    const image = golden.images[0]!;
    const broken = [...image.vector];
    broken[0] = (broken[0] ?? 0) + 1;

    const comparison = compareVector(image, broken, golden.tolerance);

    expect(comparison.ok).toBe(false);
    expect(comparison.maxAbsoluteDifference).toBeGreaterThan(
      golden.tolerance.maxAbsoluteDifference,
    );
  });

  it('computes the cosine similarity of two vectors', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 10);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
    expect(Number.isNaN(cosineSimilarity([], []))).toBe(true);
  });

  it('computes the largest absolute difference of two vectors', () => {
    expect(maxAbsoluteDifference([1, 2], [1, 5])).toBe(3);
    expect(maxAbsoluteDifference([1, 2], [1, 2])).toBe(0);
  });
});
