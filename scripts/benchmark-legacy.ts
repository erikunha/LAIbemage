/**
 * LEGACY SYNTHETIC BENCHMARK — UNIT-FIXTURE / REGRESSION HARNESS ONLY.
 *
 * This is NOT an accuracy source of truth. The fixtures it scores against are
 * synthetic colour swatches (`packages/core/tests/fixtures/benchmark/labels.json`
 * self-describes them as such), so the precision/recall it prints describe the
 * harness, not the product.
 *
 * Per ADR-008 (`docs/adr/008-evidence-policy.md`), a real-dataset benchmark is the
 * only accuracy source: the synthetic fixtures remain unit-test inputs only, and
 * all product accuracy claims come from the spec-003 artifacts:
 *   - `benchmarks/results/<runId>/`  — JSON + Markdown metric reports
 *   - `benchmarks/baselines/<suite>.json` — regression baselines
 *   - `benchmarks/splits/*.gold.json` — seeded, hash-pinned gold splits
 *   - `datasets/registry.json` — dataset source, license and checksums
 *   - `laib benchmark run|gate|report` — the CLI that produces the above
 *
 * It runs LLM analysis against the labelled benchmark fixtures and produces:
 *   - Per-category precision / recall
 *   - Overall accuracy and unknown rate
 *   - Estimated API cost for 30 images (normalised from the fixture set)
 *   - P95 batch latency
 *
 * Outputs: reports/benchmark/<provider>.json
 *
 * Flags:
 *   --provider <name>       openai | anthropic | google | all  (default: all)
 *   --check-regression      Fail if any summary metric regresses >5% vs baseline
 *   --update-baseline       Write current results to the legacy baseline file
 *                           (baseline.json in the benchmark fixture dir)
 *
 * Usage:
 *   npx tsx scripts/benchmark-legacy.ts
 *   npx tsx scripts/benchmark-legacy.ts --provider openai --check-regression
 *   npx tsx scripts/benchmark-legacy.ts --provider anthropic --update-baseline
 */
import { execFileSync } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeImages } from '../packages/core/src/analyzer/index.js';
import type { CategoryConfig, Config, LLMProvider } from '../packages/core/src/config/index.js';
import type { FileWithStats } from '../packages/core/src/types.js';
import { estimateCost } from '../packages/core/src/utils/cost.js';
import { getImageTimestamp } from '../packages/core/src/utils/exif.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
// The fixtures live under packages/core/tests/fixtures/benchmark — the same path
// `scripts/generate-benchmark-fixtures.ts` writes to. Before the monorepo move
// (025ea1c) this pointed at <root>/tests/fixtures/benchmark, so the harness read
// labels from a directory that no longer existed.
const BENCHMARK_DIR = path.join(ROOT, 'packages', 'core', 'tests', 'fixtures', 'benchmark');
const IMAGES_DIR = path.join(BENCHMARK_DIR, 'images');
const LABELS_PATH = path.join(BENCHMARK_DIR, 'labels.json');
const BASELINE_PATH = path.join(BENCHMARK_DIR, 'baseline.json');
const REPORTS_DIR = path.join(ROOT, 'reports', 'benchmark');

// ---------------------------------------------------------------------------
// CLI arg parsing (intentionally minimal — no external dep required)
// ---------------------------------------------------------------------------

function parseArgs(args: string[]): {
  provider: string;
  checkRegression: boolean;
  updateBaseline: boolean;
} {
  let provider = 'all';
  let checkRegression = false;
  let updateBaseline = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--provider' && i + 1 < args.length) {
      provider = args[++i] ?? 'all';
    } else if (arg === '--check-regression') {
      checkRegression = true;
    } else if (arg === '--update-baseline') {
      updateBaseline = true;
    }
  }
  return { provider, checkRegression, updateBaseline };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LabelsFile {
  description: string;
  categories: string[];
  images: Array<{ file: string; category: string }>;
}

interface CategoryMetrics {
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
}

