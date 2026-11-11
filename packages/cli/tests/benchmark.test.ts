import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

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

interface BinResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number;
}

function runBin(args: string[]): BinResult {
  const result = spawnSync(process.execPath, [INDEX_BIN, ...args], {
    encoding: 'utf8',
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
function writeReport(dir: string, macroF1: number, perClass: Record<string, number>, partial = false): string {
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
          splitFingerprint: 'def',
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
});
