import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { computeManifestHash, evaluateGate } from '@vision-lens/core/benchmark';
import type { Scorecard } from '@vision-lens/core/benchmark';

/**
 * The `vision-lens benchmark` CLI surface (spec 003, US3 + US4).
 *
 * The tests that matter here are the BEHAVIOURS a CI pipeline depends on:
 *
 *  - a missing dataset is a SKIP with an explicit marker and a zero exit code
 *    (never a failure, never a fabricated number);
 *  - a failing gate exits non-zero and names the regressed classes.
 *
 * The binary tests require a built `dist`; they skip on a fast unit run.
 */

vi.setConfig({ testTimeout: 60_000 });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_BIN = path.join(__dirname, '..', 'dist', 'index.js');
const BINS_BUILT = existsSync(INDEX_BIN);
/**
 * The repository root.
 *
 * The CLI is a repository tool: it reads the dataset registry and the tracked
 * splits by their repository-relative paths, so it runs FROM the repository
 * root. The tests spawn it there, whatever the directory the test runner
 * happens to be in.
 */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

interface BinResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number;
}

function runBin(args: string[]): BinResult {
  const result = spawnSync(process.execPath, [INDEX_BIN, ...args], {
    encoding: 'utf8',
    // The CLI reads the repository files by their repository-relative paths,
    // so it is spawned from the repository root.
    cwd: REPO_ROOT,
    env: { ...process.env, VISION_LENS_NO_DEPRECATION: '1' },
  });
  expect(result.error).toBeUndefined();
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? -1,
  };
}

