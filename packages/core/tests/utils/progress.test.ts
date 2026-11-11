import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const barUpdate = vi.fn();
vi.mock('cli-progress', () => ({
  default: {
    Presets: { shades_classic: {} },
    SingleBar: vi.fn(function () {
      return { start: vi.fn(), update: barUpdate, stop: vi.fn() };
    }),
  },
}));

import {
  printSummaryTable,
  setCostProvider,
  startProgress,
  updateProgress,
  type RunSummary,
} from '../../src/utils/progress.js';

function summary(overrides: Partial<RunSummary>): RunSummary {
  return {
    total: 10,
    classified: 10,
    unknown: 0,
    overridden: 0,
    duplicatesSkipped: 0,
    apiCalls: 1,
    tokensUsed: 5645,
    inputTokens: 5012,
    outputTokens: 633,
    durationMs: 1000,
    provider: 'anthropic',
    ...overrides,
  };
}

describe('run summary cost', () => {
  let output = '';
  beforeEach(() => {
    output = '';
    setCostProvider('openai');
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('prices an Opus run from input and output tokens', () => {
    printSummaryTable(summary({}));
    expect(output).toContain('$0.1227');
  });

  it('uses the active provider rates', () => {
    printSummaryTable(summary({ provider: 'openai' }));
    // 5012*2.5/1e6 + 633*10/1e6
    expect(output).toContain('$0.0189');
  });

  it('does not price hybrid runs with a single provider rate', () => {
    printSummaryTable(summary({ provider: 'hybrid' }));
    expect(output).toContain('n/a (hybrid');
  });

  it('falls back to the provider recorded for the run', () => {
    setCostProvider('anthropic');
    printSummaryTable(summary({ provider: undefined }));
    expect(output).toContain('$0.1227');
  });

  it('uses the precomputed cost of a run served by several providers', () => {
    printSummaryTable(summary({ provider: 'openai', estimatedCostUsd: 0.4212 }));
    expect(output).toContain('$0.4212');
  });

  it('keeps the unknown rate of a hybrid run even when a cost was computed', () => {
    printSummaryTable(summary({ provider: 'hybrid', estimatedCostUsd: 0.4212 }));
    expect(output).toContain('n/a (hybrid');
  });
});

describe('progress bar cost', () => {
  beforeEach(() => setCostProvider('openai'));

  it('prices the running total from the active provider', () => {
    startProgress(10, 1, 'anthropic');
    updateProgress(5, 1, 500_000, 100_000);
    // 0.5M*15 + 0.1M*75 = 7.5 + 7.5
    expect(barUpdate).toHaveBeenLastCalledWith(5, {
      batch: 1,
      totalBatches: 1,
      cost: '15.00',
    });
  });

  it('keeps the recorded provider when the caller does not pass one', () => {
    setCostProvider('anthropic');
    startProgress(10, 1);
    updateProgress(5, 1, 500_000, 100_000);
    expect(barUpdate).toHaveBeenLastCalledWith(5, {
      batch: 1,
      totalBatches: 1,
      cost: '15.00',
    });
  });

  it('does not price a hybrid run with a single provider rate', () => {
    startProgress(10, 1, 'hybrid');
    updateProgress(5, 1, 500_000, 100_000);
    expect(barUpdate).toHaveBeenLastCalledWith(5, {
      batch: 1,
      totalBatches: 1,
      cost: 'n/a',
    });
  });

  it('prices each batch with the provider that served it', () => {
    startProgress(10, 1, 'openai');
    updateProgress(5, 1, 500_000, 0, 'anthropic');
    // 0.5M*15 = 7.5 at the anthropic rate, not the openai rate
    expect(barUpdate).toHaveBeenLastCalledWith(5, {
      batch: 1,
      totalBatches: 1,
      cost: '7.50',
    });
  });

  it('sums the batches of several providers', () => {
    startProgress(10, 1, 'openai');
    updateProgress(5, 1, 500_000, 0, 'anthropic');
    updateProgress(10, 1, 1_000_000, 0, 'openai');
    // 7.5 at the anthropic rate plus 2.5 at the openai rate
    expect(barUpdate).toHaveBeenLastCalledWith(10, {
      batch: 1,
      totalBatches: 1,
      cost: '10.00',
    });
  });
});
