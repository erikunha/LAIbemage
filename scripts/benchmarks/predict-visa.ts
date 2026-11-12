/**
 * Real predictions for the benchmark — an LLM over a gold split.
 *
 * `scripts/benchmarks/make-fixture-predictions.ts` fabricates its predictions
 * from the ground truth with a seeded error rate. That file is a PLUMBING
 * FIXTURE: it proves the split → score → gate flow works without a provider.
 * It is NOT a measurement and must never produce a baseline.
 *
 * This script is the other half: it runs a REAL model over the images of a
 * gold split and writes what the model actually predicted, in the shape the
 * benchmark scores (`PredictionItem`, `packages/core/src/benchmark/metrics.ts`).
 *
 * ```bash
 * # a real baseline over the VisA gold split:
 * pnpm exec tsx scripts/benchmarks/predict-visa.ts \
 *   --split benchmarks/splits/visa-subset.gold.json \
 *   --root datasets/visa-subset \
 *   --out benchmarks/predictions/visa-subset.gpt-4o.json \
 *   --provider openai --model gpt-4o --model-version 2024-11-20 --api-key "$OPENAI_API_KEY" \
 *   --max-usd-micro 750000
 *
 * # then score it:
 * node packages/cli/dist/index.js benchmark run \
 *   --suite visa-subset --model-id gpt-4o \
 *   --model-version model:gpt-4o@2024-11-20 \
 *   --config-fingerprint <hash> \
 *   --predictions benchmarks/predictions/visa-subset.gpt-4o.json
 * ```
 *
 * ## What it does
 *
 *  1. reads the gold manifest (`--split`);
 *  2. resolves every image as `<root>/<assignment.path>` and fails loudly when
 *     one is missing — a run over a partial dataset is not a baseline;
 *  3. builds a TAXONOMY from the gold vocabulary (`normal` and
 *     `defect:<object class>`) and hands it to the analyzer as the
 *     `categories.json` of the run. The model is therefore asked to classify
 *     into the ANOMALY vocabulary of the benchmark, not into semantic
 *     categories such as "kitchen";
 *  4. runs `analyzeBatch` over the images (the real analyzer: the real
 *     prompts, the real image pipeline, the real client);
 *  5. writes one prediction row per gold assignment.
 *
 * ## The taxonomy names are not the label keys
 *
 * A gold label key is `defect:capsules` — a colon, which the config schema
 * rejects (category names are `lowercase_snake_case`). The analyzer also
 * normalises every category the model returns (`normalizeCategory`), which
 * turns `defect:capsules` into `defect_capsules`. The taxonomy therefore uses
 * the NORMALISED name (`defect_capsules`) and the script maps it back to the
 * gold label key (`defect:capsules`) through an explicit table built from the
 * manifest — never by re-parsing the name.
 *
 * ## Latency and cost
 *
 *  - `latencyMs` is the wall-clock of the LLM call that produced the image's
 *    result. The analyzer calls the provider once per BATCH, so the batch's
 *    call duration is attributed to every image of that batch (documented
 *    here rather than silently averaged).
 *  - `costUsd` is recorded ONLY when the price of the exact model is pinned in
 *    `packages/core/src/utils/cost.ts` (`PROVIDER_PRICING`). The batch's token
 *    counts are real; the price table is per provider and per DEFAULT model,
 *    so an unlisted model has no honest price and the field is OMITTED. An
 *    omitted cost is better than a fabricated one.
 *  - `--max-usd-micro <n>` optionally caps what the run may spend, in
 *    micro-USD (`750000` is 0.75 USD). Without the flag NO ceiling is
 *    enforced, exactly as before. With it, the run REFUSES before the first
 *    provider call when the pinned estimate (`estimateCost`) already exceeds
 *    the ceiling, and ABORTS when the observed spend of the answered calls
 *    crosses it mid-run. Both throw a typed `BudgetExceededError` naming the
 *    estimate or the partial spend, the ceiling and the provider, and neither
 *    writes a prediction file: a partial prediction set is never published.
 *    A ceiling of `0` refuses any run whose estimate is above 0, which is the
 *    zero-budget rule of the worker protocol (`maxUsdMicro`): no paid calls.
 *    The estimate is priced at the provider's PINNED model; mid-run tracking,
 *    like `costUsd`, needs the run's own model to be pinned, so an unlisted
 *    model passes the estimate gate but its observed spend cannot be tracked.
 *
 * ## `probability`
 *
 * `probability` is the model's own reported confidence (`AnalysisResult.
 * confidence`). The metrics module documents that it expects a CALIBRATED
 * probability; the self-declared confidence is what the provider gives us
 * here, and the runner's calibration pass (`benchmark/calibration.ts`) is
 * where it is turned into a calibration curve.
 *
 * ## The testability seam
 *
 * {@link PredictOptions.client} injects an `LLMClient`. The test suite runs
 * the whole script against the synthetic fixture with a fake client — no
 * network, no key, no provider.
 */

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { analyzeBatch } from '../../packages/core/src/analyzer/batch.js';
import type {
  CompleteOptions,
  CompleteResult,
  ImageInput,
  LLMClient,
} from '../../packages/core/src/analyzer/client.js';
import type { PredictionItem } from '../../packages/core/src/benchmark/metrics.js';
import { buildTaxonomy } from '../../packages/core/src/benchmark/taxonomy.js';
import type { SplitAssignment, SplitManifest } from '../../packages/core/src/benchmark/splits.js';
import {
  loadConfig,
  type Config,
  type LLMProvider,
  type RawCliOptions,
} from '../../packages/core/src/config/index.js';
import type { AnalysisResult, FileWithStats } from '../../packages/core/src/types.js';
import { estimateCost, PROVIDER_PRICING } from '../../packages/core/src/utils/cost.js';
import { getImageTimestamp } from '../../packages/core/src/utils/exif.js';
import { configureLogger, logger } from '../../packages/core/src/utils/logger.js';

