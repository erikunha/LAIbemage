/**
 * The out-of-band verification of the committed scorecard pointer (spec 022,
 * task 8.3).
 *
 * A pointer in `benchmarks/scorecards/` is the published claim over artifacts
 * that are gitignored. This script rebuilds the scorecard from the COMMITTED
 * FIXTURE, writes the artifacts, and checks that the committed pointer names
 * exactly those artifacts: the same digests, the same byte counts, the same
 * row counts and the same scorecard id. A fixture that changed, or a pointer
 * that was edited by hand, fails here.
 *
 * The verification goes through the shipped {@link verifyScorecardArtifacts},
 * which re-reads every artifact from disk and recomputes its digest: the
 * check reads the artifacts back, it does not trust the values the writer
 * held in memory.
 *
 * In verification mode the script NEVER writes the committed pointer: the
 * freshly computed pointer is written to a scratch file and COMPARED with the
 * committed one, field by field. A script that rewrote the pointer it then
 * verified could never fail, and a green run would prove nothing.
 *
 * ```bash
 * # verify the committed pointer (what CI runs):
 * pnpm exec tsx scripts/benchmarks/verify-scorecard-pointer.ts
 *
 * # rewrite it after an INTENDED change to the fixture:
 * pnpm exec tsx scripts/benchmarks/verify-scorecard-pointer.ts --write
 * ```
 *
 * The oracle is a synthetic fixture of the MECHANISM, not a measurement of a
 * model. Its numbers are the oracle's own: the expected values in the
 * fixture were computed by an enumeration that shares no code with the metric
 * modules, and the oracle suite recomputes them by brute force over the
 * fixture's own lists, so a reader can check them
 * (`packages/core/tests/benchmark/scorecard-oracle.test.ts`).
 */

import { readFileSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { PredictionItem } from '../../packages/core/src/benchmark/metrics.js';
import { computeManifestHash, type SplitManifest } from '../../packages/core/src/benchmark/splits.js';
import {
  buildScorecard,
  defaultScorecardPointerPath,
  verifyScorecardArtifacts,
  writeScorecardArtifacts,
} from '../../packages/core/src/benchmark/scorecard.js';
import type { DatasetRegistryEntry } from '../../packages/core/src/benchmark/registry.js';
import type { ReproductionTuple } from '../../packages/core/src/benchmark/runner.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE_PATH = path.join(
  REPO_ROOT,
  'packages',
  'core',
  'tests',
  'benchmark',
  'fixtures',
  'scorecard-oracle.json',
);

const SUITE = 'scorecard-oracle';
const MODEL = 'oracle-model';
const POINTER_PATH = defaultScorecardPointerPath(SUITE, MODEL);

/** The instant the oracle scorecard is stamped with. Never the wall clock. */
const NOW = new Date('2026-11-11T00:00:00.000Z');

interface OracleFixture {
  readonly manifest: Omit<SplitManifest, 'manifestHash'>;
  readonly predictions: readonly PredictionItem[];
}

/** The registry entry of the oracle, identical to the one the oracle suite uses. */
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
  parts: { selected: ['alpha', 'beta', 'gamma', 'delta'], rationale: 'the oracle strata' },
  sha256: null,
  sha256PinnedAt: null,
  attribution: 'Synthetic oracle fixture; no external data.',
  fetchedAt: null,
  notes: 'Synthetic fixture of the scorecard oracle suite.',
};

const TUPLE: ReproductionTuple = {
  snapshotId: 'oracle-snapshot-0001',
  splitFingerprint: 'PLACEHOLDER',
  modelVersion: 'model:oracle@1.0.0',
  configFingerprint: 'fp2:oracle00000001',
  env: { nodeVersion: 'v24.0.0', platform: 'darwin', arch: 'arm64' },
};

/**
 * The fields of two pointers that differ, as `path: committed vs recomputed`.
 *
 * An empty list means the two pointers are the same claim.
 */
