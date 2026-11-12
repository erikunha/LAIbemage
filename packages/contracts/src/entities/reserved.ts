import { z } from 'zod';
import { strict } from '../base.js';

/**
 * Reserved entities — declared, not built (constitution IX, progressive scope).
 *
 * `Track`, `Frame`, `Calibration` and `SynchronizedSequence` belong to the
 * video / Physical-AI frontier (spec 014). They are declared here so that
 * their NAMES are reserved and cannot be claimed by another entity, but they
 * deliberately validate ONLY the minimal reserved shape: a full payload is
 * rejected until spec 014 declares the activation rules.
 */

/** The entity names reserved for the video / Physical-AI frontier (spec 014). */
export const RESERVED_ENTITIES = [
  'track',
  'frame',
  'calibration',
  'synchronized-sequence',
] as const;

export type ReservedEntity = (typeof RESERVED_ENTITIES)[number];

/**
 * The rejection message every reserved stub produces.
 *
 * It names spec 014 explicitly so that whoever hits the wall knows where the
 * activation rules live instead of assuming the payload was malformed.
 */
export const RESERVED_ENTITY_MESSAGE =
  'Reserved entity stub: only { reserved: true, entity } is valid — activating a full payload is governed by spec 014.';

/**
 * Builds the minimal stub for one reserved entity.
 *
 * The stub is a STRICT object: any additional key is rejected with
 * `RESERVED_ENTITY_MESSAGE` (which points at spec 014), and the two reserved
 * fields carry the same message so that every rejection path mentions the
 * governing spec.
 */
function reservedStub<E extends ReservedEntity>(entity: E) {
  return strict(
    {
      reserved: z.literal(true, { error: RESERVED_ENTITY_MESSAGE }),
      entity: z.literal(entity, { error: RESERVED_ENTITY_MESSAGE }),
    },
    { error: RESERVED_ENTITY_MESSAGE },
  );
}

/** Reserved stub for `Track` (spec 014). */
export const TrackSchema = reservedStub('track');
/** Reserved stub for `Frame` (spec 014). */
export const FrameSchema = reservedStub('frame');
/** Reserved stub for `Calibration` (spec 014). */
export const CalibrationSchema = reservedStub('calibration');
/** Reserved stub for `SynchronizedSequence` (spec 014). */
export const SynchronizedSequenceSchema = reservedStub('synchronized-sequence');

/**
 * Registry of the reserved stubs.
 *
 * Deliberately SEPARATE from `ENTITY_SCHEMAS`: a reserved stub is not an
 * entity of the current domain model, so it must not appear in the contract
 * manifest until spec 014 activates it.
 */
export const RESERVED_SCHEMAS = {
  Track: TrackSchema,
  Frame: FrameSchema,
  Calibration: CalibrationSchema,
  SynchronizedSequence: SynchronizedSequenceSchema,
} as const;

export type ReservedSchemaName = keyof typeof RESERVED_SCHEMAS;