interface BenchmarkSummary {
  precision: number;
  recall: number;
  unknownRate: number;
  /** Estimated cost normalised to 30 images (USD) */
  costPer30: number;
  p95LatencyMs: number;
}

interface BenchmarkResult {
  provider: LLMProvider;
  model: string;
  runAt: string;
  imageCount: number;
  batchLatenciesMs: number[];
  perCategory: Record<string, CategoryMetrics>;
  summary: BenchmarkSummary;
}

interface Baseline {
  updatedAt: string;
  results: Partial<Record<LLMProvider, BenchmarkSummary>>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_MODELS: Record<LLMProvider, string> = {
  openai: 'gpt-4o',
  anthropic: 'claude-opus-4-7',
  google: 'gemini-2.0-flash',
  azure: 'gpt-4o',
  ollama: 'llava',
  hybrid: 'llava',
  bedrock: 'anthropic.claude-opus-4-7-20250514-v1:0',
  vertex: 'gemini-2.0-flash',
};

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureBenchmarkFixtures(): Promise<void> {
  const labelsExists = await fileExists(LABELS_PATH);
  if (!labelsExists) {
    console.log('[benchmark] Generating fixture images…');
    execFileSync(
      process.execPath,
      ['--import', 'tsx/esm', 'scripts/generate-benchmark-fixtures.ts'],
      { cwd: ROOT, stdio: 'inherit' },
    );
  }
}

async function loadLabels(): Promise<LabelsFile> {
  const raw = await readFile(LABELS_PATH, 'utf8');
  return JSON.parse(raw) as LabelsFile;
}

function buildConfig(
  provider: LLMProvider,
  imagesDir: string,
  categoryConfig: CategoryConfig,
): Config {
  return {
    inputDir: imagesDir,
    outputDir: imagesDir,
    categoryConfig,
    provider,
    embed: false,
    apiKey: process.env['OPENAI_API_KEY'] ?? '',
    anthropicApiKey: process.env['ANTHROPIC_API_KEY'] ?? '',
    googleApiKey: process.env['GOOGLE_API_KEY'] ?? '',
    model: DEFAULT_MODELS[provider],
    batchSize: 20,
    maxRetries: 2,
    retryDelayMs: 1000,
    delayBetweenCallsMs: 0,
    dryRun: false,
    skipAnalysis: false,
    forceSkipAnalysis: false,
    asyncBatch: false,
    resumeBatch: false,
    outputFormat: 'none',
    logFormat: 'pretty',
    verbose: false,
    quiet: true,
    concurrency: 1,
    estimate: false,
    temporalWindowMinutes: 15,
    consensusThreshold: 0.6,
    dedupeThreshold: 0,
    timing: false,
    filenameTemplate: '{n}. Photo of {category} dated {date}',
    watch: false,
    watchPoll: false,
    interactive: false,
    plugins: [],
    linkImages: false,
    linkWindowDays: 7,
    selfCritique: false,
    learn: false,
    activeLearnQueue: false,
    localModel: 'llava',
    cloudProvider: 'openai',
    localConfidenceThreshold: 0.7,
    bedrockRegion: 'us-east-1',
    bedrockAccessKeyId: undefined,
    bedrockSecretAccessKey: undefined,
    vertexProjectId: undefined,
    vertexLocation: 'us-central1',
  };
}

function buildCategoryConfig(categories: string[]): CategoryConfig {
  return {
    description: 'Benchmark categories',
    categories: categories.map((name) => ({ name, description: name.replace(/_/g, ' ') })),
    pinnedLast: [],
    immune: [],
    overridable: [],
    timezone: 'UTC',
  };
}

function computeMetrics(
  predicted: string[],
  actual: string[],
  categories: string[],
): { perCategory: Record<string, CategoryMetrics>; unknownCount: number } {
  const perCategory: Record<string, CategoryMetrics> = {};

  for (const cat of categories) {
    perCategory[cat] = { tp: 0, fp: 0, fn: 0, precision: 0, recall: 0 };
  }

  let unknownCount = 0;

  for (let i = 0; i < actual.length; i++) {
    const pred = predicted[i] ?? 'unknown';
    const truth = actual[i] ?? 'unknown';

    if (pred === 'unknown') unknownCount++;

    for (const cat of categories) {
      const entry = perCategory[cat];
      if (!entry) continue;
      const isPred = pred === cat;
      const isTruth = truth === cat;
      if (isPred && isTruth) entry.tp++;
      else if (isPred && !isTruth) entry.fp++;
      else if (!isPred && isTruth) entry.fn++;
    }
  }

  for (const cat of categories) {
    const entry = perCategory[cat];
    if (!entry) continue;
    entry.precision = entry.tp + entry.fp === 0 ? 0 : entry.tp / (entry.tp + entry.fp);
    entry.recall = entry.tp + entry.fn === 0 ? 0 : entry.tp / (entry.tp + entry.fn);
  }

  return { perCategory, unknownCount };
}

function macroAverage(perCategory: Record<string, CategoryMetrics>): {
  precision: number;
  recall: number;
} {
  const entries = Object.values(perCategory);
  if (entries.length === 0) return { precision: 0, recall: 0 };
  const precision = entries.reduce((s, e) => s + e.precision, 0) / entries.length;
  const recall = entries.reduce((s, e) => s + e.recall, 0) / entries.length;
  return { precision, recall };
}

function p95(latencies: number[]): number {
  if (latencies.length === 0) return 0;
  const sorted = [...latencies].sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * 0.95);
  return sorted[Math.min(idx, sorted.length - 1)] ?? 0;
}