/** A minimal report artifact the gate can read. */
function writeReport(
  dir: string,
  macroF1: number,
  perClass: Record<string, number>,
  partial = false,
  splitFingerprint = 'def',
): string {
  const reportPath = path.join(dir, 'report.json');
  writeFileSync(
    reportPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        runId: 'test-run',
        suite: 'synthetic',
        model: 'demo',
        generatedAt: '2026-01-01T00:00:00.000Z',
        partial,
        tuple: {
          snapshotId: 'abc',
          splitFingerprint,
          modelVersion: 'model:demo@1',
          configFingerprint: 'ghi',
          env: {},
        },
        metrics: {
          itemsScored: 10,
          correct: 8,
          accuracy: 0.8,
          perClass: Object.entries(perClass).map(([labelKey, f1]) => ({
            labelKey,
            support: 5,
            predicted: 5,
            truePositives: 4,
            falsePositives: 1,
            falseNegatives: 1,
            precision: 0.8,
            recall: 0.8,
            f1,
          })),
          macroF1,
          balancedAccuracy: macroF1,
          confusion: { labels: [], rows: {} },
          unseenPredictedLabels: [],
          excludedClasses: [],
          caveats: [],
          latency: { count: 10, p50Ms: 100, p95Ms: 200 },
          cost: {
            totalCostUsd: 0.01,
            costPerImageUsd: 0.001,
            amortizedCostPerScoredImageUsd: 0.001,
            itemsWithCost: 10,
            itemsWithoutCost: 0,
          },
        },
        calibration: { itemsScored: 10, itemsWithoutProbability: 0, ece: 0.1, bins: [] },
        caveats: [],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return reportPath;
}

/**
 * A report artifact whose reproduction tuple carries NO split fingerprint:
 * the run cannot be attributed to any split.
 */
function writeReportWithoutSplitFingerprint(
  dir: string,
  macroF1: number,
  perClass: Record<string, number>,
): string {
  const reportPath = path.join(dir, 'report.json');
  writeFileSync(
    reportPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        runId: 'test-run',
        suite: 'synthetic',
        model: 'demo',
        generatedAt: '2026-01-01T00:00:00.000Z',
        partial: false,
        tuple: {
          snapshotId: 'abc',
          modelVersion: 'model:demo@1',
          configFingerprint: 'ghi',
          env: {},
        },
        metrics: {
          itemsScored: 10,
          correct: 8,
          accuracy: 0.8,
          perClass: Object.entries(perClass).map(([labelKey, f1]) => ({
            labelKey,
            support: 5,
            predicted: 5,
            truePositives: 4,
            falsePositives: 1,
            falseNegatives: 1,
            precision: 0.8,
            recall: 0.8,
            f1,
          })),
          macroF1,
          balancedAccuracy: macroF1,
          confusion: { labels: [], rows: {} },
          unseenPredictedLabels: [],
          excludedClasses: [],
          caveats: [],
          latency: { count: 10, p50Ms: 100, p95Ms: 200 },
          cost: {
            totalCostUsd: 0.01,
            costPerImageUsd: 0.001,
            amortizedCostPerScoredImageUsd: 0.001,
            itemsWithCost: 10,
            itemsWithoutCost: 0,
          },
        },
        calibration: { itemsScored: 10, itemsWithoutProbability: 0, ece: 0.1, bins: [] },
        caveats: [],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return reportPath;
}

/**
 * A split manifest the gate can read.
 *
 * The two identifiers are DISTINCT and the fixture keeps them apart: the
 * manifest hash is the identity of the split FILE (the value the
 * reproduction tuple and the baseline entries carry), the partition
 * fingerprint is the identity of the PARTITION alone.
 */
function writeSplitManifest(
  file: string,
  manifestHash: string,
  partitionFingerprint: string,
): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        schemaVersion: 2,
        id: path.basename(file, '.json'),
        datasetId: 'test-dataset',
        strategy: 'stratified',
        manifestHash,
        partitionFingerprint,
        assignments: [
          { id: 'a', split: 'train' },
          { id: 'b', split: 'val' },
          { id: 'c', split: 'test' },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return file;
}

/**
 * A baseline whose recorded split fingerprint is `splitFingerprint`.
 *
 * The fingerprint is the manifest hash of the split file the baseline was
 * measured against. When the caller supplies none, the baseline carries NO
 * fingerprint at all: it cannot be attributed to a split, so the gate must
 * refuse to compare it.
 */
function writeBaseline(dir: string, splitFingerprint?: string): string {
  const baselinePath = path.join(dir, 'baseline.json');
  writeFileSync(
    baselinePath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: '2026-01-01T00:00:00.000Z',
        entries: [
          {
            suite: 'synthetic',
            model: 'demo',
            modelVersion: 'model:demo@1',
            macroF1: 0.5,
            perClass: { alpha: 0.5, beta: 0.5 },
            ...(splitFingerprint === undefined ? {} : { splitFingerprint }),
            generatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return baselinePath;
}

describe.skipIf(!BINS_BUILT)('vision-lens benchmark (requires built dist)', () => {
  it('advertises the run, gate and report subcommands', () => {
    const result = runBin(['benchmark', '--help']);
    expect(result.stdout).toContain('run');
    expect(result.stdout).toContain('gate');
    expect(result.stdout).toContain('report');
    expect(result.status).toBe(0);
  });

  it('skips with an explicit marker when the run artifact is absent', () => {
    const result = runBin([
      'benchmark',
      'gate',
      '--suite',
      'no-such-suite',
      '--model-id',
      'demo',
      '--metrics',
      path.join(tmpdir(), 'no-such-report.json'),
    ]);
    const output = `${result.stdout}${result.stderr}`;
    // The marker names what is actually missing: the ARTIFACT, not the
    // dataset — a CI step with a dataset but no run must not read as a
    // dataset skip.
    expect(output).toContain('artifact=absent');
    expect(output).toContain('gate=skipped');
    expect(result.status).toBe(0);
  });

  it('skips the RUN with the dataset marker when the split manifest is absent', () => {
    const result = runBin([
      'benchmark',
      'run',
      '--suite',
      'no-such-suite',
      '--model-id',
      'demo',
      '--predictions',
      path.join(tmpdir(), 'no-such-predictions.json'),
      '--config-fingerprint',
      'cfg-test',
      '--model-version',
      'model:demo@1',
    ]);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain('dataset=absent');
    expect(result.status).toBe(0);
  });

  it('fails with a non-zero exit code when the gate regresses', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vision-lens-cli-gate-'));
    try {
      const baselinePath = path.join(dir, 'baseline.json');
      writeFileSync(
        baselinePath,
        `${JSON.stringify(
          {
            schemaVersion: 1,
            generatedAt: '2026-01-01T00:00:00.000Z',
            entries: [
              {
                suite: 'synthetic',
                model: 'demo',
                modelVersion: 'model:demo@1',
                macroF1: 1,
                perClass: { alpha: 1, beta: 1 },
                generatedAt: '2026-01-01T00:00:00.000Z',
              },
            ],
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
      const reportPath = writeReport(dir, 0.5, { alpha: 0.5, beta: 0.5 });

      const result = runBin([
        'benchmark',
        'gate',
        '--suite',
        'synthetic',
        '--model-id',
        'demo',
        '--metrics',
        reportPath,
        '--baseline',
        baselinePath,
      ]);

      const output = `${result.stdout}${result.stderr}`;
      expect(result.status).toBe(1);
      expect(output).toContain('gate failed');
      expect(output).toContain('alpha');
      expect(output).toContain('beta');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes when the run matches the baseline', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vision-lens-cli-gate-pass-'));
    try {
      const baselinePath = path.join(dir, 'baseline.json');
      writeFileSync(
        baselinePath,
        `${JSON.stringify(
          {
            schemaVersion: 1,
            generatedAt: '2026-01-01T00:00:00.000Z',
            entries: [
              {
                suite: 'synthetic',
                model: 'demo',
                modelVersion: 'model:demo@1',
                macroF1: 0.5,
                perClass: { alpha: 0.5, beta: 0.5 },
                generatedAt: '2026-01-01T00:00:00.000Z',
              },
            ],
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
      const reportPath = writeReport(dir, 0.5, { alpha: 0.5, beta: 0.5 });

      const result = runBin([
        'benchmark',
        'gate',
        '--suite',
        'synthetic',
        '--model-id',
        'demo',
        '--metrics',
        reportPath,
        '--baseline',
        baselinePath,
      ]);

      expect(result.status).toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('gate passed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prints a stored report', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vision-lens-cli-report-'));
    try {
      const runDir = path.join(dir, 'test-run');
      mkdirSync(runDir, { recursive: true });
      writeReport(runDir, 0.5, { alpha: 0.5, beta: 0.5 });

      const result = runBin(['benchmark', 'report', '--run', 'test-run', '--dir', dir]);
      const output = `${result.stdout}${result.stderr}`;
      expect(result.status).toBe(0);
      expect(output).toContain('macro F1');
      expect(output).toContain('test-run');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to gate an artifact of ANOTHER model against this baseline', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vision-lens-cli-gate-model-'));
    try {
      const baselinePath = path.join(dir, 'baseline.json');
      writeFileSync(
        baselinePath,
        `${JSON.stringify(
          {
            schemaVersion: 1,
            generatedAt: '2026-01-01T00:00:00.000Z',
            entries: [
              {
                suite: 'synthetic',
                model: 'demo',
                modelVersion: 'model:demo@1',
                macroF1: 1,
                perClass: { alpha: 1 },
                generatedAt: '2026-01-01T00:00:00.000Z',
              },
            ],
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
      // The artifact was produced by a DIFFERENT model than the one asked for.
      const reportPath = writeReport(dir, 0.5, { alpha: 0.5, beta: 0.5 });

      const result = runBin([
        'benchmark',
        'gate',
        '--suite',
        'synthetic',
        '--model-id',
        'other-model',
        '--metrics',
        reportPath,
        '--baseline',
        baselinePath,
      ]);

      const output = `${result.stdout}${result.stderr}`;
      expect(result.status).toBe(1);
      expect(output).toContain('Refusing to compare them');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('SKIPS a partial artifact instead of failing it', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vision-lens-cli-gate-partial-'));
    try {
      const baselinePath = path.join(dir, 'baseline.json');
      writeFileSync(
        baselinePath,
        `${JSON.stringify(
          {
            schemaVersion: 1,
            generatedAt: '2026-01-01T00:00:00.000Z',
            entries: [
              {
                suite: 'synthetic',
                model: 'demo',
                modelVersion: 'model:demo@1',
                macroF1: 1,
                perClass: { alpha: 1 },
                generatedAt: '2026-01-01T00:00:00.000Z',
              },
            ],
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
      // The artifact says it is PARTIAL (a provider outage).
      const reportPath = writeReport(dir, 0.5, { alpha: 0.5, beta: 0.5 }, true);

      const result = runBin([
        'benchmark',
        'gate',
        '--suite',
        'synthetic',
        '--model-id',
        'demo',
        '--metrics',
        reportPath,
        '--baseline',
        baselinePath,
      ]);

      const output = `${result.stdout}${result.stderr}`;
      expect(result.status).toBe(0);
      expect(output).toContain('gate=skipped');
      expect(output).not.toContain('gate failed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to bless a run measured on a split that is NOT the tracked one', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vision-lens-cli-gate-split-'));
    try {
      const splitsDir = path.join(dir, 'splits');
      // The tracked split is the one the suite is measured against NOW; the
      // recorded one is the split the tracked baseline was measured against.
      const trackedSplit = writeSplitManifest(
        path.join(splitsDir, 'tracked.gold.json'),
        'hash-current',
        'partition-current',
      );
      writeSplitManifest(
        path.join(splitsDir, 'recorded.gold.json'),
        'hash-recorded',
        'partition-recorded',
      );
      const baselinePath = writeBaseline(dir, 'hash-recorded');
      // The macro F1 did NOT regress, so only the split identity can refuse
      // this run. The RUN itself was measured against the recorded split.
      const reportPath = writeReport(
        dir,
        0.5,
        { alpha: 0.5, beta: 0.5 },
        false,
        'hash-recorded',
      );

      const result = runBin([
        'benchmark',
        'gate',
        '--suite',
        'synthetic',
        '--model-id',
        'demo',
        '--metrics',
        reportPath,
        '--baseline',
        baselinePath,
        '--split',
        trackedSplit,
      ]);

      const output = `${result.stdout}${result.stderr}`;
      expect(result.status).toBe(1);
      expect(output).toContain('gate failed');
      // The message must name BOTH splits: the one the baseline was recorded
      // against and the one that is tracked now.
      expect(output).toContain('recorded.gold');
      expect(output).toContain('tracked.gold');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to bless a run whose baseline cannot be attributed to a split', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vision-lens-cli-gate-baseline-split-'));
    try {
      const splitsDir = path.join(dir, 'splits');
      const trackedSplit = writeSplitManifest(
        path.join(splitsDir, 'tracked.gold.json'),
        'hash-current',
        'partition-current',
      );
      // The baseline carries NO split fingerprint: it cannot be attributed to
      // the tracked split, so it must not bless the run.
      const baselinePath = writeBaseline(dir);
      const reportPath = writeReport(
        dir,
        0.5,
        { alpha: 0.5, beta: 0.5 },
        false,
        'hash-current',
      );

      const result = runBin([
        'benchmark',
        'gate',
        '--suite',
        'synthetic',
        '--model-id',
        'demo',
        '--metrics',
        reportPath,
        '--baseline',
        baselinePath,
        '--split',
        trackedSplit,
      ]);

      const output = `${result.stdout}${result.stderr}`;
      expect(result.status).toBe(1);
      expect(output).toContain('gate failed');
      expect(output).toMatch(/no split fingerprint/i);
      expect(output).not.toContain('gate passed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to bless a run that cannot be attributed to a split at all', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vision-lens-cli-gate-run-split-'));
    try {
      const splitsDir = path.join(dir, 'splits');
      const trackedSplit = writeSplitManifest(
        path.join(splitsDir, 'tracked.gold.json'),
        'hash-current',
        'partition-current',
      );
      const baselinePath = writeBaseline(dir, 'hash-current');
      // The artifact carries no split fingerprint: the run cannot be shown to
      // have been measured against the tracked split.
      const reportPath = writeReportWithoutSplitFingerprint(dir, 0.5, {
        alpha: 0.5,
        beta: 0.5,
      });

      const result = runBin([
        'benchmark',
        'gate',
        '--suite',
        'synthetic',
        '--model-id',
        'demo',
        '--metrics',
        reportPath,
        '--baseline',
        baselinePath,
        '--split',
        trackedSplit,
      ]);

      const output = `${result.stdout}${result.stderr}`;
      expect(result.status).toBe(1);
      expect(output).toContain('gate failed');
      expect(output).toMatch(/cannot be attributed/i);
      expect(output).not.toContain('gate passed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes when the tracked split IS the split the baseline was measured against', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vision-lens-cli-gate-split-match-'));
    try {
      const splitsDir = path.join(dir, 'splits');
      const trackedSplit = writeSplitManifest(
        path.join(splitsDir, 'tracked.gold.json'),
        'hash-current',
        'partition-current',
      );
      const baselinePath = writeBaseline(dir, 'hash-current');
      // The RUN was measured against the tracked split too.
      const reportPath = writeReport(
        dir,
        0.5,
        { alpha: 0.5, beta: 0.5 },
        false,
        'hash-current',
      );

      const result = runBin([
        'benchmark',
        'gate',
        '--suite',
        'synthetic',
        '--model-id',
        'demo',
        '--metrics',
        reportPath,
        '--baseline',
        baselinePath,
        '--split',
        trackedSplit,
      ]);

      const output = `${result.stdout}${result.stderr}`;
      expect(result.status).toBe(0);
      expect(output).toContain('gate passed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the gate working when the tracked split is ABSENT', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vision-lens-cli-gate-split-absent-'));
    try {
      // A missing split is a skip of the split check, never a crash and never
      // a failure of the comparison.
      const baselinePath = writeBaseline(dir, 'hash-recorded');
      const reportPath = writeReport(dir, 0.5, { alpha: 0.5, beta: 0.5 });

      const result = runBin([
        'benchmark',
        'gate',
        '--suite',
        'synthetic',
        '--model-id',
        'demo',
        '--metrics',
        reportPath,
        '--baseline',
        baselinePath,
        '--split',
        path.join(dir, 'no-such-split.gold.json'),
      ]);

      const output = `${result.stdout}${result.stderr}`;
      expect(result.status).toBe(0);
      expect(output).toContain('gate passed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * The scorecard surface (spec 022, tasks 6.4 and 6.5).
 *
 * The behaviours a CI pipeline depends on:
 *
 *  - a missing split is a SKIP with the explicit `dataset=absent` marker and a
 *    zero exit code (never a failure, never a fabricated number);
 *  - a refused scorecard exits non-zero, names its error code and writes
 *    NOTHING: a refusal is not a zero-valued scorecard;
 *  - a produced scorecard carries the partition and the sample count on every
 *    metric, so a percentage without a count and a subset is not representable;
 *  - a scorecard is a regime: the gate refuses it against a whole-set
 *    baseline, through the real gate path.
 */
describe.skipIf(!BINS_BUILT)('vision-lens benchmark scorecard (requires built dist)', () => {
  const TRACKED_SPLIT = path.join(REPO_ROOT, 'benchmarks', 'splits', 'visa-subset.v2.gold.json');
  const TRACKED_PREDICTIONS = path.join(
    REPO_ROOT,
    'benchmarks',
    'predictions',
    'visa-subset.v2.gpt-4o.json',
  );
  const TRACKED_BASELINE = path.join(
    REPO_ROOT,
    'benchmarks',
    'baselines',
    'visa-subset.v2.json',
  );
  const MODEL_VERSION = 'model:gpt-4o@2024-11-20';

  /** The scorecard artifact the command wrote under the results directory. */
  function findScorecardArtifact(resultsDir: string): string {
    for (const entry of readdirSync(resultsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(resultsDir, entry.name, 'scorecard.json');
      if (existsSync(candidate)) return candidate;
    }
    throw new Error(`no scorecard artifact under ${resultsDir}`);
  }

  it('advertises the scorecard subcommand and its options', () => {
    const help = runBin(['benchmark', '--help']);
    expect(help.stdout).toContain('scorecard');
    expect(help.status).toBe(0);

    const scorecardHelp = runBin(['benchmark', 'scorecard', '--help']);
    const text = `${scorecardHelp.stdout}${scorecardHelp.stderr}`;
    expect(text).toContain('--calibration-partition');
    expect(text).toContain('--device');
    expect(text).toContain('--min-support');
    expect(text).toContain('--pointer-dir');
    expect(text).toContain('--model-version');
    expect(text).toContain('--config-fingerprint');
    expect(scorecardHelp.status).toBe(0);
  });

  it('refuses a scorecard without the model version', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vision-lens-cli-scorecard-noversion-'));
    try {
      const result = runBin([
        'benchmark',
        'scorecard',
        '--suite',
        'visa-subset.v2',
        '--model-id',
        'gpt-4o',
        '--config-fingerprint',
        'fp-test',
        '--pointer-dir',
        dir,
      ]);

      const output = `${result.stdout}${result.stderr}`;
      // The option is REQUIRED, not merely documented: the help text lists an
      // optional option and a required one the same way, so only the refusal
      // proves it.
      expect(result.status).not.toBe(0);
      expect(output).toContain('--model-version');
      expect(output).toContain('required option');
      // And the refusal wrote nothing: a refused scorecard is not an artifact.
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a scorecard without the config fingerprint', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vision-lens-cli-scorecard-nofingerprint-'));
    try {
      const result = runBin([
        'benchmark',
        'scorecard',
        '--suite',
        'visa-subset.v2',
        '--model-id',
        'gpt-4o',
        '--model-version',
        MODEL_VERSION,
        '--pointer-dir',
        dir,
      ]);

      const output = `${result.stdout}${result.stderr}`;
      expect(result.status).not.toBe(0);
      expect(output).toContain('--config-fingerprint');
      expect(output).toContain('required option');
      // And the refusal wrote nothing: a refused scorecard is not an artifact.
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips with the dataset marker when the split manifest is absent', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vision-lens-cli-scorecard-skip-'));
    try {
      const result = runBin([
        'benchmark',
        'scorecard',
        '--suite',
        'no-such-suite',
        '--model-id',
        'demo',
        '--predictions',
        path.join(dir, 'no-such-predictions.json'),
        '--config-fingerprint',
        'cfg-test',
        '--model-version',
        'model:demo@1',
        '--out',
        path.join(dir, 'results'),
        '--pointer-dir',
        dir,
      ]);

      const output = `${result.stdout}${result.stderr}`;
      expect(output).toContain('dataset=absent');
      expect(result.status).toBe(0);
      // A skip writes nothing: no pointer, no artifact, not even a results
      // directory.
      expect(existsSync(path.join(dir, 'no-such-suite.demo.json'))).toBe(false);
      expect(existsSync(path.join(dir, 'results'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses an empty selection with its code, exits non-zero and writes nothing', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vision-lens-cli-scorecard-empty-'));
    try {
      const splitPath = path.join(dir, 'empty.gold.json');
      const predictionsPath = path.join(dir, 'predictions.json');
      writeFileSync(predictionsPath, '[]\n');
      // A split whose `test` partition is empty: the scorecard refuses it
      // rather than emitting a zero-valued metric.
      const manifest = {
        schemaVersion: 2,
        id: 'empty-suite.gold',
        datasetId: 'visa-subset',
        seed: 42,
        ratios: { train: 1, val: 0, test: 0 },
        strata: [],
        assignments: [
          {
            id: 'alpha/anomalous/000',
            class: 'alpha',
            anomaly: 'anomalous',
            split: 'train',
            sha256: 'a'.repeat(64),
            path: 'alpha/anomalous/000.jpg',
          },
        ],
        notes: [],
        strategy: 'stratified',
        partitionFingerprint: 'f'.repeat(64),
      };
      writeFileSync(
        splitPath,
        `${JSON.stringify({
          ...manifest,
          manifestHash: computeManifestHash(manifest as never),
        })}\n`,
      );

      const result = runBin([
        'benchmark',
        'scorecard',
        '--suite',
        'empty-suite',
        '--model-id',
        'demo',
        '--split',
        splitPath,
        '--predictions',
        predictionsPath,
        '--config-fingerprint',
        'cfg-test',
        '--model-version',
        'model:demo@1',
        '--pointer-dir',
        dir,
      ]);

      const output = `${result.stdout}${result.stderr}`;
      expect(result.status).not.toBe(0);
      expect(output).toContain('test-partition-empty');
      // Nothing was written: a refusal is not an artifact.
      expect(existsSync(path.join(dir, 'empty-suite.demo.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a scorecard against a dataset the platform may not use', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vision-lens-cli-scorecard-gate-'));
    try {
      const splitPath = path.join(dir, 'research-only.gold.json');
      const predictionsPath = path.join(dir, 'predictions.json');
      writeFileSync(predictionsPath, '[]\n');
      // A split whose dataset is registered as research-only. The
      // constitutional gate refuses it before the scorecard is built: a
      // research-only dataset may be documented, never scored.
      const manifest = {
        schemaVersion: 2,
        id: 'research-only.gold',
        datasetId: 'mvtec-ad',
        seed: 42,
        ratios: { train: 1, val: 0, test: 0 },
        strata: [],
        assignments: [
          {
            id: 'alpha/anomalous/000',
            class: 'alpha',
            anomaly: 'anomalous',
            split: 'train',
            sha256: 'a'.repeat(64),
            path: 'alpha/anomalous/000.jpg',
          },
        ],
        notes: [],
        strategy: 'stratified',
        partitionFingerprint: 'f'.repeat(64),
      };
      writeFileSync(
        splitPath,
        `${JSON.stringify({
          ...manifest,
          manifestHash: computeManifestHash(manifest as never),
        })}\n`,
      );

      const result = runBin([
        'benchmark',
        'scorecard',
        '--suite',
        'research-suite',
        '--model-id',
        'demo',
        '--split',
        splitPath,
        '--predictions',
        predictionsPath,
        '--config-fingerprint',
        'cfg-test',
        '--model-version',
        'model:demo@1',
        '--pointer-dir',
        dir,
      ]);

      const output = `${result.stdout}${result.stderr}`;
      expect(result.status).not.toBe(0);
      // The refusal is named, and it is the constitutional one, not a
      // scorecard code: the gate refused the dataset.
      expect(output).toContain('dataset-not-usable');
      expect(output).toContain('research-only');
      // Nothing was written: a refusal is not an artifact.
      expect(existsSync(path.join(dir, 'research-suite.demo.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('produces a scorecard whose every metric carries its partition and count', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vision-lens-cli-scorecard-ok-'));
    try {
      const result = runBin([
        'benchmark',
        'scorecard',
        '--suite',
        'visa-subset.v2',
        '--model-id',
        'gpt-4o',
        '--split',
        TRACKED_SPLIT,
        '--predictions',
        TRACKED_PREDICTIONS,
        '--config-fingerprint',
        'fp-test',
        '--model-version',
        MODEL_VERSION,
        '--out',
        path.join(dir, 'results'),
        '--pointer-dir',
        path.join(dir, 'pointers'),
      ]);

      const output = `${result.stdout}${result.stderr}`;
      expect(result.status).toBe(0);

      const pointerPath = path.join(dir, 'pointers', 'visa-subset.v2.gpt-4o.json');
      expect(existsSync(pointerPath)).toBe(true);
      const pointer = JSON.parse(readFileSync(pointerPath, 'utf8')) as {
        readonly scorecardSha256: string;
        readonly artifactRefs: readonly { readonly role: string; readonly sha256: string }[];
      };
      expect(pointer.scorecardSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(pointer.artifactRefs.map((ref) => ref.role)).toEqual(['per-sample', 'scorecard']);

      const scorecardPath = findScorecardArtifact(path.join(dir, 'results'));
      expect(existsSync(scorecardPath)).toBe(true);
      const scorecard = JSON.parse(readFileSync(scorecardPath, 'utf8')) as {
        readonly split: { readonly evaluatedPartition: string };
        readonly metrics: readonly {
          readonly name: string;
          readonly value: number;
          readonly n: number;
          readonly partition: string;
        }[];
      };

      // The scorecard measures the held-out partition, and only it. The count
      // is READ from the tracked split, not written here: a split that
      // changes its test partition must move the assertion with it, or the
      // test breaks without saying what changed.
      const trackedSplit = JSON.parse(readFileSync(TRACKED_SPLIT, 'utf8')) as {
        readonly assignments: readonly { readonly split: string }[];
      };
      const testItems = trackedSplit.assignments.filter(
        (assignment) => assignment.split === 'test',
      ).length;
      expect(testItems).toBeGreaterThan(0);
      expect(scorecard.split.evaluatedPartition).toBe('test');
      expect(scorecard.metrics.length).toBeGreaterThan(0);
      for (const metric of scorecard.metrics) {
        expect(metric.n).toBe(testItems);
        expect(metric.partition).toBe('test');
        expect(Number.isFinite(metric.value)).toBe(true);
      }
      expect(output).toContain('partition: test');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a scorecard against a whole-set baseline through the real gate path', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vision-lens-cli-scorecard-regime-'));
    try {
      const result = runBin([
        'benchmark',
        'scorecard',
        '--suite',
        'visa-subset.v2',
        '--model-id',
        'gpt-4o',
        '--split',
        TRACKED_SPLIT,
        '--predictions',
        TRACKED_PREDICTIONS,
        '--config-fingerprint',
        'fp-test',
        '--model-version',
        MODEL_VERSION,
        '--out',
        path.join(dir, 'results'),
        '--pointer-dir',
        path.join(dir, 'pointers'),
      ]);
      expect(result.status).toBe(0);

      const scorecardPath = findScorecardArtifact(path.join(dir, 'results'));
      const scorecard = JSON.parse(readFileSync(scorecardPath, 'utf8')) as Scorecard;

      // The REAL gate path: the tracked whole-set baseline carries no regime,
      // so comparing it with a test-partition scorecard must be refused and
      // both regimes must be named. The metrics are placeholders on purpose:
      // the gate refuses on the regime BEFORE any number is compared, which
      // is the property under test.
      const gate = evaluateGate({
        suite: 'visa-subset.v2',
        model: 'gpt-4o',
        modelVersion: MODEL_VERSION,
        metrics: {
          itemsScored: 0,
          correct: 0,
          accuracy: 0,
          perClass: [],
          macroF1: 0,
          balancedAccuracy: 0,
        } as unknown as Parameters<typeof evaluateGate>[0]['metrics'],
        scorecard,
        baselinePath: TRACKED_BASELINE,
        currentSplitPath: TRACKED_SPLIT,
        attribution: {
          snapshotId: scorecard.snapshotId,
          splitFingerprint: scorecard.manifestSha256,
          configFingerprint: scorecard.configFingerprint,
        },
      });

      expect(gate.passed).toBe(false);
      expect(gate.reason).toContain('baseline-regime-mismatch');
      expect(gate.reason).toContain('test-partition');
      expect(gate.reason).toContain('whole-set');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
