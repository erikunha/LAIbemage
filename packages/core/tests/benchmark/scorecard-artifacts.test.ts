/**
 * The artifact suite of the evaluation scorecard (spec 022, SC-006).
 *
 * The per-sample artifact must land under the gitignored results directory;
 * the committed pointer must record every artifact's relative path, sha256,
 * byte count and row count plus the scorecard digest; and a tampered
 * artifact must FAIL the digest check, never warn.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PredictionItem } from '../../src/benchmark/metrics.js';
import { computeManifestHash, type SplitManifest } from '../../src/benchmark/splits.js';
import type { DatasetRegistryEntry } from '../../src/benchmark/registry.js';
import type { ReproductionTuple } from '../../src/benchmark/runner.js';
import {
  buildPerSampleRows,
  buildScorecard,
  defaultScorecardPointerPath,
  PER_SAMPLE_ARTIFACT_COLUMNS,
  SCORECARD_DEFAULT_POINTER_DIR,
  SCORECARD_DEFAULT_RESULTS_DIR,
  serializePerSampleArtifact,
  verifyScorecardArtifacts,
  writeScorecardArtifacts,
  type Scorecard,
  type ScorecardPointer,
} from '../../src/benchmark/scorecard.js';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);

interface OracleFixture {
  readonly manifest: Omit<SplitManifest, 'manifestHash'>;
  readonly predictions: readonly PredictionItem[];
  readonly expected: { readonly partitionSizes: { readonly test: number } };
}

const fixture = JSON.parse(
  readFileSync(
    path.join(REPO_ROOT, 'packages', 'core', 'tests', 'benchmark', 'fixtures', 'scorecard-oracle.json'),
    'utf8',
  ),
) as OracleFixture;

const MANIFEST: SplitManifest = {
  ...fixture.manifest,
  manifestHash: computeManifestHash(fixture.manifest),
};

const DATASET_ENTRY: DatasetRegistryEntry = {
  id: 'scorecard-oracle',
  title: 'Scorecard oracle fixture (synthetic)',
  usage: 'benchmark',
  license: 'CC BY 4.0',
  licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  commercialUse: true,
  source: 'https://example.test/oracle',
  resource: 'https://example.test/oracle.tar',
  version: 'oracle-1',
  archiveBytes: null,
  etag: null,
  parts: { selected: [], rationale: 'synthetic fixture' },
  sha256: null,
  sha256PinnedAt: null,
  attribution: 'Synthetic oracle fixture; no external data.',
  fetchedAt: null,
  notes: 'Synthetic fixture of the scorecard artifacts suite.',
};

const TUPLE: ReproductionTuple = {
  snapshotId: 'oracle-snapshot-0001',
  splitFingerprint: MANIFEST.manifestHash,
  modelVersion: 'model:oracle@1.0.0',
  configFingerprint: 'fp2:oracle00000001',
  env: { nodeVersion: 'v24.0.0', platform: 'darwin' },
};

const NOW = new Date('2026-11-11T00:00:00.000Z');

function buildOracleScorecard(): Scorecard {
  const result = buildScorecard({
    suite: 'scorecard-oracle',
    model: 'oracle-model',
    tuple: TUPLE,
    splitManifest: MANIFEST,
    predictions: fixture.predictions,
    datasetEntry: DATASET_ENTRY,
    resamples: 50,
    now: NOW,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('the oracle scorecard failed to build');
  return result.scorecard;
}

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'scorecard-artifacts-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

async function writeAll(now: Date = NOW) {
  const scorecard = buildOracleScorecard();
  const written = await writeScorecardArtifacts({
    scorecard: { ...scorecard, generatedAt: now.toISOString() },
    splitManifest: MANIFEST,
    predictions: fixture.predictions,
    outputDir: path.join(workDir, 'results'),
    pointerPath: path.join(workDir, 'scorecards', 'scorecard-oracle.oracle-model.json'),
    pathBase: workDir,
    reproduce: { command: 'vision-lens benchmark scorecard (see the suite docs)' },
  });
  expect(written.ok).toBe(true);
  if (!written.ok) throw new Error('writing the artifacts failed');
  return written;
}

describe('the per-sample artifact (FR-015, task 5.4)', () => {
  it('carries the header row the pack asks for, then one row per scored item', () => {
    const rows = buildPerSampleRows(MANIFEST, fixture.predictions);
    expect(rows).toHaveLength(fixture.expected.partitionSizes.test);
    expect(rows.every((row) => row.partition === 'test')).toBe(true);

    const body = serializePerSampleArtifact(rows);
    const lines = body.split('\n').filter((line) => line !== '');
    expect(JSON.parse(lines[0] as string)).toEqual([...PER_SAMPLE_ARTIFACT_COLUMNS]);
    expect(lines).toHaveLength(rows.length + 1);

    // No train or val item is ever in the per-sample artifact.
    const testIds = new Set(
      MANIFEST.assignments
        .filter((assignment) => assignment.split === 'test')
        .map((assignment) => assignment.id),
    );
    for (const line of lines.slice(1)) {
      const row = JSON.parse(line) as { id: string };
      expect(testIds.has(row.id)).toBe(true);
    }

    // A gold item without a prediction still has its row, as a failure.
    const missing = rows.find((row) => row.predictedLabelKey === null);
    expect(missing).toBeDefined();
    expect(missing?.correct).toBe(false);
  });
});

describe('the committed pointer (SC-006, FR-015)', () => {
  it('the artifacts land under the results directory and the pointer records every digest', async () => {
    const written = await writeAll();
    const pointerDir = path.join(workDir, 'scorecards');
    const resultsDir = path.join(workDir, 'results');

    expect(existsSync(written.perSamplePath)).toBe(true);
    expect(existsSync(written.scorecardPath)).toBe(true);
    expect(written.perSamplePath.startsWith(resultsDir)).toBe(true);
    expect(written.scorecardPath.startsWith(resultsDir)).toBe(true);
    expect(existsSync(written.pointerPath)).toBe(true);
    expect(written.pointerPath.startsWith(pointerDir)).toBe(true);

    const pointer = JSON.parse(readFileSync(written.pointerPath, 'utf8')) as ScorecardPointer;
    expect(pointer.scorecardId).toBe(written.scorecardWithRefs.scorecardId);
    expect(pointer.manifestSha256).toBe(MANIFEST.manifestHash);
    expect(pointer.testSplitFingerprint).toBe(written.scorecardWithRefs.testSplitFingerprint);
    expect(pointer.scorecardSha256).toBe(written.scorecardSha256);
    expect(pointer.regime).toBe('test-partition');
    expect(pointer.pathBase).toBe(workDir);
    expect(pointer.reproduce.command).toContain('benchmark scorecard');

    const perSampleRef = pointer.artifactRefs.find((ref) => ref.role === 'per-sample');
    const scorecardRef = pointer.artifactRefs.find((ref) => ref.role === 'scorecard');
    expect(perSampleRef).toBeDefined();
    expect(scorecardRef).toBeDefined();
    expect(perSampleRef?.rows).toBe(fixture.expected.partitionSizes.test);
    expect(perSampleRef?.tracked).toBe(false);
    expect(scorecardRef?.tracked).toBe(false);
    expect(perSampleRef?.bytes).toBeGreaterThan(0);
    // The recorded paths are relative to the pointer's path base and point
    // inside the results directory.
    expect(perSampleRef?.path.startsWith('results/')).toBe(true);
    expect(scorecardRef?.path.startsWith('results/')).toBe(true);
  });

  it('verification passes on the untouched artifacts', async () => {
    const written = await writeAll();
    const verification = await verifyScorecardArtifacts(written.pointerPath);
    expect(verification.ok).toBe(true);
  });

  it('a tampered per-sample artifact fails the digest check', async () => {
    const written = await writeAll();
    const original = readFileSync(written.perSamplePath, 'utf8');
    writeFileSync(written.perSamplePath, `${original}tampered\n`, 'utf8');

    const verification = await verifyScorecardArtifacts(written.pointerPath);
    expect(verification.ok).toBe(false);
    if (verification.ok) return;
    expect(verification.error.code).toBe('artifact-write-failed');
    expect(verification.error.message).toContain('does not match the pointer');
  });

  it('a tampered scorecard artifact fails with both digests named', async () => {
    const written = await writeAll();
    const original = readFileSync(written.scorecardPath, 'utf8');
    writeFileSync(written.scorecardPath, original.replace('scorecard-v1', 'scorecard-v2'), 'utf8');

    const verification = await verifyScorecardArtifacts(written.pointerPath);
    expect(verification.ok).toBe(false);
    if (verification.ok) return;
    expect(verification.error.code).toBe('artifact-write-failed');
    expect(verification.error.message).toContain('sha256');
  });

  it('a missing artifact fails, never passes silently', async () => {
    const written = await writeAll();
    rmSync(written.perSamplePath);

    const verification = await verifyScorecardArtifacts(written.pointerPath);
    expect(verification.ok).toBe(false);
    if (verification.ok) return;
    expect(verification.error.code).toBe('artifact-write-failed');
    expect(verification.error.message).toContain('cannot be read');
  });

  it('the artifacts are byte-stable across reruns with the same clock', async () => {
    const first = await writeAll(NOW);
    const second = await writeAll(NOW);
    expect(first.scorecardSha256).toBe(second.scorecardSha256);
    expect(first.refs).toEqual(second.refs);
    expect(readFileSync(first.perSamplePath, 'utf8')).toBe(
      readFileSync(second.perSamplePath, 'utf8'),
    );
  });

  it('a row-count lie in the pointer fails the verification', async () => {
    const written = await writeAll();
    const pointer = JSON.parse(readFileSync(written.pointerPath, 'utf8')) as ScorecardPointer;
    const lying: ScorecardPointer = {
      ...pointer,
      artifactRefs: pointer.artifactRefs.map((ref) =>
        ref.role === 'per-sample' ? { ...ref, rows: ref.rows + 1 } : ref,
      ),
    };
    writeFileSync(written.pointerPath, `${JSON.stringify(lying, null, 2)}\n`, 'utf8');

    const verification = await verifyScorecardArtifacts(written.pointerPath);
    expect(verification.ok).toBe(false);
    if (verification.ok) return;
    expect(verification.error.message).toContain('rows');
  });
});

describe('a failed write leaves no claim behind (FR-015)', () => {
  /** A pointer path that cannot be written: a directory stands where the file goes. */
  function blockedPointerPath(): string {
    const pointerPath = path.join(workDir, 'scorecards', 'scorecard-oracle.oracle-model.json');
    rmSync(pointerPath, { force: true });
    mkdirSync(pointerPath, { recursive: true });
    return pointerPath;
  }

  it('a failed pointer write leaves neither artifacts nor staging files behind', async () => {
    const scorecard = buildOracleScorecard();
    const pointerPath = blockedPointerPath();
    const outputDir = path.join(workDir, 'results');

    const written = await writeScorecardArtifacts({
      scorecard,
      splitManifest: MANIFEST,
      predictions: fixture.predictions,
      outputDir,
      pointerPath,
      pathBase: workDir,
      reproduce: { command: 'vision-lens benchmark scorecard (see the suite docs)' },
    });

    expect(written.ok).toBe(false);
    if (written.ok) return;
    expect(written.error.code).toBe('artifact-write-failed');
    // The artifacts of a run that never published a pointer are orphans: gone.
    expect(existsSync(path.join(outputDir, scorecard.scorecardId))).toBe(false);
    // The staging file of the failed pointer is gone too.
    expect(existsSync(`${pointerPath}.tmp`)).toBe(false);
  });

  it('a failed rerun keeps the artifacts a published pointer names', async () => {
    const first = await writeAll();
    const publishedScorecard = readFileSync(first.scorecardPath, 'utf8');
    const pointerPath = blockedPointerPath();
    const scorecard = buildOracleScorecard();

    const written = await writeScorecardArtifacts({
      scorecard: {
        ...scorecard,
        generatedAt: new Date('2026-11-12T00:00:00.000Z').toISOString(),
      },
      splitManifest: MANIFEST,
      predictions: fixture.predictions,
      outputDir: path.join(workDir, 'results'),
      pointerPath,
      pathBase: workDir,
      reproduce: { command: 'vision-lens benchmark scorecard (see the suite docs)' },
    });

    expect(written.ok).toBe(false);
    if (written.ok) return;
    expect(written.error.code).toBe('artifact-write-failed');
    // The artifacts of the published run survive a later failed run: a failed
    // run never deletes what a published pointer still names.
    expect(existsSync(first.perSamplePath)).toBe(true);
    expect(existsSync(first.scorecardPath)).toBe(true);
    // And the scorecard artifact is the PUBLISHED one, byte for byte: the
    // pointer was not renamed, so it still names the bytes it named, and the
    // run that failed must not have replaced them. The scorecard artifact
    // carries the clock, so a rerun would otherwise write different bytes and
    // leave the published pointer naming a digest that is no longer on disk.
    expect(readFileSync(first.scorecardPath, 'utf8')).toBe(publishedScorecard);
  });
});

describe('the gitignore contract (FR-015)', () => {
  it('the default results directory is gitignored and the pointer directory is not', () => {
    const gitignore = readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8');
    const lines = gitignore.split('\n').map((line) => line.trim());
    expect(SCORECARD_DEFAULT_RESULTS_DIR).toBe(path.join('benchmarks', 'results'));
    expect(SCORECARD_DEFAULT_POINTER_DIR).toBe(path.join('benchmarks', 'scorecards'));
    expect(lines).toContain('benchmarks/results/');
    expect(lines).not.toContain('benchmarks/scorecards/');
    expect(defaultScorecardPointerPath('visa-subset.v2', 'gpt-4o')).toBe(
      path.join('benchmarks', 'scorecards', 'visa-subset.v2.gpt-4o.json'),
    );
  });
});