function pointerDifferences(committed: unknown, recomputed: unknown, prefix = ''): string[] {
  if (Array.isArray(committed) && Array.isArray(recomputed)) {
    if (committed.length !== recomputed.length) {
      return [`${prefix || '(root)'}: ${committed.length} entries vs ${recomputed.length}`];
    }
    return committed.flatMap((entry, index) =>
      pointerDifferences(entry, recomputed[index], `${prefix}[${index}]`),
    );
  }
  if (
    committed !== null &&
    recomputed !== null &&
    typeof committed === 'object' &&
    typeof recomputed === 'object'
  ) {
    const left = committed as Record<string, unknown>;
    const right = recomputed as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    return keys.flatMap((key) =>
      pointerDifferences(left[key], right[key], prefix === '' ? key : `${prefix}.${key}`),
    );
  }
  if (committed !== recomputed) {
    return [`${prefix || '(root)'}: ${JSON.stringify(committed)} vs ${JSON.stringify(recomputed)}`];
  }
  return [];
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      write: { type: 'boolean', default: false },
    },
  });

  // The recorded artifact paths are relative to the repository root, so the
  // script runs from it: a pointer must never carry a machine path.
  process.chdir(REPO_ROOT);

  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as OracleFixture;
  const manifest: SplitManifest = {
    ...fixture.manifest,
    manifestHash: computeManifestHash(fixture.manifest),
  };
  const tuple: ReproductionTuple = {
    ...TUPLE,
    splitFingerprint: manifest.manifestHash,
  };

  const built = buildScorecard({
    suite: SUITE,
    model: MODEL,
    tuple,
    splitManifest: manifest,
    predictions: fixture.predictions,
    datasetEntry: DATASET_ENTRY,
    resamples: 200,
    now: NOW,
  });
  if (!built.ok) {
    console.error(`scorecard refused: ${built.error.code}`);
    console.error(built.error.message);
    return 1;
  }

  // The scratch directory holds the freshly computed pointer. The committed
  // pointer is written ONLY in `--write` mode, and never in verification mode.
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'visionlens-scorecard-'));
  const scratchPointer = path.join(scratch, 'pointer.json');
  try {
    const written = await writeScorecardArtifacts({
      scorecard: built.scorecard,
      splitManifest: manifest,
      predictions: fixture.predictions,
      pointerPath: scratchPointer,
      reproduce: {
        command: 'pnpm exec tsx scripts/benchmarks/verify-scorecard-pointer.ts --write',
        note:
          'the oracle pointer is rebuilt from the committed fixture; the artifacts are ' +
          'gitignored and the digests above are the published claim',
      },
    });
    if (!written.ok) {
      console.error(`artifacts refused: ${written.error.code}`);
      console.error(written.error.message);
      return 1;
    }

    const committedPath = path.join(REPO_ROOT, POINTER_PATH);

    if (values.write) {
      await copyFile(scratchPointer, committedPath);
      console.log(`pointer written: ${POINTER_PATH}`);
      console.log(`scorecard id: ${written.scorecardWithRefs.scorecardId}`);
      console.log(`scorecard sha256: ${written.scorecardSha256}`);
      return 0;
    }

    // 1. The committed pointer must BE the pointer the fixture produces. This
    //    is the comparison that fails when the fixture changed or when the
    //    committed pointer was edited by hand.
    let committed: unknown;
    try {
      committed = JSON.parse(await readFile(committedPath, 'utf8'));
    } catch (error) {
      console.error(`the committed pointer '${POINTER_PATH}' cannot be read`);
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
    const recomputed = JSON.parse(await readFile(scratchPointer, 'utf8')) as unknown;
    const differences = pointerDifferences(committed, recomputed);
    if (differences.length > 0) {
      console.error(`the committed pointer '${POINTER_PATH}' does not match the fixture:`);
      for (const difference of differences) {
        console.error(`  ${difference}`);
      }
      return 1;
    }

    // 2. The committed pointer must still describe the artifacts on disk: the
    //    digests are recomputed from the bytes.
    const verification = await verifyScorecardArtifacts(committedPath, { root: REPO_ROOT });
    if (!verification.ok) {
      console.error(`pointer verification failed: ${verification.error.code}`);
      console.error(verification.error.message);
      return 1;
    }

    console.log(`pointer verified: ${POINTER_PATH}`);
    console.log(`scorecard id: ${verification.scorecardId}`);
    for (const ref of verification.refs) {
      console.log(`  ${ref.role}: ${ref.sha256} (${ref.bytes} bytes, ${ref.rows} rows)`);
    }
    return 0;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

process.exit(await main());
