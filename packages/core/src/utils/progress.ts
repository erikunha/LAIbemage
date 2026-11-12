import chalk from 'chalk';
import cliProgress from 'cli-progress';
import type { LLMProvider } from '../config/index.js';
import { computeCostUsd, hasUnknownRate } from './cost.js';

let bar: cliProgress.SingleBar | null = null;
let _totalBatches = 0;
let _provider: LLMProvider = 'openai';
/**
 * Token usage per provider. A run served by several providers (consensus) is
 * priced with the rate of the provider that produced each batch.
 */
const _tokensByProvider = new Map<LLMProvider, { input: number; output: number }>();

/** Cost of everything recorded so far, priced with the rate of each provider. */
function accumulatedCostUsd(): number {
  let total = 0;
  for (const [provider, tokens] of _tokensByProvider) {
    total += computeCostUsd(provider, tokens.input, tokens.output);
  }
  return total;
}

/**
 * Record the provider that served the run, so the progress bar and the summary
 * price it with that provider's rates. The analyzer calls this before the first
 * batch; an explicit provider passed to startProgress wins over it.
 */
export function setCostProvider(provider: LLMProvider): void {
  _provider = provider;
}

/**
 * Start the progress bar.
 *
 * @param provider  Provider whose published rates price the running cost. When
 *                  omitted, the provider recorded with setCostProvider is kept.
 */
export function startProgress(total: number, totalBatches: number, provider?: LLMProvider): void {
  _totalBatches = totalBatches;
  _tokensByProvider.clear();
  if (provider !== undefined) _provider = provider;

  bar = new cliProgress.SingleBar(
    {
      format:
        chalk.cyan('{bar}') +
        ' {percentage}% | {value}/{total} images | Batch {batch}/{totalBatches} | ' +
        chalk.yellow('~${cost}') +
        ' | ETA {eta_formatted}',
      barCompleteChar: '=',
      barIncompleteChar: ' ',
      hideCursor: true,
    },
    cliProgress.Presets.shades_classic,
  );

  bar.start(total, 0, {
    batch: 0,
    totalBatches,
    cost: hasUnknownRate(_provider) ? 'n/a' : '0.00',
  });
}

/**
 * Advance the progress bar and refresh the running cost.
 *
 * @param inputTokens   Input tokens consumed by the finished batch.
 * @param outputTokens  Output tokens produced by the finished batch.
 * @param provider      Provider that served the batch. Defaults to the provider
 *                      recorded for the run; a consensus run passes the provider
 *                      of each batch so every batch is priced with its own rate.
 */
export function updateProgress(
  processed: number,
  batch: number,
  inputTokens: number,
  outputTokens = 0,
  provider?: LLMProvider,
): void {
  if (!bar) return;
  const priced = provider ?? _provider;
  const usage = _tokensByProvider.get(priced) ?? { input: 0, output: 0 };
  usage.input += inputTokens;
  usage.output += outputTokens;
  _tokensByProvider.set(priced, usage);
  const cost = hasUnknownRate(priced) ? 'n/a' : accumulatedCostUsd().toFixed(2);
  bar.update(processed, { batch, totalBatches: _totalBatches, cost });
}

export function stopProgress(): void {
  bar?.stop();
  bar = null;
}

export interface RunSummary {
  readonly total: number;
  readonly classified: number;
  readonly unknown: number;
  readonly overridden: number;
  readonly duplicatesSkipped: number;
  readonly apiCalls: number;
  readonly tokensUsed: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly durationMs: number;
  /** Provider that served the run; selects the price table for the cost line. Defaults to the recorded run provider. */
  readonly provider?: LLMProvider;
  /**
   * Cost of the run in USD when it was already computed by the caller, for
   * example a consensus run served by two providers. Wins over the single
   * provider rate, but not over a provider whose rate is unknown.
   */
  readonly estimatedCostUsd?: number;
  /** Average model confidence across all analysed images (0 if none had confidence data). */
  readonly avgConfidence?: number;
  /** Count of images with confidence < 0.5 (flagged for human review). */
  readonly lowConfidenceCount?: number;
  readonly timings?: StepTimings;
}

