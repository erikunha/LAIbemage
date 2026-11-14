#!/usr/bin/env node
/**
 * The parity check between the two readers of `datasets/registry.json`.
 *
 * The TypeScript reader (`packages/core/src/benchmark/registry.ts`) and the
 * Python reader (`python/visionlens/src/visionlens/registry/`) read the same
 * file, and the registry is a GATE: a file one reader calls usable the other
 * reader must call usable too, or the two disagree about what the platform
 * may run. That claim is worth a command, not a sentence.
 *
 * The check builds a corpus of malformed registries (every field dropped,
 * emptied, mistyped and nulled, plus the envelope), feeds the same files to
 * both readers, and compares the outcome and the field each one names.
 *
 * Run: `pnpm exec tsx scripts/registry/parity-check.ts`
 *
 * It exits 1 when the two readers disagree about a file. The two naming
 * differences it reports and does NOT fail on are documented in
 * `docs/architecture/model-registry.md`.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseDatasetRegistry } from '../../packages/core/src/benchmark/registry.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A dataset entry that satisfies the schema, so a case varies one thing. */
const DATASET = {
  id: 'fixture',
  title: 'A fixture dataset',
  usage: 'benchmark',
  license: 'CC BY 4.0',
  licenseUrl: 'https://example.test/license',
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

/** A model entry that satisfies the schema, so a case varies one thing. */
const MODEL = {
  modelId: 'siglip2-base',
  revision: '75de2d55ec2d0b4efc50b3e9ad70dba96a7b2fa2',
  sourceUri: 'https://example.test/model.safetensors',
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

/** The values a field is replaced by, one case each. */
const WRONG_VALUES: [string, unknown][] = [
  ['drop', undefined],
  ['empty', ''],
  ['number', 42],
  ['null', null],
  ['list', ['x']],
  ['bool', true],
];

/** A copy of an entry with one field replaced. */
function mutate(entry: Record<string, unknown>, field: string, value: unknown): Record<string, unknown> {
  const copy = { ...entry };
  if (value === undefined) {
    delete copy[field];
  } else {
    copy[field] = value;
  }
  return copy;
}

/** Every malformed registry the check feeds to the two readers. */
function buildCases(): Map<string, unknown> {
  const cases = new Map<string, unknown>();

  for (const field of Object.keys(MODEL)) {
    for (const [name, value] of WRONG_VALUES) {
      cases.set(
        `model-${name}-${field}`,
        { schemaVersion: 2, datasets: [DATASET], models: [mutate(MODEL, field, value)] },
      );
    }
  }
  for (const field of Object.keys(DATASET)) {
    for (const [name, value] of WRONG_VALUES) {
      cases.set(
        `dataset-${name}-${field}`,
        { schemaVersion: 2, datasets: [mutate(DATASET, field, value)], models: [MODEL] },
      );
    }
  }

  cases.set('model-unknown-key', {
    schemaVersion: 2,
    datasets: [DATASET],
    models: [{ ...MODEL, mysteryField: 'x' }],
  });
  cases.set('model-unknown-nested', {
    schemaVersion: 2,
    datasets: [DATASET],
    models: [{ ...MODEL, inputImageSize: { width: 224, height: 224, depth: 3 } }],
  });
  cases.set('model-unknown-shape', {
    schemaVersion: 2,
    datasets: [DATASET],
    models: [{ ...MODEL, outputShape: { dimension: 768, dims: 2 } }],
  });
  cases.set('model-device-outside-the-vocabulary', {
    schemaVersion: 2,
    datasets: [DATASET],
    models: [{ ...MODEL, deviceSupport: ['tpu'] }],
  });
  cases.set('model-device-wrong-case', {
    schemaVersion: 2,
    datasets: [DATASET],
    models: [{ ...MODEL, deviceSupport: ['CPU'] }],
  });
  cases.set('model-floating-revision', {
    schemaVersion: 2,
    datasets: [DATASET],
    models: [{ ...MODEL, revision: 'latest' }],
  });
  cases.set('model-digest-upper-case', {
    schemaVersion: 2,
    datasets: [DATASET],
    models: [{ ...MODEL, sourceDigest: MODEL.sourceDigest.toUpperCase() }],
  });
  cases.set('model-zero-width', {
    schemaVersion: 2,
    datasets: [DATASET],
    models: [{ ...MODEL, inputImageSize: { width: 0, height: 224 } }],
  });
  cases.set('model-text-dimension', {
    schemaVersion: 2,
    datasets: [DATASET],
    models: [{ ...MODEL, outputShape: { dimension: '768' } }],
  });
  cases.set('model-commercial-use-as-text', {
    schemaVersion: 2,
    datasets: [DATASET],
    models: [{ ...MODEL, commercialUse: 'false' }],
  });
  cases.set('model-weights-location-not-a-url', {
    schemaVersion: 2,
    datasets: [DATASET],
    models: [{ ...MODEL, sourceUri: 'not-a-url' }],
  });
  cases.set('model-weights-location-without-a-host', {
    schemaVersion: 2,
    datasets: [DATASET],
    models: [{ ...MODEL, sourceUri: 'mailto:weights@example.test' }],
  });

  cases.set('dataset-unknown-key', {
    schemaVersion: 2,
    datasets: [{ ...DATASET, mysteryField: 'x' }],
    models: [MODEL],
  });
  cases.set('dataset-unknown-parts-field', {
    schemaVersion: 2,
    datasets: [{ ...DATASET, parts: { selected: ['alpha'], rationale: 'r', extra: 1 } }],
    models: [MODEL],
  });
  cases.set('dataset-usage-outside-the-vocabulary', {
    schemaVersion: 2,
    datasets: [{ ...DATASET, usage: 'training' }],
    models: [MODEL],
  });
  cases.set('dataset-negative-archive-size', {
    schemaVersion: 2,
    datasets: [{ ...DATASET, archiveBytes: -1 }],
    models: [MODEL],
  });
  cases.set('dataset-sha256-without-its-timestamp', {
    schemaVersion: 2,
    datasets: [{ ...DATASET, sha256: MODEL.sourceDigest }],
    models: [MODEL],
  });
  cases.set('dataset-timestamp-without-its-sha256', {
    schemaVersion: 2,
    datasets: [{ ...DATASET, sha256PinnedAt: '2026-01-01T00:00:00.000Z' }],
    models: [MODEL],
  });
  cases.set('dataset-fetched-at-without-an-offset', {
    schemaVersion: 2,
    datasets: [{ ...DATASET, fetchedAt: '2026-01-01T00:00:00' }],
    models: [MODEL],
  });

  cases.set('file-version-1', { schemaVersion: 1, datasets: [DATASET] });
  cases.set('file-version-1-with-models', { schemaVersion: 1, datasets: [DATASET], models: [MODEL] });
  cases.set('file-version-2-without-models', { schemaVersion: 2, datasets: [DATASET] });
  cases.set('file-unknown-version', { schemaVersion: 99, datasets: [DATASET] });
  cases.set('file-boolean-version', { schemaVersion: true, datasets: [DATASET] });
  cases.set('file-text-version', { schemaVersion: '2', datasets: [DATASET] });
  cases.set('file-unknown-top-level-field', { schemaVersion: 2, datasets: [DATASET], extra: true });
  cases.set('file-empty-datasets', { schemaVersion: 2, datasets: [] });
  cases.set('file-without-datasets', { schemaVersion: 2 });
  cases.set('file-datasets-not-a-list', { schemaVersion: 2, datasets: {} });
  cases.set('file-dataset-not-an-object', { schemaVersion: 2, datasets: ['x'] });
  cases.set('file-models-not-a-list', { schemaVersion: 2, datasets: [DATASET], models: {} });
  cases.set('file-models-empty', { schemaVersion: 2, datasets: [DATASET], models: [] });
  cases.set('file-record-not-an-object', { schemaVersion: 2, datasets: [DATASET], models: ['x'] });
  cases.set('file-two-datasets', {
    schemaVersion: 2,
    datasets: [DATASET, { ...DATASET, id: 'second' }],
    models: [MODEL],
  });
  cases.set('file-two-models', {
    schemaVersion: 2,
    datasets: [DATASET],
    models: [MODEL, { ...MODEL, modelId: 'second' }],
  });

  return cases;
}

/** What the TypeScript reader says about one file. */
function readWithTypeScript(raw: unknown): { accepted: boolean; fields: string[] } {
  try {
    parseDatasetRegistry(raw);
    return { accepted: true, fields: [] };
  } catch (error) {
    const issues = (error as { issues?: readonly string[] }).issues ?? [];
    const fields = issues.map((issue) => issue.split(':')[0]!.trim());
    return { accepted: false, fields: [...new Set(fields)] };
  }
}

/** The Python reader reads every file of the corpus in one process. */
const PYTHON_PROBE = `
import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from visionlens.registry.loader import load_model_registry
from visionlens.registry.record import ModelRecordError

out = {}
for path in sorted(Path(sys.argv[2]).glob('*.json')):
    try:
        load_model_registry(str(path))
        out[path.name] = {"accepted": True, "fields": []}
    except ModelRecordError as error:
        out[path.name] = {"accepted": False, "fields": [error.field]}
    except Exception as error:
        field = getattr(error, "field", None)
        out[path.name] = {"accepted": False, "fields": [field] if field else []}
print(json.dumps(out))
`;

function main(): number {
  const cases = buildCases();
  const scratch = mkdtempSync(path.join(tmpdir(), 'visionlens-registry-parity-'));
  try {
    for (const [name, payload] of cases) {
      writeFileSync(path.join(scratch, name + '.json'), JSON.stringify(payload), 'utf8');
    }

    const python = spawnSync(
      'python3',
      ['-', path.join(repoRoot, 'python', 'visionlens', 'src'), scratch],
      { input: PYTHON_PROBE, encoding: 'utf8' },
    );
    if (python.status !== 0) {
      console.error('the Python probe failed:\n' + python.stderr);
      return 2;
    }
    const pythonResults = JSON.parse(python.stdout) as Record<
      string,
      { accepted: boolean; fields: string[] }
    >;

    const disagreements: string[] = [];
    const namingDifferences: string[] = [];
    for (const [name, payload] of cases) {
      const ts = readWithTypeScript(payload);
      const py = pythonResults[name + '.json'] ?? { accepted: false, fields: [] };
      if (ts.accepted !== py.accepted) {
        disagreements.push(
          `${name}: TypeScript ${ts.accepted ? 'accepts' : 'refuses'}, Python ${
            py.accepted ? 'accepts' : 'refuses'
          } (TypeScript: ${ts.fields.join(', ') || '-'}; Python: ${py.fields.join(', ') || '-'})`,
        );
        continue;
      }
      if (!ts.accepted && ts.fields.join('|') !== py.fields.join('|')) {
        namingDifferences.push(
          `${name}: TypeScript names ${ts.fields.join(', ') || '-'}; Python names ${
            py.fields.join(', ') || '-'
          }`,
        );
      }
    }

    console.log(`cases: ${cases.size}`);
    console.log(`outcome disagreements: ${disagreements.length}`);
    for (const line of disagreements) console.log('  ' + line);
    console.log(`naming differences: ${namingDifferences.length}`);
    for (const line of namingDifferences) console.log('  ' + line);
    if (disagreements.length > 0) {
      console.error('registry parity FAILED: the two readers disagree about a file');
      return 1;
    }
    console.log('registry parity passed: the two readers agree on every accept and every refusal');
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

process.exit(main());
