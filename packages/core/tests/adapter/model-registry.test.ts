/**
 * The model capability registry (spec 019, VLN-005).
 *
 * The registry file grew a second array: `models`, the platform's record of
 * what a model IS before it is used (which bytes, which license, which
 * devices, which revision). The dataset array and every field in it did not
 * change, so the readers that have nothing to do with models must keep
 * working exactly as they were.
 *
 * What this file proves:
 *
 *  - the tracked registry parses and carries the pinned model record;
 *  - the accessor resolves a recorded model and refuses an unknown one with
 *    a typed error that names the model;
 *  - a registry WITHOUT the models key is still read (format version 1), and
 *    resolving a model against it is a refusal, never a default;
 *  - a record that cannot be trusted is refused, each refusal naming the
 *    offending field: no digest, no license, no device support, or the
 *    floating revision `latest`;
 *  - the write path preserves the models array, so recording a dataset
 *    checksum never silently drops the model records.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DATASET_REGISTRY_SCHEMA_VERSION,
  findModel,
  loadDatasetRegistry,
  parseDatasetRegistry,
  saveDatasetRegistry,
  type DatasetRegistryEntry,
  type ModelRegistryEntry,
} from '../../src/benchmark/registry.js';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);
const TRACKED_REGISTRY = path.join(REPO_ROOT, 'datasets', 'registry.json');

/** A dataset entry that satisfies the schema, so a test can vary one thing. */
function validDataset(): DatasetRegistryEntry {
  return {
    id: 'fixture',
    title: 'A fixture dataset',
    usage: 'benchmark',
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    commercialUse: true,
    source: 'https://example.test/source',
    resource: 'https://example.test/resource',
    version: 'v1',
    archiveBytes: null,
    etag: null,
    parts: { selected: ['alpha'], rationale: 'the fixture strata' },
    sha256: null,
    sha256PinnedAt: null,
    attribution: 'The fixture authors.',
    fetchedAt: null,
    notes: '',
  };
}

/** A model record that satisfies the schema, so a test can vary one thing. */
function validModel(): ModelRegistryEntry {
  return {
    modelId: 'siglip2-base',
    revision: '75de2d55ec2d0b4efc50b3e9ad70dba96a7b2fa2',
    sourceUri:
      'https://huggingface.co/google/siglip2-base-patch16-224/resolve/75de2d55/model.safetensors',
    sourceDigest: '612923381c76ec5a9bed335d1c48827e3f2e506ac31b044b63b2031fadee6a0b',
    license: 'apache-2.0',
    licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
    commercialUse: true,
    usageRestrictions: '',
    requiredExtras: ['vision'],
    tasks: ['image-embedding'],
    preprocessingFingerprint: 'fp2:83adc4ef99979644',
    deviceSupport: ['cpu'],
    inputImageSize: { width: 224, height: 224 },
    featureExtractor: 'siglip_vision_model',
    outputShape: { dimension: 768 },
    latencyCostProfile: 'unknown',
    calibrationStatus: 'uncalibrated',
    trustPolicy: 'allowlisted-pinned-safetensors-only',
    attribution: 'The fixture authors.',
    notes: '',
  };
}