/** The providers `loadConfig` accepts. */
const PROVIDERS: readonly LLMProvider[] = [
  'openai',
  'anthropic',
  'google',
  'azure',
  'ollama',
  'hybrid',
  'bedrock',
  'vertex',
];

/** The default number of images per LLM call. */
const DEFAULT_BATCH_SIZE = 20;

// The taxonomy (the vocabulary the model is offered) lives in the core
// benchmark module: the prediction run and the config fingerprint must offer
// the model the EXACT same vocabulary, and two implementations would let a
// fingerprint describe a taxonomy the run never used.
export {
  buildTaxonomy,
  labelKeyOf,
  taxonomyNameOf,
  type Taxonomy,
  type TaxonomyCategory,
  type TaxonomyDocument,
} from '../../packages/core/src/benchmark/taxonomy.js';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** The options of {@link buildPredictionItems}. */
export interface PredictionRowOptions {
  /** The gold assignments, in the order the results are in. */
  readonly assignments: readonly SplitAssignment[];
  /** The analyzer's results — one per assignment, in the same order. */
  readonly results: readonly AnalysisResult[];
  /** The taxonomy name → label key table. */
  readonly labelKeyByName: ReadonlyMap<string, string>;
  /** The latency attributed to each result, if it was measured. */
  readonly latencyMs?: readonly (number | undefined)[];
  /** The cost attributed to each result, if it is known. */
  readonly costUsd?: readonly (number | undefined)[];
}

/**
 * Whether a result is the analyzer's padding for a batch that FAILED.
 *
 * When a provider call fails for good, the analyzer pads the batch with
 * `unknown` / confidence 0 / "unanalyzed image" and carries on — the CLI's
 * sweep wants the other images to survive. A benchmark run wants the opposite:
 * a batch the provider never answered is a MISSING MEASUREMENT, and writing
 * it as an ordinary prediction would turn an outage into a score.
 *
 * The marker is the analyzer's own padding literal
 * (`packages/core/src/analyzer/batch.ts`); a model that REFUSES to classify
 * an image answers `unknown` with a real description and a real confidence,
 * and that answer is recorded verbatim — it is a measurement.
 */
export function isAnalyzerFailure(result: AnalysisResult): boolean {
  return (
    result.category === 'unknown' &&
    result.confidence === 0 &&
    result.shortDescription === 'unanalyzed image'
  );
}

/**
 * Turns the analyzer's results into the prediction rows the benchmark scores.
 *
 * The model's answer is recorded AS GIVEN — a wrong answer is a wrong
 * prediction, never a corrected one. That includes an answer OUTSIDE the
 * gold vocabulary: the analyzer's prompt lets the model answer `unknown` (or
 * invent a category) when it cannot place the image, and that is a
 * measurement, not a broken run. The runner's contract says so too: a
 * prediction's label key "may be outside the gold vocabulary", and such an
 * answer is scored as the miss it is.
 *
 * Mapping an unknown answer onto one of the gold classes would be inventing
 * a classification the model never made — and it would flatter the score of
 * exactly the images the model could not classify.
 *
 * @throws when the analyzer returned a different number of results than there
 *   are assignments — then the prediction file would not answer every gold
 *   item, and pairing results with assignments would be guesswork.
 */
