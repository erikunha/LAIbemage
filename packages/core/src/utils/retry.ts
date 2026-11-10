import { logger } from './logger.js';

export interface RetryOptions {
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly label?: string;
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const { maxAttempts, delayMs, label = 'operation' } = options;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const err = error as Error & { status?: number; code?: string };

      // Quota exceeded — non-recoverable, surface immediately
      const isQuota =
        err.message?.includes('exceeded your current quota') || // OpenAI
        err.code === 'insufficient_quota' || // OpenAI
        err.message?.includes('credit balance is too low') || // Anthropic
        err.status === 402 || // Anthropic HTTP 402
        (err.message?.toLowerCase().includes('quota') && // Google non-rate quota
          !err.message?.toLowerCase().includes('rate') &&
          err.status !== 429);
      if (isQuota) {
        throw new Error(
          `QUOTA_EXCEEDED: Your API account has no remaining credits.\n` +
            `  OpenAI:    https://platform.openai.com/account/billing\n` +
            `  Anthropic: https://console.anthropic.com/settings/billing\n` +
            `  Google:    https://aistudio.google.com/`,
          { cause: error },
        );
      }

      const is429 = err.status === 429 || err.message?.includes('429');
      if (is429 && attempt < maxAttempts) {
        logger.warn(
          `  Rate limit on ${label}. Waiting ${delayMs / 1000}s (retry ${attempt}/${maxAttempts})...`,
        );
        await sleep(delayMs);
        continue;
      }

      if (attempt < maxAttempts) {
        const backoff = delayMs * attempt;
        logger.warn(
          `  ${label} failed (attempt ${attempt}/${maxAttempts}). Retrying in ${backoff / 1000}s...`,
        );
        await sleep(backoff);
        continue;
      }

      throw err;
    }
  }

  throw new Error(`${label} failed after ${maxAttempts} attempts`);
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
