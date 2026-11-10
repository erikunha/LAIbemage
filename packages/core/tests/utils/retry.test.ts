import { describe, expect, it, vi } from 'vitest';
import { sleep, withRetry } from '../../src/utils/retry.js';

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

describe('sleep', () => {
  it('resolves after the given duration', async () => {
    vi.useFakeTimers();
    const promise = sleep(500);
    vi.advanceTimersByTime(500);
    await expect(promise).resolves.toBeUndefined();
    vi.useRealTimers();
  });
});
