import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { fingerprintV2 } from '@vision-lens/contracts';

import {
  GOLDEN_CONTENT_DIGEST,
  compareVector,
  cosineSimilarity,
  goldenContentDigest,
  goldenVectorsDigest,
  maxAbsoluteDifference,
  readGolden,
  runParity,
} from '../../src/adapter/parity.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

const goldenPath = path.join(repoRoot, 'benchmarks', 'parity', 'vision-embed.golden.json');
const artifactDir = path.join(repoRoot, 'benchmarks', 'parity', 'vision-embed.artifact');

/** The temporary directories this suite creates, removed after every test. */
const temporaries: string[] = [];

afterEach(() => {
  for (const directory of temporaries.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** A copy of the golden file in a temporary directory, ready to be edited. */
function goldenCopy(): { path: string; payload: Record<string, unknown> } {
  const directory = mkdtempSync(path.join(tmpdir(), 'vl-golden-'));
  temporaries.push(directory);
  const target = path.join(directory, 'vision-embed.golden.json');
  const payload = JSON.parse(readFileSync(goldenPath, 'utf8')) as Record<string, unknown>;
  writeFileSync(target, JSON.stringify(payload), 'utf8');
  return { path: target, payload };
}

/** A copy of the committed artifact, ready to have its manifest edited. */
function artifactCopy(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'vl-artifact-'));
  temporaries.push(directory);
  cpSync(artifactDir, directory, { recursive: true });
  return directory;
}

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
    // rewrites the file. The edit happens in a temporary copy: a test
    // that edits the committed file leaves it edited when it is killed.
    const copy = goldenCopy();
    const images = copy.payload['images'] as { name: string; vector: number[] }[];
    images[0]!.vector[0] = (images[0]!.vector[0] ?? 0) + 1;
    writeFileSync(copy.path, JSON.stringify(copy.payload), 'utf8');

    expect(() => readGolden(copy.path)).toThrow(/was edited/);
  });

  it('is refused when its tolerance was widened', () => {
    // The tolerance is the strength of the gate, so it is inside the
    // digest of the content and pinned in the code: widening it is a
    // visible diff, not an edit nobody sees.
    const copy = goldenCopy();
    const tolerance = copy.payload['tolerance'] as { maxAbsoluteDifference: number };
    tolerance.maxAbsoluteDifference = 1000;
    writeFileSync(copy.path, JSON.stringify(copy.payload), 'utf8');

    expect(() => readGolden(copy.path)).toThrow(/was edited/);
  });

  it('is refused when its config and its fingerprint were edited together', () => {
    // Two coordinated edits of one file are still an edit of the file:
    // the pin of the content digest lives in the code.
    const copy = goldenCopy();
    const config = copy.payload['config'] as Record<string, unknown>;
    config['dataVersion'] = 'another-snapshot';
    copy.payload['configFingerprint'] = fingerprintV2(
      config as unknown as Parameters<typeof fingerprintV2>[0],
    );
    writeFileSync(copy.path, JSON.stringify(copy.payload), 'utf8');

    expect(() => readGolden(copy.path)).toThrow(/was edited/);
  });

  it('digests to the value the code pins', () => {
    const golden = readGolden(goldenPath);

    // The pin lives in the code, so a change to the golden set is a
    // change to the code too.
    expect(goldenContentDigest(golden)).toBe(GOLDEN_CONTENT_DIGEST);
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

  it('refuses a manifest that names another model', () => {
    // The identity of the manifest is compared with the identity of the
    // golden set: a manifest that validates against the schema and
    // describes another model is still the wrong manifest.
    const directory = artifactCopy();
    const manifestPath = path.join(directory, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest['modelId'] = 'another-model';
    writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
    const golden = readGolden(goldenPath);

    const report = runParity(golden, directory);

    expect(report.ok).toBe(false);
    const tier = report.tiers.find((entry) => entry.name === 'manifest');
    expect(tier?.ok).toBe(false);
    expect(tier?.issues.join(' ')).toContain('modelId');
  });

  it('refuses a manifest that names other assets', () => {
    const directory = artifactCopy();
    const manifestPath = path.join(directory, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest['assetSha256'] = ['0'.repeat(64)];
    writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
    const golden = readGolden(goldenPath);

    const report = runParity(golden, directory);

    expect(report.ok).toBe(false);
    const tier = report.tiers.find((entry) => entry.name === 'manifest');
    expect(tier?.issues.join(' ')).toContain('assetSha256');
  });

  it('refuses a manifest whose preprocessing differs', () => {
    const directory = artifactCopy();
    const manifestPath = path.join(directory, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    const components = manifest['preprocessingComponents'] as Record<string, unknown>;
    manifest['preprocessingComponents'] = { ...components, interpolation: 'nearest' };
    writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
    const golden = readGolden(goldenPath);

    const report = runParity(golden, directory);

    expect(report.ok).toBe(false);
    const tier = report.tiers.find((entry) => entry.name === 'manifest');
    expect(tier?.issues.join(' ')).toContain('preprocessingComponents');
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