/** Per-step wall-time breakdown. All values are milliseconds. */
export interface StepTimings {
  readonly collectionMs: number;
  readonly exifMs: number;
  readonly dedupMs: number;
  readonly analysisMs: number;
  readonly classifyMs: number;
  readonly processingMs: number;
  readonly cacheWriteMs: number;
}

export function printSummaryTable(summary: RunSummary): void {
  const {
    total,
    classified,
    unknown,
    overridden,
    duplicatesSkipped,
    apiCalls,
    tokensUsed,
    inputTokens,
    outputTokens,
    durationMs,
    avgConfidence,
    lowConfidenceCount,
    timings,
  } = summary;
  // The summary may carry the provider explicitly; otherwise the provider
  // recorded for the run prices the cost line.
  const provider = summary.provider ?? _provider;
  // A hybrid run mixes a free local tier with a paid cloud tier, so one
  // provider rate would mislead. The progress bar uses the same predicate.
  const estimatedCostUsd = hasUnknownRate(provider)
    ? undefined
    : (summary.estimatedCostUsd ?? computeCostUsd(provider, inputTokens, outputTokens));

  const secs = Math.round(durationMs / 1000);
  const duration = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
  const divider = chalk.bold('─'.repeat(50));

  const confidenceLine =
    avgConfidence !== undefined && avgConfidence > 0
      ? `  Avg confidence : ${chalk.bold((avgConfidence * 100).toFixed(1) + '%')}${lowConfidenceCount ? chalk.yellow(` (${String(lowConfidenceCount)} low)`) : ''}`
      : null;

  const lines: string[] = [
    '',
    divider,
    chalk.bold('  Run Summary'),
    divider,
    `  Total images   : ${chalk.bold(String(total))}`,
    `  Classified     : ${chalk.bold(String(classified))}`,
    `  Unknown        : ${chalk.bold(unknown > 0 ? chalk.yellow(String(unknown)) : String(unknown))}`,
    `  Overridden     : ${chalk.bold(String(overridden))}`,
    `  Duplicates skipped: ${chalk.bold(String(duplicatesSkipped))}`,
    `  API calls      : ${chalk.bold(String(apiCalls))}`,
    `  Tokens used    : ${chalk.bold(String(tokensUsed))} (in: ${inputTokens}, out: ${outputTokens})`,
    `  Estimated cost : ${estimatedCostUsd === undefined ? chalk.dim('n/a (hybrid mixes local and cloud rates)') : chalk.bold('$' + estimatedCostUsd.toFixed(4))}`,
    `  Duration       : ${chalk.bold(duration)}`,
    ...(confidenceLine ? [confidenceLine] : []),
  ];

  if (timings) {
    const fmt = (ms: number): string => {
      if (ms >= 60_000) return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
      if (ms >= 1_000) return `${(ms / 1000).toFixed(1)}s`;
      return `${ms}ms`;
    };
    lines.push(
      divider,
      chalk.bold('  Step Timings'),
      divider,
      `  Collection     : ${chalk.bold(fmt(timings.collectionMs))}`,
      `  EXIF           : ${chalk.bold(fmt(timings.exifMs))}`,
      `  Dedup          : ${chalk.bold(fmt(timings.dedupMs))}`,
      `  Analysis       : ${chalk.bold(fmt(timings.analysisMs))}`,
      `  Classify       : ${chalk.bold(fmt(timings.classifyMs))}`,
      `  Processing     : ${chalk.bold(fmt(timings.processingMs))}`,
      `  Cache write    : ${chalk.bold(fmt(timings.cacheWriteMs))}`,
    );
  }

  lines.push(divider + '\n');

  for (const line of lines) {
    process.stderr.write(line + '\n');
  }
}