export function buildPredictionItems(options: PredictionRowOptions): PredictionItem[] {
  const { assignments, results, labelKeyByName } = options;
  if (results.length !== assignments.length) {
    throw new Error(
      `the analyzer returned ${results.length} result(s) for ${assignments.length} image(s) — ` +
        'the prediction file would not answer every gold item.',
    );
  }

  return assignments.map((assignment, index) => {
    const result = results[index] as AnalysisResult;
    if (isAnalyzerFailure(result)) {
      throw new Error(
        `the provider failed for the batch that carries '${assignment.id}' — the analyzer ` +
          'padded it with unknown. A benchmark run over an incomplete measurement is not a ' +
          'baseline: no prediction file is written. Retry the run, or mark it partial.',
      );
    }
    // A category the taxonomy knows maps to its gold label key; a category it
    // does not know is recorded under its own (already normalised) name.
    const labelKey = labelKeyByName.get(result.category) ?? result.category;

    const latencyMs = options.latencyMs?.[index];
    const costUsd = options.costUsd?.[index];
    return {
      id: assignment.id,
      labelKey,
      probability: result.confidence,
      ...(latencyMs === undefined ? {} : { latencyMs }),
      ...(costUsd === undefined ? {} : { costUsd }),
    };
  });
}

/**
 * The file range a batch prompt covers: the zero-based index of its first
 * image and how many images it holds.
 *
 * The analyzer's user prompt names the range (`Image 7 to 26`), so the range
 * is read from the prompt instead of guessed from a counter — a counter drifts
 * when the provider call is retried, the prompt does not.
 *
 * @returns `null` when the prompt does not name a range (no latency is
 *   attributed to that batch — a guess would be a lie).
 */
export function parseBatchRange(prompt: string): { startIndex: number; count: number } | null {
  const range = /Image (\d+) to (?:Image )?(\d+)/.exec(prompt);
  if (range === null) return null;
  const first = Number.parseInt(range[1] as string, 10);
  const last = Number.parseInt(range[2] as string, 10);
  if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) return null;
  return { startIndex: first - 1, count: last - first + 1 };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/** The options of {@link runPredict}. */
export interface PredictOptions {
  /** The gold split manifest. */
  readonly splitPath: string;
  /** The root the manifest's relative paths are resolved against. */
  readonly rootDir: string;
  /** Where the prediction file is written. */
  readonly outPath: string;
  /** The provider whose client is used. Defaults to `openai`. */
  readonly provider?: LLMProvider;
  /** The model id. Defaults to the provider's default model. */
  readonly model?: string;
  /** The exact provider version of the model (for `model:<name>@<version>`). */
  readonly modelVersion?: string;
  /** The API key. Mapped onto the provider's own key field. */
  readonly apiKey?: string;
  /** The number of images per LLM call. */
  readonly batchSize?: number;
  /** The number of concurrent LLM calls. Defaults to 1. */
  readonly concurrency?: number;
  /** The number of retries per batch. The analyzer adds one attempt on top. */
  readonly maxRetries?: number;
  /** The pause between two LLM calls. Defaults to the analyzer's own default. */
  readonly delayBetweenCallsMs?: number;
  /** Where the generated taxonomy is written. Defaults to a temporary file. */
  readonly taxonomyPath?: string;
  /**
   * The run's spending ceiling in micro-USD (1 micro-USD is 1e-6 USD).
   * Optional: absent means EXACTLY the behavior the script always had, with no
   * ceiling enforced. `0` means no paid calls. When present, the run refuses
   * before the first provider call when the pinned estimate exceeds the
   * ceiling, and aborts when the observed spend of the answered calls crosses
   * it mid-run; in both cases a {@link BudgetExceededError} is thrown and no
   * prediction file is written.
   */
  readonly maxUsdMicro?: number;
  /** An injected client — the testability seam. Never used by the CLI. */
  readonly client?: LLMClient;
}

/**
 * The budget comparison slack, in USD: the repo's pinned budget convention
 * (`docs/architecture/benchmark.md`, the metrics budget rule), so a float sum
 * like 0.1 + 0.2 is not read as crossing a 0.3 ceiling by binary noise.
 */
const BUDGET_SLACK_USD = 1e-6;

/**
 * The run's spending ceiling (`--max-usd-micro`) was crossed.
 *
 * Two moments produce it, and both fail the run CLOSED, like every other
 * failure of this script: no prediction file is written, because a partial
 * prediction set is never published.
 *
 *  - the PRE-FLIGHT refusal: the pinned estimate (`estimateCost`) already
 *    exceeds the ceiling, so not one provider call is made. The error names
 *    the estimate, the ceiling and the provider.
 *  - the MID-RUN abort: the observed spend of the answered calls crossed the
 *    ceiling. The error names the partial spend observed so far, the ceiling
 *    and the provider.
 *
 * A ceiling of 0 is valid and refuses any run whose estimate is above 0: a
 * zero budget means no paid calls, the same rule the worker protocol's
 * `maxUsdMicro` documents.
 */
export class BudgetExceededError extends Error {
  /** The provider the run refused to call, or was calling when it aborted. */
  readonly provider: LLMProvider;
  /** The model of the run. */
  readonly model: string;
  /** The ceiling, in micro-USD. */
  readonly budgetUsdMicro: number;
  /** The pinned pre-flight estimate, in micro-USD (pre-flight refusal only). */
  readonly estimatedUsdMicro?: number;
  /** The spend observed before the mid-run abort, in micro-USD (abort only). */
  readonly spentUsdMicro?: number;

