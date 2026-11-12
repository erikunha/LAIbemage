import { describe, expect, it } from 'vitest';
import { canonicalJson, fingerprintV2, type FingerprintInput } from '../src/fingerprint.js';

const base: FingerprintInput = {
  model: 'openai/gpt-4o',
  promptTemplate: 'prompt-v1',
  taxonomy: [
    { name: 'kitchen', description: 'Kitchen area with counters and appliances' },
    { name: 'bathroom', description: 'Bathroom with fixtures' },
  ],
  preprocessing: { resize: 1024, detail: 'high' },
  dataVersion: 'legacy-v2',
  contractsVersion: '0.2.0',
};

describe('fingerprint v2 (spec 002; regression for the name-only hash defect)', () => {
  it('changing ONLY a category description changes the digest', () => {
    const mutated: FingerprintInput = {
      ...base,
      taxonomy: base.taxonomy.map((c) =>
        c['name'] === 'kitchen'
          ? { ...c, description: 'Kitchen area, industrial grade, stainless steel' }
          : c,
      ),
    };
    expect(fingerprintV2(mutated)).not.toBe(fingerprintV2(base));
  });

  it('is stable for identical input', () => {
    expect(fingerprintV2(base)).toBe(fingerprintV2(structuredClone(base)));
  });

  it('object key order does not matter (canonical JSON)', () => {
    const reordered: FingerprintInput = {
      contractsVersion: base.contractsVersion,
      dataVersion: base.dataVersion,
      preprocessing: base.preprocessing,
      taxonomy: base.taxonomy,
      promptTemplate: base.promptTemplate,
      model: base.model,
    };
    expect(fingerprintV2(reordered)).toBe(fingerprintV2(base));
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('undefined fields are dropped; category ARRAY order matters (prompt order)', () => {
    const withUndefined = { ...base, preprocessing: { resize: 512, detail: undefined } };
    const explicit = { ...base, preprocessing: { resize: 512 } };
    expect(fingerprintV2(withUndefined)).toBe(fingerprintV2(explicit));

    const reorderedTaxonomy: FingerprintInput = { ...base, taxonomy: [...base.taxonomy].reverse() };
    expect(fingerprintV2(reorderedTaxonomy)).not.toBe(fingerprintV2(base));
  });

  it('every input dimension is load-bearing', () => {
    const variants: Partial<FingerprintInput>[] = [
      { model: 'anthropic/claude-opus-4-7' },
      { promptTemplate: 'prompt-v2' },
      { preprocessing: { resize: 512 } },
      { dataVersion: 'snap-42' },
      { contractsVersion: '1.0.0' },
    ];
    for (const v of variants) {
      expect(fingerprintV2({ ...base, ...v })).not.toBe(fingerprintV2(base));
    }
  });

  it('carries the fp2 domain separator', () => {
    expect(fingerprintV2(base)).toMatch(/^fp2:[0-9a-f]{16}$/);
  });
});
