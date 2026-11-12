import { describe, expect, it } from 'vitest';
import {
  AssetSchema,
  DerivedArtifactSchema,
  ExperimentRunSchema,
  FingerprintSchema,
  OntologyVersionSchema,
} from '../src/index.js';

/**
 * The invariants the review found only documented, not enforced (spec 002,
 * constitution II and IV).
 *
 *  - **Asset**: `sha256` is optional EXACTLY when `unhashed` is true — both
 *    directions. The database CHECK enforces it as the second line of
 *    defence; the contract is the first.
 *  - **Fingerprints**: a fingerprint is the `fp2:<16 hex>` digest the package's
 *    own `fingerprintV2` produces. Constitution IV demands a FULL-config
 *    fingerprint, and a bare string cannot prove that a key is one.
 */

const IDS = {
  asset: '018f4e2a-1b2c-7d3e-8f40-1234567890ab',
  artifact: '018f4e2a-1b2c-7d3e-8f40-1234567890ac',
  experiment: '018f4e2a-1b2c-7d3e-8f40-1234567890ad',
  ontology: '018f4e2a-1b2c-7d3e-8f40-1234567890ae',
};

const SHA256 = 'a'.repeat(64);

/** The paths of the issues reported for a rejected payload. */
function issuePaths(result: {
  success: boolean;
  error?: { issues: Array<{ path: PropertyKey[] }> };
}) {
  return result.success ? [] : result.error!.issues.map((issue) => issue.path.join('.'));
}

/** The messages of the issues reported for a rejected payload. */
function issueMessages(result: {
  success: boolean;
  error?: { issues: Array<{ message: string }> };
}) {
  return result.success ? [] : result.error!.issues.map((issue) => issue.message);
}

describe('the asset hash rule: sha256 exactly when the asset is hashed', () => {
  const hashed = {
    id: IDS.asset,
    sha256: SHA256,
    kind: 'image',
    unhashed: false,
    createdAt: '2026-11-10T12:00:00.000Z',
  };

  it('accepts a hashed asset that carries its digest', () => {
    expect(AssetSchema.safeParse(hashed).success).toBe(true);
  });

  it('accepts an unhashed asset without a digest', () => {
    const result = AssetSchema.safeParse({
      id: IDS.asset,
      kind: 'image',
      unhashed: true,
      path: '/tmp/asset.jpg',
      createdAt: '2026-11-10T12:00:00.000Z',
    });

    expect(result.success).toBe(true);
  });

  it('rejects an unhashed asset that carries a sha256', () => {
    const result = AssetSchema.safeParse({ ...hashed, unhashed: true });

    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('sha256');
    expect(issueMessages(result).join(' ')).toContain('unhashed');
  });

  it('rejects a hashed asset WITHOUT a sha256', () => {
    const { sha256, ...withoutDigest } = hashed;
    expect(sha256).toBeDefined();

    const result = AssetSchema.safeParse(withoutDigest);

    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('sha256');
    expect(issueMessages(result).join(' ')).toContain('hashed');
  });
});

describe('fingerprint v2 is the only accepted fingerprint shape', () => {
  it('accepts the `fp2:<16 hex>` digest', () => {
    expect(FingerprintSchema.safeParse('fp2:0123456789abcdef').success).toBe(true);
  });

  it('rejects a fingerprint that is not an fp2 digest', () => {
    expect(FingerprintSchema.safeParse('categories-hash-v1').success).toBe(false);
    expect(FingerprintSchema.safeParse('fp2:0123456789ABCDEF').success).toBe(false);
    expect(FingerprintSchema.safeParse('fp2:0123456789abcde').success).toBe(false);
    expect(FingerprintSchema.safeParse('fp2:0123456789abcdefa').success).toBe(false);
  });

  it('pins the ontology fingerprint', () => {
    const valid = {
      id: IDS.ontology,
      version: '1.0.0',
      categories: [{ key: 'kitchen', name: 'Kitchen', description: 'A kitchen' }],
      fingerprint: 'fp2:0123456789abcdef',
      createdAt: '2026-11-10T12:00:00.000Z',
    };

    expect(OntologyVersionSchema.safeParse(valid).success).toBe(true);

    const result = OntologyVersionSchema.safeParse({ ...valid, fingerprint: 'kitchen-hash' });
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('fingerprint');
  });

  it('pins the experiment config fingerprint', () => {
    const valid = {
      id: IDS.experiment,
      kind: 'classify',
      configFingerprint: 'fp2:0123456789abcdef',
      status: 'queued',
      startedAt: '2026-11-10T12:00:00.000Z',
    };

    expect(ExperimentRunSchema.safeParse(valid).success).toBe(true);

    const result = ExperimentRunSchema.safeParse({ ...valid, configFingerprint: 'v1' });
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('configFingerprint');
  });

  it('pins the derived artifact transform fingerprint', () => {
    const valid = {
      id: IDS.artifact,
      kind: 'embedding',
      sourceAssetIds: ['018f4e2a-1b2c-7d3e-8f40-1234567890b1'],
      transform: 'embed:siglip2',
      transformFingerprint: 'fp2:0123456789abcdef',
      createdAt: '2026-11-10T12:00:00.000Z',
    };

    expect(DerivedArtifactSchema.safeParse(valid).success).toBe(true);

    const result = DerivedArtifactSchema.safeParse({
      ...valid,
      transformFingerprint: 'resize:256',
    });
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('transformFingerprint');
  });
});
