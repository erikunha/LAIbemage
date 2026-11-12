import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildContractManifest,
  checkVersionBump,
  diffManifests,
  type ContractManifest,
  type ManifestEntity,
} from '../../src/index.js';

/**
 * Manifest and breaking-change guard coverage for the worker wire protocol.
 *
 * The worker frames must be a guarded part of the contract surface: removing a
 * required field from a frame, removing a frame, or removing an operation or
 * error code is a breaking change that requires a MAJOR `CONTRACTS_VERSION`
 * bump, exactly as for the entities.
 */

const MANIFEST_PATH = fileURLToPath(new URL('../../contract-manifest.json', import.meta.url));

/** A manifest with the worker request frame carrying two required fields. */
function baseWithRequestFrame(): ContractManifest {
  const requestFrame: ManifestEntity = {
    fields: {
      protocol: { required: true, type: 'literal("visionlens.worker.v1")' },
      requestId: { required: true, type: 'string', constraint: 'minLength=1;maxLength=128' },
      budget: { required: true, type: 'object{maxSeconds,maxTokens,maxUsdMicro}' },
    },
  };
  return {
    contractsVersion: '1.0.0',
    entities: {},
    enums: {
      WorkerOperation: ['vision.embed'],
      WorkerErrorCode: ['CANCELLED', 'WORKER_CRASHED'],
    },
    frames: { WorkerRequestFrame: requestFrame },
  };
}

describe('worker frames in the contract manifest', () => {
  it('the six frame schemas are recorded with their required fields', () => {
    const manifest = buildContractManifest();
    expect(Object.keys(manifest.frames).sort()).toEqual([
      'WorkerCancelFrame',
      'WorkerErrorFrame',
      'WorkerHelloFrame',
      'WorkerProgressFrame',
      'WorkerRequestFrame',
      'WorkerResultFrame',
    ]);
    const request = manifest.frames.WorkerRequestFrame?.fields ?? {};
    expect(request.requestId?.required).toBe(true);
    expect(request.budget?.required).toBe(true);
    expect(request.operation?.type).toBe(
      'enum("vision.embed"|"vision.predict"|"dataset.audit"|"eval.run"|"model.train")',
    );
    // The only optional field in the whole wire protocol lives inside the
    // budget, so every top-level request field is required.
    expect(Object.values(request).every((field) => field.required)).toBe(true);
  });

  it('the worker enums are recorded next to the domain enums', () => {
    const manifest = buildContractManifest();
    expect(manifest.enums.WorkerOperation).toContain('vision.embed');
    expect(manifest.enums.WorkerErrorCode).toContain('WORKER_CRASHED');
  });

  it('the committed manifest carries the frames section', () => {
    const committed = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as ContractManifest;
    expect(committed.frames).toBeDefined();
    expect(Object.keys(committed.frames)).toHaveLength(6);
  });
});

describe('breaking-change guard over the worker frames', () => {
  it('removing a required frame field is breaking and requires a MAJOR bump', () => {
    const live = buildContractManifest();
    const requestFields = live.frames.WorkerRequestFrame?.fields ?? {};
    const mutilated: ContractManifest = {
      ...live,
      frames: {
        ...live.frames,
        WorkerRequestFrame: {
          fields: Object.fromEntries(
            Object.entries(requestFields).filter(([name]) => name !== 'requestId'),
          ),
        },
      },
    };

    const refused = checkVersionBump(live, mutilated);
    expect(refused.ok).toBe(false);
    expect(refused.requiredMajorBump).toBe(true);
    expect(refused.breaking.map((change) => change.path)).toContain('WorkerRequestFrame.requestId');
    expect(refused.reason).toContain('MAJOR');

    const bumped = checkVersionBump(live, { ...mutilated, contractsVersion: '2.0.0' });
    expect(bumped.ok).toBe(true);
  });

  it('a frame removed entirely is breaking', () => {
    const base = baseWithRequestFrame();
    const current: ContractManifest = {
      ...buildContractManifest(),
      frames: {},
    };
    const diff = diffManifests(base, current);
    const removed = diff.breaking.find((change) => change.path === 'WorkerRequestFrame');
    expect(removed?.kind).toBe('entity-removed');
    expect(removed?.detail).toContain('Frame "WorkerRequestFrame"');
  });

  it('a reshaped budget (field removed from the nested object) is breaking', () => {
    const base = baseWithRequestFrame();
    // Same manifest, but the budget object loses maxTokens from its shape.
    const narrowed: ContractManifest = {
      ...base,
      frames: {
        WorkerRequestFrame: {
          fields: { ...base.frames.WorkerRequestFrame!.fields },
        },
      },
    };
    narrowed.frames.WorkerRequestFrame!.fields.budget = {
      required: true,
      type: 'object{maxSeconds,maxUsdMicro}',
    };
    const diff = diffManifests(base, narrowed);
    expect(
      diff.breaking.some(
        (change) =>
          change.kind === 'field-type-changed' && change.path === 'WorkerRequestFrame.budget',
      ),
    ).toBe(true);
  });

  it('an added frame field is additive, not breaking', () => {
    const base = baseWithRequestFrame();
    const widened: ContractManifest = {
      ...base,
      frames: {
        WorkerRequestFrame: {
          fields: {
            ...base.frames.WorkerRequestFrame!.fields,
            priority: { required: false, type: 'integer' },
          },
        },
      },
    };
    const diff = diffManifests(base, widened);
    expect(diff.breaking).toEqual([]);
    expect(diff.additive).toContain('WorkerRequestFrame.priority');
  });

  it('a removed operation or error code is breaking', () => {
    const base = baseWithRequestFrame();
    const current: ContractManifest = {
      ...buildContractManifest(),
      enums: {
        ...buildContractManifest().enums,
        WorkerOperation: ['dataset.audit', 'eval.run', 'model.train', 'vision.predict'],
        WorkerErrorCode: [
          'BUDGET_EXCEEDED',
          'CANCELLED',
          'DEADLINE_EXCEEDED',
          'MALFORMED_FRAME',
          'MISSING_EXTRA',
          'PROTOCOL_MISMATCH',
          'PROVIDER_UNAVAILABLE',
          'UNSUPPORTED_OPERATION',
          'UNSUPPORTED_PROTOCOL',
        ],
      },
    };
    const diff = diffManifests(base, current);
    expect(
      diff.breaking.some(
        (change) => change.kind === 'enum-value-removed' && change.path === 'WorkerOperation.vision.embed',
      ),
    ).toBe(true);
    expect(
      diff.breaking.some(
        (change) => change.kind === 'enum-value-removed' && change.path === 'WorkerErrorCode.WORKER_CRASHED',
      ),
    ).toBe(true);
  });

  it('a manifest generated before the worker protocol existed diffs additively', () => {
    // The real base revision carries no frames key at all; the guard must
    // treat that absence as an empty map, so ratifying the protocol was (and
    // removing it would be) classified correctly.
    const legacyBase = {
      contractsVersion: '1.0.0',
      entities: {},
      enums: {},
    } as ContractManifest;
    const diff = diffManifests(legacyBase, buildContractManifest());
    expect(diff.breaking).toEqual([]);
    expect(diff.additive).toContain('WorkerRequestFrame');
    expect(diff.additive).toContain('WorkerErrorCode');
  });
});
