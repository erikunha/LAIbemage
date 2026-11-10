import { describe, expect, it } from 'vitest';
import type { CategoryConfig, Config } from '../src/config/index.js';
import { computeAnalysisFingerprint } from '../src/index.js';

// Reuses the repo fixture pattern (AGENTS.md): minimal CategoryConfig + the
// fingerprint-relevant Config fields; the rest is irrelevant to the hash.
function makeConfig(categories: CategoryConfig['categories']): Config {
  return {
    categoryConfig: { categories, pinnedLast: [], immune: [], overridable: [], timezone: 'UTC' },
    provider: 'openai',
    model: 'gpt-4o',
  } as unknown as Config;
}

describe('fingerprint v2 integration (spec 002; regression for src/index.ts:77 defect)', () => {
  it('editing ONLY a category description changes the analysis fingerprint', () => {
    const v1 = makeConfig([
      { name: 'kitchen', description: 'Kitchen area' },
      { name: 'bathroom', description: 'Bathroom' },
    ]);
    const v2 = makeConfig([
      { name: 'kitchen', description: 'Kitchen area, commercial grade' },
      { name: 'bathroom', description: 'Bathroom' },
    ]);
    expect(computeAnalysisFingerprint(v2)).not.toBe(computeAnalysisFingerprint(v1));
  });

  it('same config is stable and carries the fp2 separator (invalidates v1 caches)', () => {
    const cfg = makeConfig([{ name: 'kitchen', description: 'Kitchen area' }]);
    const fp = computeAnalysisFingerprint(cfg);
    expect(fp).toMatch(/^fp2:[0-9a-f]{16}$/);
    expect(computeAnalysisFingerprint(cfg)).toBe(fp);
  });

  it('changing the model changes the fingerprint', () => {
    const a = makeConfig([{ name: 'kitchen', description: 'Kitchen area' }]);
    const b = { ...a, model: 'claude-opus-4-7' };
    expect(computeAnalysisFingerprint(b)).not.toBe(computeAnalysisFingerprint(a));
  });
});
