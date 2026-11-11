import { describe, expect, it } from 'vitest';
import { DerivedArtifactSchema, SampleSchema } from '../src/index.js';

/**
 * Lineage invariants on derived artifacts (spec 002 US4 / FR-006).
 *
 * "Everything derived records lineage" must be STRUCTURAL, not conventional:
 * a derived artifact without its sources, without the transform or without
 * the transform fingerprint cannot even be constructed.
 *
 * The lineage ids are UUIDv7 entity ids, the identity format of the domain
 * model: a source id that cannot be resolved would make the lineage walk
 * meaningless, so a free-form string is rejected.
 */

const VALID_ARTIFACT = {
  id: '018f4e2a-1b2c-7d3e-8f40-1234567890ab',
  kind: 'embedding',
  sourceAssetIds: [
    '018f4e2a-1b2c-7d3e-8f40-1234567890b1',
    '018f4e2a-1b2c-7d3e-8f40-1234567890b2',
  ],
  sourceSnapshotId: '018f4e2a-1b2c-7d3e-8f40-1234567890ac',
  transform: 'embed:siglip2',
  transformFingerprint: 'fp2:0123456789abcdef',
  createdAt: '2026-11-10T12:00:00.000Z',
};

/** A valid sample whose `snapshotIds` are real entity ids. */
const VALID_SAMPLE = {
  id: '018f4e2a-1b2c-7d3e-8f40-1234567890b3',
  assetId: '018f4e2a-1b2c-7d3e-8f40-1234567890b1',
  snapshotIds: ['018f4e2a-1b2c-7d3e-8f40-1234567890ac'],
  createdAt: '2026-11-10T12:00:00.000Z',
};

/** Returns a copy of `value` without `key` — the key is absent, not undefined. */
function omit<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const copy: Record<string, unknown> = { ...value };
  delete copy[key as string];
  return copy as Omit<T, K>;
}

/** The paths of the issues reported for a rejected payload. */
function issuePaths(result: {
  success: boolean;
  error?: { issues: Array<{ path: PropertyKey[] }> };
}) {
  return result.success ? [] : result.error!.issues.map((issue) => issue.path.join('.'));
}

describe('DerivedArtifact lineage invariants', () => {
  it('accepts a fully derived artifact', () => {
    expect(DerivedArtifactSchema.safeParse(VALID_ARTIFACT).success).toBe(true);
  });

  it('rejects an artifact without sourceAssetIds', () => {
    const result = DerivedArtifactSchema.safeParse(omit(VALID_ARTIFACT, 'sourceAssetIds'));

    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('sourceAssetIds');
  });

  it('rejects an artifact with an empty sourceAssetIds array', () => {
    const result = DerivedArtifactSchema.safeParse({ ...VALID_ARTIFACT, sourceAssetIds: [] });

    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('sourceAssetIds');
  });

  it('rejects a sourceAssetId that is not a UUIDv7 entity id', () => {
    const result = DerivedArtifactSchema.safeParse({
      ...VALID_ARTIFACT,
      sourceAssetIds: ['not-a-uuid'],
    });

    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('sourceAssetIds.0');
  });

  it('rejects a sourceAssetId that is a UUID but not a UUIDv7', () => {
    // A v4 UUID is well-formed but NOT the identity format of the domain
    // model: the lineage walk resolves by UUIDv7 id.
    const result = DerivedArtifactSchema.safeParse({
      ...VALID_ARTIFACT,
      sourceAssetIds: ['3b241101-e2bb-4255-8caf-4136c566a962'],
    });

    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('sourceAssetIds.0');
  });

  it('rejects an artifact without transform', () => {
    const result = DerivedArtifactSchema.safeParse(omit(VALID_ARTIFACT, 'transform'));

    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('transform');
  });

  it('rejects an artifact without transformFingerprint', () => {
    const result = DerivedArtifactSchema.safeParse(omit(VALID_ARTIFACT, 'transformFingerprint'));

    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('transformFingerprint');
  });

  it('rejects a transformFingerprint that is not a fingerprint v2 digest', () => {
    const result = DerivedArtifactSchema.safeParse({
      ...VALID_ARTIFACT,
      transformFingerprint: 'not-a-fingerprint',
    });

    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('transformFingerprint');
  });

  it('rejects an artifact whose lineage points at an unknown field', () => {
    const result = DerivedArtifactSchema.safeParse({ ...VALID_ARTIFACT, encoderId: 'x' });

    expect(result.success).toBe(false);
    const issues = result.success ? [] : result.error!.issues;
    expect(issues.some((issue) => issue.code === 'unrecognized_keys')).toBe(true);
  });

  it('keeps sourceSnapshotId optional but the transform mandatory', () => {
    const result = DerivedArtifactSchema.safeParse(omit(VALID_ARTIFACT, 'sourceSnapshotId'));
    expect(result.success).toBe(true);
  });
});

describe('Sample snapshot lineage', () => {
  it('accepts a sample whose snapshotIds are UUIDv7 entity ids', () => {
    expect(SampleSchema.safeParse(VALID_SAMPLE).success).toBe(true);
  });

  it('accepts a sample with no snapshot at all', () => {
    const result = SampleSchema.safeParse(omit(VALID_SAMPLE, 'snapshotIds'));
    expect(result.success).toBe(true);
  });

  it('rejects a snapshotId that is not a UUIDv7 entity id', () => {
    const result = SampleSchema.safeParse({ ...VALID_SAMPLE, snapshotIds: ['not-a-uuid'] });

    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('snapshotIds.0');
  });

  it('rejects a snapshotId that is a UUID but not a UUIDv7', () => {
    const result = SampleSchema.safeParse({
      ...VALID_SAMPLE,
      snapshotIds: ['3b241101-e2bb-4255-8caf-4136c566a962'],
    });

    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('snapshotIds.0');
  });
});