  constructor(fields: {
    readonly provider: LLMProvider;
    readonly model: string;
    readonly budgetUsdMicro: number;
    readonly estimatedUsdMicro?: number;
    readonly spentUsdMicro?: number;
    readonly imageCount?: number;
    readonly batchCount?: number;
  }) {
    const budgetUsd = (fields.budgetUsdMicro / 1_000_000).toFixed(6);
    const estimatedUsd = ((fields.estimatedUsdMicro ?? 0) / 1_000_000).toFixed(6);
    const spentUsd = ((fields.spentUsdMicro ?? 0) / 1_000_000).toFixed(6);
    super(
      fields.estimatedUsdMicro !== undefined
        ? '--max-usd-micro budget exceeded before the first provider call: the pinned estimate ' +
          `for ${fields.imageCount} image(s) over ${fields.batchCount} batch call(s) on ` +
          `${fields.provider}/${fields.model} is ${fields.estimatedUsdMicro} usd-micro ` +
          `(${estimatedUsd} USD), above the budget of ${fields.budgetUsdMicro} usd-micro ` +
          `(${budgetUsd} USD). No provider call was made and no prediction file is written.`
        : '--max-usd-micro budget crossed mid-run: the observed spend on ' +
          `${fields.provider}/${fields.model} reached ${fields.spentUsdMicro} usd-micro ` +
          `(${spentUsd} USD), above the budget of ${fields.budgetUsdMicro} usd-micro ` +
          `(${budgetUsd} USD). The run is aborted and no prediction file is written: a ` +
          'partial prediction set is never published.',
    );
    this.name = 'BudgetExceededError';
    this.provider = fields.provider;
    this.model = fields.model;
    this.budgetUsdMicro = fields.budgetUsdMicro;
    this.estimatedUsdMicro = fields.estimatedUsdMicro;
    this.spentUsdMicro = fields.spentUsdMicro;
  }
}

/** What one prediction run produced. */
export interface PredictReport {
  /** The prediction rows, in manifest order. */
  readonly predictions: readonly PredictionItem[];
  /** The id of the gold manifest. */
  readonly manifestId: string;
  /** The model the run used (the provider's default when none was named). */
  readonly model: string;
  /** The `model:<name>@<version>` string, or `''` when it was not supplied. */
  readonly modelVersion: string;
  /** Where the taxonomy of the run was written. */
  readonly taxonomyPath: string;
  /** The total recorded cost, or `null` when no cost could be recorded. */
  readonly totalCostUsd: number | null;
  /** The number of LLM calls. */
  readonly batches: number;
}

/** One gold assignment with its image on disk. */
interface ImageEntry {
  readonly assignment: SplitAssignment;
  readonly file: FileWithStats;
}

/** What one LLM call cost and how long it took. */
interface BatchObservation {
  /** The zero-based index of the first image of the batch. */
  readonly startIndex: number;
  /** The number of images of the batch. */
  readonly count: number;
  /** The wall-clock of the call, in milliseconds. */
  readonly durationMs: number;
  /** The input tokens the provider reported. */
  readonly inputTokens: number;
  /** The output tokens the provider reported. */
  readonly outputTokens: number;
}