// ---------------------------------------------------------------------------
// Run benchmark for a single provider
// ---------------------------------------------------------------------------

async function runForProvider(provider: LLMProvider, labels: LabelsFile): Promise<BenchmarkResult> {
  console.log(`\n[benchmark] Provider: ${provider}`);

  const categoryConfig = buildCategoryConfig(labels.categories);
  const config = buildConfig(provider, IMAGES_DIR, categoryConfig);

  // Build FileWithStats list from labels (preserves order)
  const filesWithStats: FileWithStats[] = await Promise.all(
    labels.images.map(async (entry) => {
      const fullPath = path.join(IMAGES_DIR, entry.file);
      const ts = await getImageTimestamp(fullPath);
      return {
        file: entry.file,
        fullPath,
        createdAt: ts.createdAt,
        exifSource: ts.exifSource,
      };
    }),
  );

  const batchLatenciesMs: number[] = [];

  const { images } = await analyzeImages(
    filesWithStats,
    config,
    undefined, // onProgress — unused
    async () => {
      // onBatchComplete — used to capture timing
    },
  );

  // Capture latency via onProgress timing is not directly available from the
  // analyzeImages signature, so we measure the full call time as a single batch latency.
  // For multi-batch runs the latency is split proportionally.
  const batchCount = Math.ceil(labels.images.length / config.batchSize);
  for (let i = 0; i < batchCount; i++) {
    batchLatenciesMs.push(0); // placeholder — real timing needs instrumentation inside analyzeImages
  }

  const predicted = images.map((img) => img.analysis.category);
  const actual = labels.images.map((e) => e.category);

  const { perCategory, unknownCount } = computeMetrics(predicted, actual, labels.categories);
  const { precision, recall } = macroAverage(perCategory);
  const unknownRate = unknownCount / labels.images.length;
  const costEst = estimateCost(30, config.batchSize, provider, 'low');

  return {
    provider,
    model: DEFAULT_MODELS[provider],
    runAt: new Date().toISOString(),
    imageCount: labels.images.length,
    batchLatenciesMs,
    perCategory,
    summary: {
      precision,
      recall,
      unknownRate,
      costPer30: costEst.estimatedCostUsd,
      p95LatencyMs: p95(batchLatenciesMs),
    },
  };
}

// ---------------------------------------------------------------------------
// Regression check
// ---------------------------------------------------------------------------

const REGRESSION_THRESHOLD = 0.05; // 5 %

