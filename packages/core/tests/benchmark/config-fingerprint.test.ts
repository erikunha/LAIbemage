import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  computeConfigFingerprint,
  DEFAULT_BENCHMARK_BATCH_SIZE,
  PROMPT_TEMPLATE_VERSION,
} from '../../src/benchmark/config-fingerprint.js';
import type { SplitManifest } from '../../src/benchmark/splits.js';

/** A manifest with one normal image and one defective image of two classes. */
function manifestWith(classes: readonly string[]): SplitManifest {
  const assignments = classes.flatMap((objectClass) => [
    {
      id: `${objectClass}/normal.JPG`,
      class: objectClass,
      anomaly: 'normal' as const,
      split: 'train' as const,
      sha256: 'a'.repeat(64),
      path: `${objectClass}/normal.JPG`,
    },
    {
      id: `${objectClass}/defect.JPG`,
      class: objectClass,
      anomaly: 'anomalous' as const,
      split: 'train' as const,
      sha256: 'b'.repeat(64),
      path: `${objectClass}/defect.JPG`,
    },
  ]);

  return {
    schemaVersion: 1,
    id: 'test.gold',
    datasetId: 'visa-subset',
    seed: 42,
    ratios: { train: 0.6, val: 0.2, test: 0.2 },
    strata: [],
    assignments,
    notes: [],
    manifestHash: 'c'.repeat(64),
  } as unknown as SplitManifest;
}

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);

const baseInput = {
  provider: 'openai',
  model: 'gpt-4o',
  modelVersion: 'model:gpt-4o@2024-11-20',
  dataVersion: 'visa-subset@20220922',
};

describe('computeConfigFingerprint', () => {
  it('produces a fingerprint in the fp2 domain', () => {
    const result = computeConfigFingerprint({
      ...baseInput,
      manifest: manifestWith(['candle']),
    });
    expect(result.fingerprint).toMatch(/^fp2:[0-9a-f]{16}$/);
  });

  it('is DETERMINISTIC — the same inputs always produce the same fingerprint', () => {
    const manifest = manifestWith(['candle', 'pcb1']);
    const first = computeConfigFingerprint({ ...baseInput, manifest });
    const second = computeConfigFingerprint({ ...baseInput, manifest });
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.components).toEqual(first.components);
  });

  it('changes when the TAXONOMY changes — the vocabulary is part of the experiment', () => {
    const one = computeConfigFingerprint({ ...baseInput, manifest: manifestWith(['candle']) });
    const two = computeConfigFingerprint({
      ...baseInput,
      manifest: manifestWith(['candle', 'pcb1']),
    });
    expect(two.fingerprint).not.toBe(one.fingerprint);
    expect(two.components.taxonomy.map((category) => category['name'])).toEqual([
      'defect_candle',
      'defect_pcb1',
      'normal',
    ]);
  });

  it('changes when the MODEL VERSION changes', () => {
    const manifest = manifestWith(['candle']);
    const one = computeConfigFingerprint({ ...baseInput, manifest });
    const two = computeConfigFingerprint({
      ...baseInput,
      manifest,
      modelVersion: 'model:gpt-4o@2025-01-01',
    });
    expect(two.fingerprint).not.toBe(one.fingerprint);
  });

  it('changes when the DATA VERSION changes — a different dataset is a different experiment', () => {
    const manifest = manifestWith(['candle']);
    const one = computeConfigFingerprint({ ...baseInput, manifest });
    const two = computeConfigFingerprint({ ...baseInput, manifest, dataVersion: 'visa-subset@2023' });
    expect(two.fingerprint).not.toBe(one.fingerprint);
  });

  it('names every ADR-008 component, with the taxonomy descriptions included', () => {
    const result = computeConfigFingerprint({
      ...baseInput,
      manifest: manifestWith(['candle']),
    });
    expect(result.components.promptTemplate).toBe(PROMPT_TEMPLATE_VERSION);
    expect(result.components.contractsVersion).toMatch(/\d+\.\d+\.\d+/);
    expect(result.components.dataVersion).toBe('visa-subset@20220922');
    expect(result.components.preprocessing['batchSize']).toBe(DEFAULT_BENCHMARK_BATCH_SIZE);
    for (const category of result.components.taxonomy) {
      expect(typeof category['name']).toBe('string');
      expect(String(category['description']).length).toBeGreaterThan(0);
    }
  });

  it('carries no timestamp and no absolute path — a fingerprint that changes on every call compares with nothing', () => {
    const manifest = manifestWith(['candle']);
    const result = computeConfigFingerprint({ ...baseInput, manifest });
    const serialized = JSON.stringify(result.components);
    expect(serialized).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    // Catches the actual home directory on any OS and keeps personal-path
    // literals out of the tree.
    expect(serialized).not.toContain(os.homedir());
  });
});

describe('the config fingerprint CLI', () => {
  it('refuses to compute a fingerprint without a model version', async () => {
    const { main } = await import(
      '../../../../scripts/benchmarks/config-fingerprint.js'
    );
    await expect(
      main(['--split', path.join(REPO_ROOT, 'benchmarks/splits/synthetic-30.gold.json')]),
    ).rejects.toThrow(/model-version/);
  });
});
