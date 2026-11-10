/**
 * Token-cost estimation utilities for the --estimate flag.
 *
 * Prices last verified: May 2026
 * Always confirm current prices at the provider's pricing page before relying on these figures.
 *
 * Sources:
 *  OpenAI:    https://openai.com/pricing
 *  Anthropic: https://www.anthropic.com/pricing
 *  Google:    https://ai.google.dev/pricing
 */

import type { LLMProvider } from '../config/index.js';

// ---------------------------------------------------------------------------
// Per-provider pricing (USD per 1 000 000 tokens)
// ---------------------------------------------------------------------------

interface ProviderPricing {
  /** Human-readable default model name */
  readonly model: string;
  /** Input token cost in USD / 1M tokens */
  readonly inputPerMillion: number;
  /** Output token cost in USD / 1M tokens */
  readonly outputPerMillion: number;
}

/** # prices as of May 2026 — update when providers change rates */
export const PROVIDER_PRICING: Record<LLMProvider, ProviderPricing> = {
  openai: {
    model: 'gpt-4o',
    inputPerMillion: 2.5,
    outputPerMillion: 10.0,
  },
  anthropic: {
    model: 'claude-opus-4-7',
    inputPerMillion: 15.0,
    outputPerMillion: 75.0,
  },
  google: {
    model: 'gemini-2.0-flash',
    inputPerMillion: 0.075,
    outputPerMillion: 0.3,
  },
  azure: {
    model: 'gpt-4o (deployment)',
    inputPerMillion: 2.5, // Same as OpenAI gpt-4o; actual cost depends on Azure region/agreement
    outputPerMillion: 10.0,
  },
  ollama: {
    model: 'local (no cost)',
    inputPerMillion: 0,
    outputPerMillion: 0,
  },
  hybrid: {
    model: 'ollama (local) + cloud tier-2',
    inputPerMillion: 0,
    outputPerMillion: 0,
  },
  bedrock: {
    model: 'claude-opus-4-7 (via Bedrock)',
    inputPerMillion: 15.0, // same as Anthropic direct
    outputPerMillion: 75.0,
  },
  vertex: {
    model: 'gemini-2.0-flash (via Vertex)',
    inputPerMillion: 0.075, // same as Google direct
    outputPerMillion: 0.3,
  },
};

// ---------------------------------------------------------------------------
// Token estimates per image (detail levels)
// ---------------------------------------------------------------------------

/**
 * Approximate input tokens consumed per image in a batch call.
 *  - detail:low  uses a fixed 85-token tile (OpenAI spec; Anthropic/Google are similar)
 *  - detail:high uses a 765-token full-resolution breakdown
 */
export const TOKENS_PER_IMAGE: Record<'low' | 'high', number> = {
  low: 85,
  high: 765,
};

/** System-prompt + JSON schema overhead per batch call (rough estimate). */
export const PROMPT_OVERHEAD_TOKENS = 500;

/** Approximate output tokens per image in the JSON response. */
export const OUTPUT_TOKENS_PER_IMAGE = 80;

// ---------------------------------------------------------------------------
// Estimation API
// ---------------------------------------------------------------------------

export interface CostEstimate {
  readonly provider: LLMProvider;
  readonly model: string;
  readonly imageCount: number;
  readonly batchCount: number;
  readonly estimatedInputTokens: number;
  readonly estimatedOutputTokens: number;
  readonly estimatedCostUsd: number;
}

/**
 * Estimate the total API cost for a run.
 *
 * @param imageCount  Total number of images to be processed.
 * @param batchSize   Images per API call.
 * @param provider    The selected LLM provider.
 * @param detail      Vision detail level used in the batch pass.
 */
export function estimateCost(
  imageCount: number,
  batchSize: number,
  provider: LLMProvider,
  detail: 'low' | 'high' = 'low',
): CostEstimate {
  const batchCount = Math.ceil(imageCount / batchSize);
  const pricing = PROVIDER_PRICING[provider];

  const inputTokens = imageCount * TOKENS_PER_IMAGE[detail] + batchCount * PROMPT_OVERHEAD_TOKENS;
  const outputTokens = imageCount * OUTPUT_TOKENS_PER_IMAGE;

  const costUsd =
    (inputTokens / 1_000_000) * pricing.inputPerMillion +
    (outputTokens / 1_000_000) * pricing.outputPerMillion;

  return {
    provider,
    model: pricing.model,
    imageCount,
    batchCount,
    estimatedInputTokens: Math.round(inputTokens),
    estimatedOutputTokens: Math.round(outputTokens),
    estimatedCostUsd: costUsd,
  };
}

/**
 * Format a cost estimate as a human-readable table row.
 * The returned string has no trailing newline.
 */
export function formatCostRow(estimate: CostEstimate): string {
  const cost =
    estimate.estimatedCostUsd < 0.01 ? `< $0.01` : `$${estimate.estimatedCostUsd.toFixed(4)}`;

  return (
    `  ${estimate.provider.padEnd(10)}` +
    `${estimate.model.padEnd(22)}` +
    `${String(estimate.estimatedInputTokens).padStart(10)} in` +
    `${String(estimate.estimatedOutputTokens).padStart(8)} out` +
    `   ${cost}`
  );
}

/**
 * Print a formatted cost-estimate table for all three providers to stdout.
 * Exits the process immediately after printing.
 */
export function printCostEstimate(
  imageCount: number,
  batchSize: number,
  detail: 'low' | 'high' = 'low',
): void {
  const providers: LLMProvider[] = ['openai', 'anthropic', 'google'];
  const estimates = providers.map((p) => estimateCost(imageCount, batchSize, p, detail));

  const header = `
Cost estimate — ${imageCount} image(s) · batch size ${batchSize} · detail:${detail}
${'─'.repeat(72)}
  Provider   Model                  Input tokens  Output    Est. cost
${'─'.repeat(72)}`;

  console.log(header);
  for (const est of estimates) {
    console.log(formatCostRow(est));
  }
  console.log('─'.repeat(72));
  console.log(
    '\nEstimated — actual cost may vary based on image content and provider pricing changes.',
  );
  console.log(
    'Verify current pricing at: https://openai.com/pricing · https://anthropic.com/pricing · https://ai.google.dev/pricing\n',
  );
}