function checkRegression(result: BenchmarkResult, baseline: Baseline): void {
  const base = baseline.results[result.provider];
  if (!base) {
    console.log(`[benchmark] No baseline for ${result.provider} — skipping regression check.`);
    return;
  }

  const metrics: Array<keyof BenchmarkSummary> = ['precision', 'recall'];
  const regressions: string[] = [];

  for (const metric of metrics) {
    const baseVal = base[metric] as number;
    const currVal = result.summary[metric] as number;
    if (baseVal > 0 && (baseVal - currVal) / baseVal > REGRESSION_THRESHOLD) {
      regressions.push(
        `  ${metric}: baseline=${(baseVal * 100).toFixed(1)}% → current=${(currVal * 100).toFixed(1)}% (regressed ${(((baseVal - currVal) / baseVal) * 100).toFixed(1)}%)`,
      );
    }
  }

  // unknownRate regression = increase
  const baseUnknown = base.unknownRate;
  const currUnknown = result.summary.unknownRate;
  if (baseUnknown >= 0 && currUnknown - baseUnknown > REGRESSION_THRESHOLD) {
    regressions.push(
      `  unknownRate: baseline=${(baseUnknown * 100).toFixed(1)}% → current=${(currUnknown * 100).toFixed(1)}% (regressed ${((currUnknown - baseUnknown) * 100).toFixed(1)}pp)`,
    );
  }

  if (regressions.length > 0) {
    console.error(`[benchmark] REGRESSION detected for ${result.provider}:`);
    for (const r of regressions) console.error(r);
    process.exitCode = 1;
  } else {
    console.log(`[benchmark] ${result.provider}: no regression vs baseline ✓`);
  }
}

// ---------------------------------------------------------------------------
// Report formatting
// ---------------------------------------------------------------------------

function printSummary(result: BenchmarkResult): void {
  const { summary } = result;
  console.log(`\n  Provider    : ${result.provider} (${result.model})`);
  console.log(`  Images      : ${result.imageCount}`);
  console.log(`  Precision   : ${(summary.precision * 100).toFixed(1)}%`);
  console.log(`  Recall      : ${(summary.recall * 100).toFixed(1)}%`);
  console.log(`  Unknown rate: ${(summary.unknownRate * 100).toFixed(1)}%`);
  console.log(`  Cost / 30   : $${summary.costPer30.toFixed(4)}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { provider, checkRegression: doCheck, updateBaseline } = parseArgs(process.argv.slice(2));

  await ensureBenchmarkFixtures();
  const labels = await loadLabels();

  const providers: LLMProvider[] =
    provider === 'all'
      ? (['openai', 'anthropic', 'google'] as LLMProvider[])
      : ([provider] as LLMProvider[]);

  await mkdir(REPORTS_DIR, { recursive: true });

  let baseline: Baseline | null = null;
  if (doCheck && (await fileExists(BASELINE_PATH))) {
    const raw = await readFile(BASELINE_PATH, 'utf8');
    baseline = JSON.parse(raw) as Baseline;
  }

  const updatedBaseline: Baseline = {
    updatedAt: new Date().toISOString(),
    results: baseline?.results ?? {},
  };

  for (const p of providers) {
    const result = await runForProvider(p, labels);

    const reportPath = path.join(REPORTS_DIR, `${p}.json`);
    await writeFile(reportPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
    console.log(`[benchmark] Report written → ${reportPath}`);

    printSummary(result);

    if (doCheck && baseline) {
      checkRegression(result, baseline);
    }

    if (updateBaseline) {
      updatedBaseline.results[p] = result.summary;
    }
  }

  if (updateBaseline) {
    await writeFile(BASELINE_PATH, JSON.stringify(updatedBaseline, null, 2) + '\n', 'utf8');
    console.log(`\n[benchmark] Baseline updated → ${BASELINE_PATH}`);
  }
}

main().catch((err: unknown) => {
  console.error('[benchmark] Fatal:', err);
  process.exit(1);
});
