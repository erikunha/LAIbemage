import chalk from 'chalk';
import cliProgress from 'cli-progress';

// Rough cost estimate: detail:low ≈ 85 tokens/image at ~$0.15/1M tokens (gpt-4o input)
const COST_PER_TOKEN = 0.000_000_15;

let bar: cliProgress.SingleBar | null = null;
let _totalBatches = 0;
let _tokensUsed = 0;

export function startProgress(total: number, totalBatches: number): void {
  _totalBatches = totalBatches;
  _tokensUsed = 0;

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

  bar.start(total, 0, { batch: 0, totalBatches, cost: '0.00' });
}

export function updateProgress(processed: number, batch: number, tokensUsed: number): void {
  if (!bar) return;
  _tokensUsed += tokensUsed;
  const cost = (_tokensUsed * COST_PER_TOKEN).toFixed(2);
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
  const estimatedCostUsd = tokensUsed * COST_PER_TOKEN;

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
    `  Estimated cost : ${chalk.bold('$' + estimatedCostUsd.toFixed(4))}`,
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
