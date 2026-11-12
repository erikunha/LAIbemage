import { describe, expect, it, vi } from 'vitest';
import { attemptsFor, extractStatusCode, sleep, withRetry } from '../../src/utils/retry.js';

// All retry tests use delayMs: 0 and real timers so sleep(0) resolves immediately.
describe('withRetry', () => {
  it('returns the value on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, { maxAttempts: 3, delayMs: 100 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on generic error and eventually succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('timeout'), { status: 500 }))
      .mockRejectedValueOnce(Object.assign(new Error('timeout'), { status: 500 }))
      .mockResolvedValue('ok');

    const promise = withRetry(fn, { maxAttempts: 3, delayMs: 0 });
    await promise;
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws immediately on quota exceeded (insufficient_quota code)', async () => {
    const quotaErr = Object.assign(new Error('exceeded your current quota'), {
      code: 'insufficient_quota',
    });
    const fn = vi.fn().mockRejectedValue(quotaErr);

    await expect(withRetry(fn, { maxAttempts: 3, delayMs: 0 })).rejects.toThrow('QUOTA_EXCEEDED');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws immediately on quota exceeded (message match)', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('exceeded your current quota'));
    await expect(withRetry(fn, { maxAttempts: 3, delayMs: 0 })).rejects.toThrow('QUOTA_EXCEEDED');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 rate limit errors', async () => {
    const rateLimitErr = Object.assign(new Error('rate limit'), { status: 429 });
    const fn = vi.fn().mockRejectedValueOnce(rateLimitErr).mockResolvedValue('done');

    const result = await withRetry(fn, { maxAttempts: 3, delayMs: 0 });
    expect(result).toBe('done');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws after exhausting all retries', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('persistent error'));
    await expect(withRetry(fn, { maxAttempts: 2, delayMs: 0 })).rejects.toThrow('persistent error');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws immediately on Anthropic HTTP 402 (credit balance too low)', async () => {
    const err = Object.assign(new Error('credit balance is too low'), { status: 402 });
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn, { maxAttempts: 3, delayMs: 0 })).rejects.toThrow('QUOTA_EXCEEDED');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws immediately on Anthropic HTTP 402 status code alone', async () => {
    const err = Object.assign(new Error('payment required'), { status: 402 });
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn, { maxAttempts: 3, delayMs: 0 })).rejects.toThrow('QUOTA_EXCEEDED');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws immediately on Google non-rate quota error', async () => {
    // Google quota errors include "quota" but NOT "rate" and NOT status 429
    const err = Object.assign(new Error('Quota exceeded for project'), { status: 403 });
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn, { maxAttempts: 3, delayMs: 0 })).rejects.toThrow('QUOTA_EXCEEDED');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does NOT treat Google rate-limit as quota exceeded (retries instead)', async () => {
    // "quota" + "rate" together = a rate limit, not a billing quota — should retry
    const err = Object.assign(new Error('rate quota exceeded'), { status: 429 });
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');
    const result = await withRetry(fn, { maxAttempts: 3, delayMs: 0 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('withRetry non-recoverable client errors', () => {
  it.each([400, 401, 403, 404, 422])('throws immediately on status %i', async (status) => {
    const err = Object.assign(new Error(`HTTP ${status}`), { status });
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn, { maxAttempts: 3, delayMs: 0 })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it.each([408, 409, 429, 500, 503])('still retries status %i', async (status) => {
    const err = Object.assign(new Error(`HTTP ${status}`), { status });
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');
    await expect(withRetry(fn, { maxAttempts: 3, delayMs: 0 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('withRetry attempt floor', () => {
  it('performs one attempt when maxAttempts is 0 (--max-retries 0)', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(withRetry(fn, { maxAttempts: 0, delayMs: 0 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('surfaces the original error after the single attempt when maxAttempts is 0', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(withRetry(fn, { maxAttempts: 0, delayMs: 0 })).rejects.toThrow('boom');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('sleep', () => {
  it('resolves after the given duration', async () => {
    vi.useFakeTimers();
    const promise = sleep(500);
    vi.advanceTimersByTime(500);
    await expect(promise).resolves.toBeUndefined();
    vi.useRealTimers();
  });
});

describe('attemptsFor', () => {
  it('counts the first try plus each retry', () => {
    expect(attemptsFor(0)).toBe(1);
    expect(attemptsFor(3)).toBe(4);
  });

  it('treats negative retries as none', () => {
    expect(attemptsFor(-2)).toBe(1);
  });
});

describe('extractStatusCode', () => {
  it('reads the top-level status used by OpenAI, Google and Anthropic', () => {
    expect(extractStatusCode(Object.assign(new Error('boom'), { status: 429 }))).toBe(429);
  });

  it('reads the AWS SDK metadata status used by Bedrock', () => {
    const err = Object.assign(new Error('access denied'), {
      $metadata: { httpStatusCode: 403 },
    });
    expect(extractStatusCode(err)).toBe(403);
  });

  it('reads the nested cause code used by Vertex', () => {
    const err = Object.assign(new Error('permission denied'), {
      cause: { code: 403, status: 'PERMISSION_DENIED' },
    });
    expect(extractStatusCode(err)).toBe(403);
  });

  it('ignores non-numeric status strings instead of producing NaN', () => {
    const err = Object.assign(new Error('permission denied'), {
      cause: { status: 'PERMISSION_DENIED' },
    });
    expect(extractStatusCode(err)).toBeUndefined();
  });

  it('returns undefined for an error without a status', () => {
    expect(extractStatusCode(new Error('boom'))).toBeUndefined();
  });
});

describe('withRetry provider status extraction', () => {
  it('throws immediately on a Bedrock 403 carried in the AWS metadata', async () => {
    const err = Object.assign(new Error('Access denied'), { $metadata: { httpStatusCode: 403 } });
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withRetry(fn, { maxAttempts: 3, delayMs: 0 })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws immediately on a Vertex 404 carried in the nested cause', async () => {
    const err = Object.assign(new Error('model not found'), {
      cause: { code: 404, status: 'NOT_FOUND' },
    });
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withRetry(fn, { maxAttempts: 3, delayMs: 0 })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a Bedrock 500 carried in the AWS metadata', async () => {
    const err = Object.assign(new Error('server error'), { $metadata: { httpStatusCode: 500 } });
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');

    await expect(withRetry(fn, { maxAttempts: 3, delayMs: 0 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries a Vertex 429 rate limit instead of reporting a quota problem', async () => {
    const err = Object.assign(new Error('Quota exceeded for quota metric'), {
      cause: { code: 429, status: 'RESOURCE_EXHAUSTED' },
    });
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');

    await expect(withRetry(fn, { maxAttempts: 3, delayMs: 0 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
