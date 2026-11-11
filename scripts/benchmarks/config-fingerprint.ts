/**
 * The config fingerprint of a benchmark run — the operator's command.
 *
 * ## What it prints
 *
 * EXACTLY ONE line on stdout: the fingerprint (`fp2:<16 hex>`). It can be
 * piped straight into the benchmark command:
 *
 * ```bash
 * pnpm exec tsx scripts/benchmarks/config-fingerprint.ts \
 *   --split benchmarks/splits/visa-subset.gold.json \
 *   --provider openai --model gpt-4o --model-version 2024-11-20 \
 *   > /tmp/fp.txt
 *
 * pnpm exec tsx packages/cli/src/index.ts benchmark run \
 *   --suite visa-subset --model-id gpt-4o \
 *   --model-version 'model:gpt-4o@2024-11-20' \
 *   --config-fingerprint "$(cat /tmp/fp.txt)" \
 *   ...
 * ```
 *
 * Everything else (the components that were hashed) goes to stderr, so the
 * stdout stream stays a single clean value.
 *
 * ## Why the fingerprint is computed, not typed
 *
 * ADR-008 forbids unattributed reports. A free-text `--config-fingerprint`
 * is an attribution the operator can get wrong: the same string for two
 * different taxonomies would make two different experiments look identical.
 * Here the fingerprint is DERIVED from the gold manifest, the model and the
 * dataset version, so it cannot claim a vocabulary the run never used.
 *
 * ```bash
 * pnpm exec tsx scripts/benchmarks/config-fingerprint.ts --help
 * ```
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  computeConfigFingerprint,
  DEFAULT_BENCHMARK_BATCH_SIZE,
} from '../../packages/core/src/benchmark/config-fingerprint.js';
import { findDataset, loadDatasetRegistry } from '../../packages/core/src/benchmark/registry.js';
import type { SplitManifest } from '../../packages/core/src/benchmark/splits.js';

/** The repository root (this file lives in `<repo>/scripts/benchmarks/`). */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The tracked registry of datasets. */
const REGISTRY_PATH = path.join(REPO_ROOT, 'datasets', 'registry.json');

const USAGE = `Usage:
  tsx scripts/benchmarks/config-fingerprint.ts --split <manifest> [options]

Options:
  --split <file>          the gold split manifest (required)
  --provider <name>       the provider that served the model (default: openai)
  --model <name>          the model id (default: the provider's default model)
  --model-version <ver>   the version (bare '2024-11-20' or 'model:gpt-4o@2024-11-20')
  --batch-size <n>        images per LLM call (default: ${DEFAULT_BENCHMARK_BATCH_SIZE})
  --out <file>            also write the fingerprint and its components as JSON

Prints the fingerprint on stdout (one line) and the components on stderr.
`;

/** The default model of a provider, mirroring the analyzer's own defaults. */
const DEFAULT_MODEL: Readonly<Record<string, string>> = {
  openai: 'gpt-4o',
  anthropic: 'claude-opus-4-7',
  google: 'gemini-2.0-flash',
  azure: 'gpt-4o',
  ollama: 'llava',
  hybrid: 'llava',
  bedrock: 'anthropic.claude-opus-4-7-20250514-v1:0',
  vertex: 'gemini-2.0-flash',
};

/**
 * The versioned model string the benchmark tuple requires.
 *
 * A bare version (`2024-11-20`) is completed with the model name; a string
 * that already carries the `model:` prefix is used as it is.
 */
export function formatModelVersion(model: string, version: string): string {
  if (version.startsWith('model:')) return version;
  return `model:${model}@${version}`;
}

/** Reads the gold manifest, failing loudly when it cannot be read. */
function readManifest(splitPath: string): SplitManifest {
  let raw: string;
  try {
    raw = readFileSync(splitPath, 'utf8');
  } catch (error) {
    throw new Error(
      `cannot read the gold manifest '${splitPath}': ${
        error instanceof Error ? error.message : String(error)
      }.`,
    );
  }
  try {
    return JSON.parse(raw) as SplitManifest;
  } catch (error) {
    throw new Error(
      `the gold manifest '${splitPath}' is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }.`,
    );
  }
}

/** The options of one fingerprint run. */
export interface FingerprintCliOptions {
  readonly splitPath: string;
  readonly provider: string;
  readonly model?: string;
  readonly modelVersion?: string;
  readonly batchSize?: number;
  readonly outPath?: string;
}

/**
 * Computes the fingerprint of a benchmark run.
 *
 * @throws when the manifest cannot be read, or when the dataset it belongs to
 *   is unknown to the registry — a fingerprint of an unknown data version
 *   would be an attribution of nothing.
 */
export async function runFingerprint(options: FingerprintCliOptions): Promise<string> {
  const manifest = readManifest(options.splitPath);
  const provider = options.provider;
  const model = options.model ?? DEFAULT_MODEL[provider] ?? 'gpt-4o';
  const modelVersion = formatModelVersion(
    model,
    options.modelVersion ?? 'unknown',
  );

  const registry = await loadDatasetRegistry(REGISTRY_PATH);
  // `findDataset` throws when the id is unknown — the registry is the only
  // source of the dataset's version, and a fingerprint of an unknown data
  // version would attribute the run to nothing.
  const dataset = findDataset(registry, manifest.datasetId);

  const result = computeConfigFingerprint({
    manifest,
    provider,
    model,
    modelVersion,
    dataVersion: `${dataset.id}@${dataset.version}`,
    ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
  });

  if (options.outPath !== undefined) {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(path.dirname(path.resolve(options.outPath)), { recursive: true });
    writeFileSync(
      path.resolve(options.outPath),
      `${JSON.stringify({ fingerprint: result.fingerprint, components: result.components }, null, 2)}\n`,
      'utf8',
    );
  }

  process.stderr.write(
    `config fingerprint components:\n${JSON.stringify(result.components, null, 2)}\n`,
  );

  return result.fingerprint;
}

/** The command-line entry point. */
export async function main(argv: readonly string[]): Promise<void> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      split: { type: 'string' },
      provider: { type: 'string', default: 'openai' },
      model: { type: 'string' },
      'model-version': { type: 'string' },
      'batch-size': { type: 'string' },
      out: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });

  if (values.help === true) {
    process.stdout.write(USAGE);
    return;
  }
  if (values.split === undefined) {
    process.stderr.write(USAGE);
    process.exitCode = 1;
    return;
  }

  const batchSize = values['batch-size'];
  const fingerprint = await runFingerprint({
    splitPath: path.resolve(values.split),
    provider: values.provider ?? 'openai',
    ...(values.model === undefined ? {} : { model: values.model }),
    ...(values['model-version'] === undefined
      ? {}
      : { modelVersion: values['model-version'] }),
    ...(batchSize === undefined
      ? {}
      : { batchSize: Number.parseInt(batchSize, 10) }),
    ...(values.out === undefined ? {} : { outPath: values.out }),
  });

  // The fingerprint is the ONLY thing on stdout.
  process.stdout.write(`${fingerprint}\n`);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
