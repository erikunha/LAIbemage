/**
 * Normalise the staged VisA subset into the Master Vision store
 * (spec 003, US1 / task 1.3).
 *
 * ## One place for the mapping
 *
 * The VisA → 002 mapping itself lives in
 * `packages/core/src/benchmark/normalize.ts` — this script is only the
 * command line around it. There is exactly one implementation of the mapping,
 * and the same code path is what the tests exercise.
 *
 * ```bash
 * pnpm tsx scripts/datasets/normalize-visa.ts
 * pnpm tsx scripts/datasets/normalize-visa.ts --parts candle,capsules --db ./bench.db
 * ```
 *
 * ## What it prints
 *
 * The per-class counts (the spec's US1.3) plus the anomalies the run found —
 * the images without a label, the annotation rows without an image, and the
 * labels that did not match the dataset taxonomy. Those three lists are the
 * honest report of what the ground truth did not cover; none of them is
 * silently swallowed.
 *
 * Re-running the script is safe: the normalisation upserts (see
 * `packages/core/src/benchmark/normalize.ts`), so no row is duplicated.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DATASETS_DIR_ENV,
  VISA_SUBSET_ID,
  resolveDatasetsDir,
} from '../../packages/core/src/benchmark/dataset-availability.js';
import {
  DEFAULT_SUBSET_TARGET_IMAGES,
  normalizeVisaSubset,
} from '../../packages/core/src/benchmark/normalize.js';
import {
  assertDatasetUsable,
  findDataset,
  loadDatasetRegistry,
} from '../../packages/core/src/benchmark/registry.js';
import { defaultStorePath, openMigratedStore } from '../../packages/core/src/store/index.js';

/** The repository root (this file lives in `<repo>/scripts/datasets/`). */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The tracked registry of datasets. */
const REGISTRY_PATH = path.join(REPO_ROOT, 'datasets', 'registry.json');

/** The options of one normalisation run. */
export interface NormalizeCliOptions {
  /** The datasets directory holding the staged subset. */
  readonly datasetsDir?: string;
  /** The store to write into. */
  readonly dbPath?: string;
  /** The object classes to normalise. */
  readonly parts?: readonly string[];
  /** The target number of images in the subset. */
  readonly targetImages?: number;
}

/**
 * Runs the normalisation and returns the report.
 *
 * @throws {Error} when the dataset has no license, the subset is not staged,
 *   or the store cannot be opened.
 */
export async function runNormalize(options: NormalizeCliOptions = {}) {
  const datasetsDir = options.datasetsDir ?? resolveDatasetsDir();
  const dbPath = options.dbPath ?? defaultStorePath();

  const registry = await loadDatasetRegistry(REGISTRY_PATH);
  const entry = findDataset(registry, VISA_SUBSET_ID);
  // The constitutional gate: no license, no use.
  assertDatasetUsable(entry);

  const subsetDir = path.join(datasetsDir, VISA_SUBSET_ID);
  if (!(await existsDirectory(subsetDir))) {
    throw new Error(
      `The VisA subset is not staged in '${subsetDir}'. ` +
        'Run the fetch first: pnpm tsx scripts/datasets/fetch-visa.ts',
    );
  }
  const visaRoot = (await existsDirectory(path.join(subsetDir, 'VisA')))
    ? path.join(subsetDir, 'VisA')
    : subsetDir;

  const store = await openMigratedStore(dbPath);
  try {
    const report = await normalizeVisaSubset({
      db: store.db,
      visaRoot,
      parts: options.parts,
      targetImages: options.targetImages ?? DEFAULT_SUBSET_TARGET_IMAGES,
      dataset: {
        id: entry.id,
        version: entry.version,
        license: entry.license,
        attribution: entry.attribution,
      },
    });
    return { report, dbPath, subsetDir };
  } finally {
    store.close();
  }
}

/** Whether a path is a directory. */
async function existsDirectory(target: string): Promise<boolean> {
  const { stat } = await import('node:fs/promises');
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/** Prints the report of a normalisation run. */
export function printReport(report: Awaited<ReturnType<typeof runNormalize>>['report']): void {
  const lines: string[] = [];
  lines.push(`Normalised ${report.normalizedSamples.length} images of ${report.parts.join(', ')}`);
  lines.push(`  ontology version: ${report.ontologyVersionId} (${report.ontologyFingerprint})`);
  lines.push(`  capture sessions: ${report.captureSessions}`);
  lines.push(`  assets: ${report.assets}`);
  lines.push(`  samples: ${report.samples}`);
  lines.push(`  annotations: ${report.annotations}`);
  lines.push('');
  lines.push('Per-class counts:');
  for (const [key, count] of Object.entries(report.countsByKey).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  ${key}: ${count}`);
  }
  lines.push('');
  lines.push('Per object class:');
  for (const [part, count] of Object.entries(report.countsByPart).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  ${part}: ${count}`);
  }

  if (report.unmappedLabels.length > 0) {
    lines.push('');
    lines.push(`Labels outside the dataset taxonomy (preserved, not dropped): ${report.unmappedLabels.length}`);
    for (const { raw, key } of report.unmappedLabels) {
      lines.push(`  "${raw}" → ${key}`);
    }
  }
  if (report.unlabeledImages.length > 0) {
    lines.push('');
    lines.push(`Images without an annotation row (${report.unlabeledImages.length}):`);
    for (const image of report.unlabeledImages.slice(0, 20)) {
      lines.push(`  ${image}`);
    }
  }
  if (report.danglingAnnotations.length > 0) {
    lines.push('');
    lines.push(`Annotation rows without an image (${report.danglingAnnotations.length}):`);
    for (const image of report.danglingAnnotations.slice(0, 20)) {
      lines.push(`  ${image}`);
    }
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

/** Parses the command line of the script. */
export function parseArgs(argv: readonly string[]): NormalizeCliOptions {
  let datasetsDir: string | undefined;
  let dbPath: string | undefined;
  let parts: string[] | undefined;
  let targetImages: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--datasets-dir': {
        const value = argv[index + 1];
        if (!value) throw new Error('--datasets-dir needs a path');
        datasetsDir = path.resolve(value);
        index += 1;
        break;
      }
      case '--db': {
        const value = argv[index + 1];
        if (!value) throw new Error('--db needs a path');
        dbPath = path.resolve(value);
        index += 1;
        break;
      }
      case '--parts': {
        const value = argv[index + 1];
        if (!value) throw new Error('--parts needs a comma-separated list of object classes');
        parts = value
          .split(',')
          .map((part) => part.trim())
          .filter((part) => part.length > 0);
        index += 1;
        break;
      }
      case '--target-images': {
        const value = argv[index + 1];
        const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error('--target-images needs a positive number');
        }
        targetImages = parsed;
        index += 1;
        break;
      }
      default:
        throw new Error(`Unknown argument '${arg}'`);
    }
  }
  return { datasetsDir, dbPath, parts, targetImages };
}

/** The command-line entry point. */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { report, dbPath } = await runNormalize(args);
  printReport(report);
  process.stdout.write(`\nStore: ${dbPath}\n`);
  const datasetsDirLabel = args.datasetsDir ?? resolveDatasetsDir();
  process.stdout.write(`Datasets directory: ${datasetsDirLabel}\n`);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