/** Reads the gold manifest, failing loudly when it cannot be read. */
async function readGoldManifest(splitPath: string): Promise<SplitManifest> {
  let raw: string;
  try {
    raw = await readFile(splitPath, 'utf8');
  } catch (error) {
    throw new Error(
      `cannot read the gold manifest '${splitPath}': ${
        error instanceof Error ? error.message : String(error)
      }. Generate it with 'pnpm run benchmark:splits'.`,
    );
  }
  try {
    return JSON.parse(raw) as SplitManifest;
  } catch (error) {
    throw new Error(
      `the gold manifest '${splitPath}' is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Resolves every gold assignment to an image on disk.
 *
 * The images are ordered by their timestamp (the analyzer's prompt promises
 * the model a chronological order); the manifest order breaks the ties, so the
 * order is deterministic.
 *
 * @throws when an image of the manifest is missing — a run over a partial
 *   dataset is not a baseline.
 */
async function collectImageEntries(
  assignments: readonly SplitAssignment[],
  rootDir: string,
): Promise<ImageEntry[]> {
  const root = path.resolve(rootDir);
  const missing: string[] = [];
  const resolved = assignments.map((assignment) => {
    if (typeof assignment.path !== 'string' || assignment.path.length === 0) {
      throw new Error(
        `the assignment '${assignment.id}' carries no image path — the manifest is malformed.`,
      );
    }
    const fullPath = path.resolve(root, assignment.path);
    // A path that escapes the root would read a file outside the dataset.
    if (fullPath !== root && !fullPath.startsWith(root + path.sep)) {
      throw new Error(
        `the assignment '${assignment.id}' points outside the image root: ` +
          `'${assignment.path}'. Refusing to read a file outside '${root}'.`,
      );
    }
    if (!existsSync(fullPath)) missing.push(fullPath);
    return { assignment, fullPath };
  });

  if (missing.length > 0) {
    throw new Error(
      `missing image file(s) under '${root}': ${missing.join(', ')}. The root must contain ` +
        'every relative path of the manifest — a run over a partial dataset is not a baseline.',
    );
  }

  const entries = await Promise.all(
    resolved.map(async ({ assignment, fullPath }) => {
      const { createdAt, exifSource } = await getImageTimestamp(fullPath);
      const file: FileWithStats = { file: assignment.path, fullPath, createdAt, exifSource };
      return { assignment, file };
    }),
  );

  // The images are ordered by their timestamp ONLY when every one of them
  // carries a real capture timestamp. The fallback timestamps (the file's
  // birthtime/ctime) say when the file was COPIED, not when the picture was
  // taken: sorting by them would compose the LLM batches by extraction order,
  // and the same manifest would then produce different batches after a
  // re-extraction. The manifest order is hash-pinned and therefore the only
  // order that is reproducible — so it wins whenever the timestamps are not
  // meaningful.
  const allExif = entries.every((entry) => entry.file.exifSource === 'exif');
  if (!allExif) return entries;

  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.file.createdAt - b.entry.file.createdAt || a.index - b.index)
    .map((ordered) => ordered.entry);
}

/**
 * The mid-run budget watch of a run started with `--max-usd-micro`.
 */
interface BudgetWatch {
  /** The pricing of the run's model, when it is pinned; `null` when it is not. */
  readonly pricing: {
    readonly inputPerMillion: number;
    readonly outputPerMillion: number;
  } | null;
  /** The ceiling, in micro-USD (kept for the abort error). */
  readonly budgetUsdMicro: number;
  /** The ceiling, in USD. */
  readonly budgetUsd: number;
  /** The observed spend of every ANSWERED call, in USD. */
  spentUsd: number;
  /** Set once the observed spend crossed the ceiling; further calls are refused. */
  crossed: boolean;
}

/**
 * Wraps a client so every call is measured.
 *
 * The batch's wall-clock and token counts are attributed to the images of that
 * batch. A retried call replaces the observation of the batch it belongs to:
 * the measurement of the call that actually produced the result is the one
 * that counts.
 *
 * With a {@link BudgetWatch}, every ANSWERED call also adds its priced tokens
 * to the observed spend (a paid call is a paid call, including one whose text
 * the analyzer later discards), and once the spend has crossed the ceiling no
 * further provider call is made at all. The mid-run ABORT itself is raised by
 * the run, not here: this wrapper sits inside the analyzer's retry-and-pad
 * machinery, which would swallow or retry an ordinary error, so it only marks
 * the watch and refuses later calls with the analyzer's non-retryable,
 * non-paddable `QUOTA_EXCEEDED` marker.
 */
function createRecordingClient(
  inner: LLMClient,
  watch?: BudgetWatch,
): {
  client: LLMClient;
  observations: Map<number, BatchObservation>;
} {
  const observations = new Map<number, BatchObservation>();

  const client: LLMClient = {
    async complete(
      prompt: string,
      images: ImageInput[],
      opts: CompleteOptions,
    ): Promise<CompleteResult> {
      if (watch?.crossed) {
        throw new Error(
          'QUOTA_EXCEEDED: the --max-usd-micro budget of this run was already crossed; ' +
            'no further provider call is made.',
        );
      }
      const range = parseBatchRange(prompt);
      const startedAt = performance.now();
      const result = await inner.complete(prompt, images, opts);
      const durationMs = performance.now() - startedAt;
      if (range !== null) {
        observations.set(range.startIndex, {
          startIndex: range.startIndex,
          count: range.count,
          durationMs,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        });
      }
      if (watch !== undefined && watch.pricing !== null) {
        watch.spentUsd +=
          (result.inputTokens / 1_000_000) * watch.pricing.inputPerMillion +
          (result.outputTokens / 1_000_000) * watch.pricing.outputPerMillion;
        if (watch.spentUsd > watch.budgetUsd + BUDGET_SLACK_USD) {
          watch.crossed = true;
        }
      }
      return result;
    },
  };

  return { client, observations };
}

/** The price of a model, when it is pinned. `null` when it is not. */
function resolvePricing(
  provider: LLMProvider,
  model: string,
): { readonly inputPerMillion: number; readonly outputPerMillion: number } | null {
  // The table is typed as complete, but a provider outside the union has no
  // entry at runtime — the lookup is widened so the miss is handled.
  const pricing = PROVIDER_PRICING[provider] as
    | {
        readonly model: string;
        readonly inputPerMillion: number;
        readonly outputPerMillion: number;
      }
    | undefined;
  if (pricing === undefined) return null;
  // The table pins one model per provider. A dated variant of that model
  // (`gpt-4o-2024-11-20`) is priced like the model it pins.
  if (model !== pricing.model && !model.startsWith(`${pricing.model}-`)) return null;
  return { inputPerMillion: pricing.inputPerMillion, outputPerMillion: pricing.outputPerMillion };
}

/** Builds the analyzer's configuration for the run. */
async function buildConfig(
  options: PredictOptions,
  taxonomyPath: string,
  workDir: string,
): Promise<Config> {
  const provider = options.provider ?? 'openai';
  const raw: RawCliOptions = {
    categoriesFile: taxonomyPath,
    inputDir: path.resolve(options.rootDir),
    outputDir: workDir,
    provider,
    batchSize: options.batchSize ?? DEFAULT_BATCH_SIZE,
    concurrency: options.concurrency ?? 1,
    maxRetries: options.maxRetries ?? 3,
  };
  if (options.model !== undefined) raw.model = options.model;
  if (options.apiKey !== undefined) {
    if (provider === 'anthropic') raw.anthropicApiKey = options.apiKey;
    else if (provider === 'google' || provider === 'vertex') raw.googleApiKey = options.apiKey;
    else raw.apiKey = options.apiKey;
  }

  const config = await loadConfig(raw);
  if (options.delayBetweenCallsMs === undefined) return config;
  return { ...config, delayBetweenCallsMs: options.delayBetweenCallsMs };
}

/** Creates the real provider client. Imported lazily: the SDKs load here. */
async function createProviderClient(config: Config): Promise<LLMClient> {
  const { createLLMClient } = await import('../../packages/core/src/analyzer/client.js');
  return createLLMClient(config);
}

/** Writes the prediction file. */
async function writePredictions(
  outPath: string,
  predictions: readonly PredictionItem[],
): Promise<void> {
  const target = path.resolve(outPath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(predictions, null, 2)}\n`, 'utf8');
}

/**
 * The `modelVersion` string the benchmark records.
 *
 * The benchmark's reproduction tuple demands the versioned form
 * `model:<name>@<version>` (docs/architecture/benchmark.md) — a bare model id
 * is not a version. The version may be given in either form: the bare version
 * (`2024-11-20`) is completed with the model name, an already complete string
 * (`model:gpt-4o@2024-11-20`) is used as it is.
 */
export function formatModelVersion(model: string, version: string): string {
  if (version.startsWith('model:')) return version;
  return `model:${model}@${version}`;
}

/**
 * Runs the model over a gold split and writes the prediction file.
 *
 * @throws when the manifest cannot be read, when an image is missing, when
 *   the model answers outside the taxonomy, or when the provider call fails.
 */
export async function runPredict(options: PredictOptions): Promise<PredictReport> {
  const manifest = await readGoldManifest(options.splitPath);
  if (manifest.assignments.length === 0) {
    throw new Error(
      `the gold manifest '${manifest.id}' holds no assignment — there is nothing to predict.`,
    );
  }

  const taxonomy = buildTaxonomy(manifest);
  const entries = await collectImageEntries(manifest.assignments, options.rootDir);

  const workDir = await mkdtemp(path.join(os.tmpdir(), 'vision-lens-predict-'));
  const taxonomyPath = options.taxonomyPath ?? path.join(workDir, 'taxonomy.json');
  await mkdir(path.dirname(path.resolve(taxonomyPath)), { recursive: true });
  await writeFile(taxonomyPath, `${JSON.stringify(taxonomy.document, null, 2)}\n`, 'utf8');

  let failed = false;
  try {
    const config = await buildConfig(options, taxonomyPath, workDir);
    const pricing = resolvePricing(config.provider, config.model);

    // The budget gate of --max-usd-micro. Optional: absent means exactly the
    // behavior the script always had, with no ceiling. Present, it guards the
    // run at two moments: BEFORE the first provider call (the pinned estimate
    // of the whole run) and after every ANSWERED call (the observed spend). A
    // ceiling of 0 refuses any run whose estimate is above 0: no paid calls.
    let watch: BudgetWatch | undefined;
    if (options.maxUsdMicro !== undefined) {
      const budgetUsd = options.maxUsdMicro / 1_000_000;
      const estimate = estimateCost(entries.length, config.batchSize, config.provider);
      if (estimate.estimatedCostUsd > budgetUsd + BUDGET_SLACK_USD) {
        throw new BudgetExceededError({
          provider: config.provider,
          model: config.model,
          budgetUsdMicro: options.maxUsdMicro,
          estimatedUsdMicro: Math.round(estimate.estimatedCostUsd * 1_000_000),
          imageCount: entries.length,
          batchCount: estimate.batchCount,
        });
      }
      watch = {
        pricing,
        budgetUsdMicro: options.maxUsdMicro,
        budgetUsd,
        spentUsd: 0,
        crossed: false,
      };
    }

    const client = options.client ?? (await createProviderClient(config));
    const recorder = createRecordingClient(client, watch);

    const results = await analyzeBatch(
      entries.map((entry) => entry.file),
      config,
      recorder.client,
      (processed, batch, tokensUsed) => {
        // The mid-run abort. The progress callback runs after every answered
        // batch and OUTSIDE the analyzer's retry-and-pad machinery, so the
        // typed refusal surfaces as the run's own failure instead of being
        // retried or padded into an unknown. Like any failed batch, it writes
        // NO prediction file: a partial prediction set is never published.
        if (watch?.crossed) {
          throw new BudgetExceededError({
            provider: config.provider,
            model: config.model,
            budgetUsdMicro: watch.budgetUsdMicro,
            spentUsdMicro: Math.round(watch.spentUsd * 1_000_000),
          });
        }
        logger.info(
          `  ${processed}/${entries.length} images analysed (batch ${batch}, ${tokensUsed} tokens)`,
        );
      },
    );

    const latencyMs: (number | undefined)[] = new Array(entries.length).fill(undefined);
    const costUsd: (number | undefined)[] = new Array(entries.length).fill(undefined);
    for (const observation of recorder.observations.values()) {
      const batchCost =
        pricing === null
          ? undefined
          : (observation.inputTokens / 1_000_000) * pricing.inputPerMillion +
            (observation.outputTokens / 1_000_000) * pricing.outputPerMillion;
      for (let offset = 0; offset < observation.count; offset += 1) {
        const index = observation.startIndex + offset;
        if (index < 0 || index >= entries.length) continue;
        latencyMs[index] = observation.durationMs;
        costUsd[index] = batchCost === undefined ? undefined : batchCost / observation.count;
      }
    }

    const predictions = buildPredictionItems({
      assignments: entries.map((entry) => entry.assignment),
      results,
      labelKeyByName: taxonomy.labelKeyByName,
      latencyMs,
      costUsd,
    });

    await writePredictions(options.outPath, predictions);

    const recorded = costUsd.filter((value): value is number => value !== undefined);
    return {
      predictions,
      manifestId: manifest.id,
      model: config.model,
      modelVersion:
        options.modelVersion === undefined ? '' : formatModelVersion(config.model, options.modelVersion),
      taxonomyPath,
      totalCostUsd: recorded.length === 0 ? null : recorded.reduce((sum, v) => sum + v, 0),
      batches: recorder.observations.size,
    };
  } catch (error) {
    failed = true;
    logger.error(
      `the run failed — the taxonomy it used is kept at '${taxonomyPath}' for inspection.`,
    );
    throw error;
  } finally {
    if (!failed && options.taxonomyPath === undefined) {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** The usage text of the script. */
const USAGE = `Usage: predict-visa.ts --split <manifest> --root <dir> --out <file> [options]

  --split <file>          the gold split manifest (required)
  --root <dir>            the image root; <root>/<assignment.path> is the image (required)
  --out <file>            where the prediction file is written (required)
  --provider <name>       openai | anthropic | google | azure | ollama | hybrid | bedrock | vertex
  --model <name>          the model id (defaults to the provider's default model)
  --model-version <ver>   the exact provider version, e.g. 2024-11-20
  --api-key <key>         the API key (or leave it to the environment)
  --batch-size <n>        images per LLM call (default: ${DEFAULT_BATCH_SIZE})
  --concurrency <n>       concurrent LLM calls (default: 1)
  --max-usd-micro <n>     optional spending ceiling in micro-USD (750000 = 0.75 USD):
                          refuses before the first provider call when the pinned
                          estimate exceeds it, aborts when the observed spend crosses
                          it; in both cases no prediction file is written. 0 means no
                          paid calls; without the flag there is no ceiling. Mid-run
                          tracking needs the run's model pinned in PROVIDER_PRICING;
                          an unlisted model's ceiling is pre-flight only (priced at
                          the provider's default model)
  --taxonomy-out <file>   keep the generated taxonomy at this path
  --verbose               verbose logging
  --quiet                 quiet logging
`;

/** Parses the command line. */
function parseCliArgs(argv: readonly string[]): {
  values: Record<string, string | boolean | undefined>;
} {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      split: { type: 'string' },
      root: { type: 'string' },
      out: { type: 'string' },
      provider: { type: 'string', default: 'openai' },
      model: { type: 'string' },
      'model-version': { type: 'string' },
      'api-key': { type: 'string' },
      'batch-size': { type: 'string', default: String(DEFAULT_BATCH_SIZE) },
      concurrency: { type: 'string', default: '1' },
      'max-usd-micro': { type: 'string' },
      'taxonomy-out': { type: 'string' },
      verbose: { type: 'boolean', default: false },
      quiet: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  return { values: values as Record<string, string | boolean | undefined> };
}

/** Reads a numeric option, failing loudly when it is not a number. */
function numberOption(
  values: Record<string, string | boolean | undefined>,
  name: string,
  fallback: number,
): number {
  const raw = values[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer, got '${String(raw)}'`);
  }
  return parsed;
}

/**
 * Reads `--max-usd-micro`, failing loudly when it is not a non-negative
 * integer. `0` is valid: a zero ceiling means no paid calls.
 */
function usdMicroOption(
  values: Record<string, string | boolean | undefined>,
): number | undefined {
  const raw = values['max-usd-micro'];
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(
      `--max-usd-micro must be a non-negative integer of micro-USD, got '${String(raw)}'`,
    );
  }
  return parsed;
}

/** The seams of {@link main} — the client is injected by the test suite. */
export interface MainDependencies {
  /** The client the run uses. The CLI leaves it undefined (the real one). */
  readonly client?: LLMClient;
}

/** The command-line entry point. */
export async function main(argv: readonly string[], deps: MainDependencies = {}): Promise<void> {
  const { values } = parseCliArgs(argv);

  if (values['help'] === true) {
    process.stdout.write(USAGE);
    return;
  }

  configureLogger({
    verbose: values['verbose'] === true,
    quiet: values['quiet'] === true,
  });

  const split = values['split'];
  const root = values['root'];
  const out = values['out'];
  if (typeof split !== 'string' || split.length === 0) {
    throw new Error(
      "--split <file> is required: pass the gold split manifest " +
        "(e.g. benchmarks/splits/visa-subset.gold.json).",
    );
  }
  if (typeof root !== 'string' || root.length === 0) {
    throw new Error(
      '--root <dir> is required: pass the image root the manifest paths resolve against ' +
        '(e.g. datasets/visa-subset).',
    );
  }
  if (typeof out !== 'string' || out.length === 0) {
    throw new Error('--out <file> is required: pass where the prediction file is written.');
  }

  const providerRaw = String(values['provider'] ?? 'openai');
  if (!PROVIDERS.includes(providerRaw as LLMProvider)) {
    throw new Error(
      `unknown provider '${providerRaw}'. Known providers: ${PROVIDERS.join(', ')}.`,
    );
  }
  const provider = providerRaw as LLMProvider;

  const model = typeof values['model'] === 'string' ? values['model'] : undefined;
  const modelVersion =
    typeof values['model-version'] === 'string' ? values['model-version'] : undefined;
  const maxUsdMicro = usdMicroOption(values);

  logger.info(
    `[predict-visa] predicting ${path.basename(split)} with ${provider}${
      model === undefined ? '' : `/${model}`
    }…`,
  );
  if (maxUsdMicro !== undefined) {
    logger.info(
      `  budget     : ${maxUsdMicro} usd-micro (${(maxUsdMicro / 1_000_000).toFixed(6)} USD)`,
    );
  }

  const report = await runPredict({
    splitPath: split,
    rootDir: root,
    outPath: out,
    provider,
    ...(model === undefined ? {} : { model }),
    ...(modelVersion === undefined ? {} : { modelVersion }),
    ...(typeof values['api-key'] === 'string' ? { apiKey: values['api-key'] } : {}),
    ...(maxUsdMicro === undefined ? {} : { maxUsdMicro }),
    batchSize: numberOption(values, 'batch-size', DEFAULT_BATCH_SIZE),
    concurrency: numberOption(values, 'concurrency', 1),
    ...(typeof values['taxonomy-out'] === 'string'
      ? { taxonomyPath: values['taxonomy-out'] }
      : {}),
    ...(deps.client === undefined ? {} : { client: deps.client }),
  });

  const suite = report.manifestId.endsWith('.gold')
    ? report.manifestId.slice(0, -'.gold'.length)
    : report.manifestId;
  const versionHint =
    report.modelVersion === ''
      ? "NOT SET — the benchmark needs the versioned form 'model:<name>@<version>'; pass " +
        '--model-version to record it.'
      : report.modelVersion;

  logger.success(
    `[predict-visa] ${report.predictions.length} predictions → ${path.resolve(out)}`,
  );
  logger.info(`  manifest    : ${report.manifestId}`);
  logger.info(`  batches     : ${report.batches}`);
  logger.info(`  model       : ${report.model}`);
  logger.info(`  modelVersion: ${versionHint}`);
  logger.info(
    report.totalCostUsd === null
      ? `  cost        : omitted — the price of the model is not pinned in PROVIDER_PRICING`
      : `  cost        : ${report.totalCostUsd.toFixed(6)} USD (amortized per image)`,
  );
  logger.info(
    `  next        : node packages/cli/dist/index.js benchmark run --suite ${suite} ` +
      `--model-id ${report.model} --model-version '${versionHint}' ` +
      `--split ${split} --predictions ${out} --config-fingerprint <hash>`,
  );
}

// Only run when invoked as a script, never when imported by a test.
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
