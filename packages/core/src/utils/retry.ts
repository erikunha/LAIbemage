import { logger } from './logger.js';

export interface RetryOptions {
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly label?: string;
}

/**
 * HTTP statuses that cannot succeed on a retry: a bad request, an invalid or
 * forbidden key, a missing model or an unprocessable payload. They surface
 * immediately instead of burning the whole retry budget.
 */
export const NON_RETRYABLE_STATUSES: ReadonlySet<number> = new Set([400, 401, 403, 404, 422]);

/** Error shapes that carry an HTTP status in one of the provider SDK conventions. */
interface StatusCarrier {
  readonly status?: unknown;
  readonly code?: unknown;
  readonly $metadata?: { readonly httpStatusCode?: unknown } | undefined;
  readonly cause?: unknown;
}

/** Keep only finite numbers: a status is an HTTP code, never a NaN or a string. */
function asHttpStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * The HTTP status of a provider error, normalised across the SDK conventions:
 *  - `status` on the error itself (OpenAI, Google Generative AI, Anthropic)
 *  - `$metadata.httpStatusCode` (AWS SDK, used by Bedrock)
 *  - `cause.code` (Vertex wraps the Google API error in `cause`)
 *
 * Values that are not numeric HTTP codes are ignored, so the canonical status
 * strings of Vertex (for example `PERMISSION_DENIED`) never turn into NaN.
 */
export function extractStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;

  let carrier = error as StatusCarrier;
  for (let depth = 0; depth < 3 && carrier; depth++) {
    const direct = asHttpStatus(carrier.status);
    if (direct !== undefined) return direct;

    const metadata = carrier.$metadata;
    if (metadata && typeof metadata === 'object') {
      const metaStatus = asHttpStatus(metadata.httpStatusCode);
      if (metaStatus !== undefined) return metaStatus;
    }

    const cause = carrier.cause;
    if (cause && typeof cause === 'object') {
      const causeStatus = asHttpStatus((cause as StatusCarrier).code);
      if (causeStatus !== undefined) return causeStatus;
      carrier = cause as StatusCarrier;
      continue;
    }

    break;
  }

  return undefined;
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const { delayMs, label = 'operation' } = options;
  // At least one attempt always runs, even with maxAttempts 0 (--max-retries 0).
  const maxAttempts = Math.max(1, options.maxAttempts);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const err = error as Error & { code?: string };
      // The status is read through the provider conventions, so a Bedrock or
      // Vertex error is classified like an OpenAI or Anthropic error.
      const status = extractStatusCode(error);

      // Quota exceeded: non-recoverable, surface immediately
      const isQuota =
        err.message?.includes('exceeded your current quota') || // OpenAI
        err.code === 'insufficient_quota' || // OpenAI
        err.message?.includes('credit balance is too low') || // Anthropic
        status === 402 || // Anthropic HTTP 402
        (err.message?.toLowerCase().includes('quota') && // Google non-rate quota
          !err.message?.toLowerCase().includes('rate') &&
          status !== 429);
      if (isQuota) {
        throw new Error(
          `QUOTA_EXCEEDED: Your API account has no remaining credits.\n` +
            `  OpenAI:    https://platform.openai.com/account/billing\n` +
            `  Anthropic: https://console.anthropic.com/settings/billing\n` +
            `  Google:    https://aistudio.google.com/`,
          { cause: error },
        );
      }

      // Client errors that cannot succeed on a retry, surface immediately
      if (status !== undefined && NON_RETRYABLE_STATUSES.has(status)) {
        throw err;
      }

      const is429 = status === 429 || err.message?.includes('429');
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

/** Total attempts for a configured number of retries: the first try plus each retry. */
export const attemptsFor = (maxRetries: number): number => Math.max(0, maxRetries) + 1;
