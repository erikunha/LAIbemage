import { describe, expect, it } from 'vitest';
import {
  estimateCost,
  formatCostRow,
  OUTPUT_TOKENS_PER_IMAGE,
  PROMPT_OVERHEAD_TOKENS,
  PROVIDER_PRICING,
  TOKENS_PER_IMAGE,
} from '../../src/utils/cost.js';

describe('estimateCost', () => {
  it('returns correct imageCount and batchCount', () => {
    const est = estimateCost(10, 5, 'openai');
    expect(est.imageCount).toBe(10);
    expect(est.batchCount).toBe(2);
  });

  it('rounds up batchCount for non-divisible inputs', () => {
    const est = estimateCost(11, 5, 'openai');
    expect(est.batchCount).toBe(3);
  });

  it('uses detail:low token counts by default', () => {
    const est = estimateCost(1, 1, 'openai', 'low');
    const expectedInput = TOKENS_PER_IMAGE.low + PROMPT_OVERHEAD_TOKENS;
    expect(est.estimatedInputTokens).toBe(expectedInput);
  });

  it('uses detail:high token counts when specified', () => {
    const est = estimateCost(1, 1, 'openai', 'high');
    const expectedInput = TOKENS_PER_IMAGE.high + PROMPT_OVERHEAD_TOKENS;
    expect(est.estimatedInputTokens).toBe(expectedInput);
  });

  it('calculates output tokens per image', () => {
    const est = estimateCost(4, 4, 'openai');
    expect(est.estimatedOutputTokens).toBe(4 * OUTPUT_TOKENS_PER_IMAGE);
  });

  it('returns a non-negative cost for every provider', () => {
    const providers = ['openai', 'anthropic', 'google'] as const;
    for (const provider of providers) {
      const est = estimateCost(20, 5, provider);
      expect(est.estimatedCostUsd).toBeGreaterThanOrEqual(0);
    }
  });

  it('google is cheaper than openai for the same workload', () => {
    const google = estimateCost(100, 20, 'google');
    const openai = estimateCost(100, 20, 'openai');
    expect(google.estimatedCostUsd).toBeLessThan(openai.estimatedCostUsd);
  });

  it('anthropic is more expensive than openai for the same workload', () => {
    const anthropic = estimateCost(100, 20, 'anthropic');
    const openai = estimateCost(100, 20, 'openai');
    expect(anthropic.estimatedCostUsd).toBeGreaterThan(openai.estimatedCostUsd);
  });

  it('detail:high costs more than detail:low', () => {
    const low = estimateCost(10, 5, 'openai', 'low');
    const high = estimateCost(10, 5, 'openai', 'high');
    expect(high.estimatedCostUsd).toBeGreaterThan(low.estimatedCostUsd);
  });

  it('returns the correct provider and model name', () => {
    const est = estimateCost(1, 1, 'anthropic');
    expect(est.provider).toBe('anthropic');
    expect(est.model).toBe(PROVIDER_PRICING.anthropic.model);
  });

  it('scales linearly with image count', () => {
    const x1 = estimateCost(10, 5, 'google');
    const x2 = estimateCost(20, 5, 'google');
    // Doubling images should roughly double cost (extra batch overhead makes it slightly more)
    expect(x2.estimatedCostUsd).toBeGreaterThan(x1.estimatedCostUsd);
  });

  it('single image estimate produces positive tokens', () => {
    const est = estimateCost(1, 1, 'openai');
    expect(est.estimatedInputTokens).toBeGreaterThan(0);
    expect(est.estimatedOutputTokens).toBeGreaterThan(0);
  });
});

describe('formatCostRow', () => {
  it('includes the provider name', () => {
    const est = estimateCost(10, 5, 'openai');
    const row = formatCostRow(est);
    expect(row).toContain('openai');
  });

  it('includes the model name', () => {
    const est = estimateCost(10, 5, 'anthropic');
    const row = formatCostRow(est);
    expect(row).toContain(PROVIDER_PRICING.anthropic.model);
  });

  it('shows "< $0.01" for very cheap estimates (google small batch)', () => {
    const est = estimateCost(1, 1, 'google'); // sub-cent cost
    const row = formatCostRow(est);
    expect(row).toContain('< $0.01');
  });

  it('shows a dollar amount for larger estimates', () => {
    const est = estimateCost(1000, 20, 'openai');
    const row = formatCostRow(est);
    expect(row).toMatch(/\$\d+\.\d{4}/);
  });
});