describe('the tracked registry carries the model capability record', () => {
  it('parses and names the pinned encoder', async () => {
    const registry = await loadDatasetRegistry(TRACKED_REGISTRY);

    expect(registry.schemaVersion).toBe(DATASET_REGISTRY_SCHEMA_VERSION);
    expect(registry.models).toHaveLength(1);

    const model = findModel(registry, 'siglip2-base');
    // A pinned record: an exact revision and the digest of the bytes.
    expect(model.revision).toBe('75de2d55ec2d0b4efc50b3e9ad70dba96a7b2fa2');
    expect(model.sourceDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(model.license).toBe('apache-2.0');
    expect(model.commercialUse).toBe(true);
    expect(model.deviceSupport).toContain('cpu');
    expect(model.outputShape.dimension).toBe(768);
  });

  it('the dataset array is untouched by the model record', async () => {
    const registry = await loadDatasetRegistry(TRACKED_REGISTRY);

    // The datasets still read exactly as they did: the id, the usage and the
    // license gate are the constitutional facts they always were.
    expect(registry.datasets.map((entry) => entry.id)).toEqual(['visa-subset', 'mvtec-ad']);
    expect(registry.datasets[0]?.sha256).toBe(
      '2eb8690c803ab37de0324772964100169ec8ba1fa3f7e94291c9ca673f40f362',
    );
  });
});

describe('the models accessor', () => {
  it('refuses a model the registry does not carry, naming the model', () => {
    const registry = parseDatasetRegistry({
      schemaVersion: DATASET_REGISTRY_SCHEMA_VERSION,
      datasets: [validDataset()],
      models: [validModel()],
    });

    expect(() => findModel(registry, 'not-a-model')).toThrow(/not-a-model/);
    try {
      findModel(registry, 'not-a-model');
      expect.unreachable('the refusal must throw');
    } catch (error) {
      const issues = (error as { issues?: readonly string[] }).issues ?? [];
      expect(issues.join(' ')).toContain('siglip2-base');
    }
  });

  it('reads a registry without the models key and refuses every model', () => {
    // Format version 1: no models array at all. The reader must not break on
    // a file that predates the model registry.
    const registry = parseDatasetRegistry({
      schemaVersion: 1,
      datasets: [validDataset()],
    });

    expect(registry.models).toBeUndefined();
    expect(() => findModel(registry, 'siglip2-base')).toThrow(/No model 'siglip2-base'/);
  });

  it('refuses a version 1 registry that carries model records', () => {
    // Version 1 is the format before the models array existed. A file that
    // claims version 1 and carries records anyway is inconsistent, and the
    // Python reader refuses it the same way.
    expect(() =>
      parseDatasetRegistry({
        schemaVersion: 1,
        datasets: [validDataset()],
        models: [validModel()],
      }),
    ).toThrow(/models/);
  });
});

describe('a model record that cannot be trusted is refused', () => {
  it('refuses a record with no digest, naming the field', () => {
    const model = { ...validModel(), sourceDigest: '' };

    expect(() =>
      parseDatasetRegistry({
        schemaVersion: DATASET_REGISTRY_SCHEMA_VERSION,
        datasets: [validDataset()],
        models: [model],
      }),
    ).toThrow(/sourceDigest/);
  });

  it('refuses a record with no license, naming the field', () => {
    const model = { ...validModel(), license: '' };

    expect(() =>
      parseDatasetRegistry({
        schemaVersion: DATASET_REGISTRY_SCHEMA_VERSION,
        datasets: [validDataset()],
        models: [model],
      }),
    ).toThrow(/license/);
  });

  it('refuses a record with no device support, naming the field', () => {
    const model = { ...validModel(), deviceSupport: [] };

    expect(() =>
      parseDatasetRegistry({
        schemaVersion: DATASET_REGISTRY_SCHEMA_VERSION,
        datasets: [validDataset()],
        models: [model],
      }),
    ).toThrow(/deviceSupport/);
  });

  it('refuses a weights location that does not name a host', () => {
    // `z.url()` accepts `mailto:` and `urn:`, which are not places bytes
    // live. The Python reader refuses them, so the TypeScript reader does
    // too: one refusal means one thing in both languages.
    for (const sourceUri of ['mailto:weights@example.test', 'file:///tmp/model.safetensors']) {
      const model = { ...validModel(), sourceUri };

      expect(() =>
        parseDatasetRegistry({
          schemaVersion: DATASET_REGISTRY_SCHEMA_VERSION,
          datasets: [validDataset()],
          models: [model],
        }),
      ).toThrow(/sourceUri/);
    }
  });

  it('refuses the floating revision, naming the field', () => {
    const model = { ...validModel(), revision: 'latest' };

    expect(() =>
      parseDatasetRegistry({
        schemaVersion: DATASET_REGISTRY_SCHEMA_VERSION,
        datasets: [validDataset()],
        models: [model],
      }),
    ).toThrow(/revision/);
  });
});

describe('the write path preserves the model records', () => {
  it('saving the registry keeps the models array', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'visionlens-model-registry-'));
    try {
      const target = path.join(dir, 'registry.json');
      const registry = parseDatasetRegistry({
        schemaVersion: DATASET_REGISTRY_SCHEMA_VERSION,
        datasets: [validDataset()],
        models: [validModel()],
      });

      await saveDatasetRegistry(target, registry);
      const reloaded = await loadDatasetRegistry(target);

      expect(reloaded.models).toHaveLength(1);
      expect(findModel(reloaded, 'siglip2-base').sourceDigest).toBe(validModel().sourceDigest);
      // The bytes on disk carry the array too, not only the parsed value.
      const raw = JSON.parse(readFileSync(target, 'utf8')) as { models?: unknown[] };
      expect(raw.models).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
