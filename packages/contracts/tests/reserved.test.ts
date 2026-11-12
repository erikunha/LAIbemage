import { describe, expect, it } from 'vitest';
import {
  CalibrationSchema,
  FrameSchema,
  RESERVED_ENTITY_MESSAGE,
  SynchronizedSequenceSchema,
  TrackSchema,
} from '../src/index.js';

/**
 * Reserved entity stubs (spec 002 FR-008, US1 edge case).
 *
 * `Track`, `Frame`, `Calibration` and `SynchronizedSequence` are DECLARED but
 * not built: they validate only the minimal reserved shape, and a full
 * payload is rejected with a message that points at spec 014 — the spec that
 * owns the activation rules.
 */

const RESERVED_CASES: Array<{
  name: string;
  schema: {
    safeParse: (value: unknown) => {
      success: boolean;
      error?: { issues: Array<{ message: string }> };
    };
  };
  entity: string;
  fullPayload: Record<string, unknown>;
}> = [
  {
    name: 'Track',
    schema: TrackSchema,
    entity: 'track',
    fullPayload: { reserved: true, entity: 'track', tracks: [{ id: 'track-1' }] },
  },
  {
    name: 'Frame',
    schema: FrameSchema,
    entity: 'frame',
    fullPayload: { reserved: true, entity: 'frame', frames: [{ index: 0, timestamp: 'x' }] },
  },
  {
    name: 'Calibration',
    schema: CalibrationSchema,
    entity: 'calibration',
    fullPayload: {
      reserved: true,
      entity: 'calibration',
      matrix: [
        [1, 0],
        [0, 1],
      ],
    },
  },
  {
    name: 'SynchronizedSequence',
    schema: SynchronizedSequenceSchema,
    entity: 'synchronized-sequence',
    fullPayload: {
      reserved: true,
      entity: 'synchronized-sequence',
      sequences: ['cam-03'],
    },
  },
];

describe('reserved entity stubs', () => {
  it.each(RESERVED_CASES)('$name accepts only its minimal reserved shape', ({ schema, entity }) => {
    const result = schema.safeParse({ reserved: true, entity });
    expect(result.success).toBe(true);
  });

  it.each(RESERVED_CASES)('$name rejects a full payload', ({ schema, fullPayload }) => {
    const result = schema.safeParse(fullPayload);
    expect(result.success).toBe(false);
  });

  it.each(RESERVED_CASES)(
    '$name rejection message points to spec 014',
    ({ schema, fullPayload }) => {
      const result = schema.safeParse(fullPayload);
      expect(result.success).toBe(false);
      const messages = result.success ? [] : result.error!.issues.map((issue) => issue.message);
      expect(messages.length).toBeGreaterThan(0);
      expect(messages.join('\n')).toContain('spec 014');
    },
  );

  it('exposes the shared reserved message with the spec 014 reference', () => {
    expect(RESERVED_ENTITY_MESSAGE).toContain('spec 014');
  });

  it('rejects a reserved stub claiming another reserved entity', () => {
    expect(TrackSchema.safeParse({ reserved: true, entity: 'frame' }).success).toBe(false);
    expect(FrameSchema.safeParse({ reserved: true, entity: 'track' }).success).toBe(false);
  });

  it('rejects a reserved stub that is not flagged as reserved', () => {
    const result = FrameSchema.safeParse({ entity: 'frame' });
    expect(result.success).toBe(false);
    const messages = result.success ? [] : result.error!.issues.map((issue) => issue.message);
    expect(messages.join('\n')).toContain('spec 014');
  });
});
