import { afterEach, describe, expect, it, vi } from 'vitest';

// dotenv is mocked so loadConfig never reads the repository .env file: no API
// keys are loaded and the ambient environment cannot leak into the assertions.
vi.mock('dotenv', () => ({
  config: () => ({ parsed: {} }),
}));

import { loadConfig, parseRetryCount } from '../../src/config/index.js';

// skipAnalysis skips API-key validation so no credentials are needed.
const base = { skipAnalysis: true, provider: 'anthropic' };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('loadConfig anthropic workspace id', () => {
  it('reads ANTHROPIC_WORKSPACE_ID from the environment', async () => {
    vi.stubEnv('ANTHROPIC_WORKSPACE_ID', 'wrkspc_env');
    const config = await loadConfig(base);
    expect(config.anthropicWorkspaceId).toBe('wrkspc_env');
  });

  it('prefers the CLI flag over the environment', async () => {
    vi.stubEnv('ANTHROPIC_WORKSPACE_ID', 'wrkspc_env');
    const config = await loadConfig({ ...base, anthropicWorkspaceId: 'wrkspc_cli' });
    expect(config.anthropicWorkspaceId).toBe('wrkspc_cli');
  });

  it('is undefined when the value is empty', async () => {
    vi.stubEnv('ANTHROPIC_WORKSPACE_ID', '');
    const config = await loadConfig(base);
    expect(config.anthropicWorkspaceId).toBeUndefined();
  });
});

describe('loadConfig maxRetries', () => {
  it('falls back to 3 when the value is not a number', async () => {
    const config = await loadConfig({ ...base, maxRetries: Number.NaN });
    expect(config.maxRetries).toBe(3);
  });

  it('keeps 0 (no retries)', async () => {
    const config = await loadConfig({ ...base, maxRetries: 0 });
    expect(config.maxRetries).toBe(0);
  });

  it('clamps negative values to 0', async () => {
    const config = await loadConfig({ ...base, maxRetries: -2 });
    expect(config.maxRetries).toBe(0);
  });

  it('defaults to 3', async () => {
    vi.stubEnv('MAX_RETRIES', undefined);
    const config = await loadConfig(base);
    expect(config.maxRetries).toBe(3);
  });
});

describe('parseRetryCount', () => {
  it('keeps a positive count', () => {
    expect(parseRetryCount(3)).toBe(3);
  });

  it('keeps 0 (no retries)', () => {
    expect(parseRetryCount(0)).toBe(0);
  });

  it('turns a negative count into 0', () => {
    expect(parseRetryCount(-2)).toBe(0);
  });

  it('falls back to 3 for a value that is not a number', () => {
    expect(parseRetryCount(Number.NaN)).toBe(3);
    expect(parseRetryCount(Number.POSITIVE_INFINITY)).toBe(3);
  });
});
