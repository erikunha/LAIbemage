import { z } from 'zod';
import { ActorKindSchema, SurfaceSchema } from './enums.js';

/**
 * Shared primitives for every Vision Lens entity (spec 002).
 *
 * The rules encoded here are constitutional, not stylistic:
 *  - identity is UUIDv7 (time-ordered, index-friendly);
 *  - every entity is a STRICT object (unknown keys are rejected), which is
 *    what makes the Prediction ↔ Annotation separation structural rather than
 *    accidental (constitution II, FR-002);
 *  - every label carries provenance: who produced it, through which surface,
 *    when, and in which session.
 */

/**
 * Strict-object policy (constitution II, FR-002).
 *
 * Every entity schema in this package is built with `z.strictObject`, so an
 * unrecognized key is an error instead of being silently stripped. Combined
 * with the split actor unions, this is what makes a Prediction payload fail to
 * parse as an Annotation and vice versa: the discriminating fields
 * (`modelVersionId` vs `ontologyVersionId`) are *required* by one schema and
 * *unknown* to the other.
 */
export const strict = z.strictObject;

/**
 * Identity of an entity: a UUIDv7.
 *
 * UUIDv7 is time-ordered, so primary-key inserts stay append-mostly and
 * index locality is preserved without a separate sequence column.
 */
export const EntityIdSchema = z
  .uuidv7()
  .describe('Identity of an entity: a UUIDv7 (time-ordered, index-friendly).');

/**
 * Point in time an event was recorded.
 *
 * Uses `z.iso.datetime({ offset: true })`: the timestamp MUST carry an
 * explicit offset (`Z` or `±HH:MM`). The offset is *accepted* rather than
 * required to be `Z` because the same record can be produced on machines in
 * different time zones and a local offset is still unambiguous — but a
 * zone-less local time is rejected, because it is not a point in time.
 */
export const TimestampSchema = z.iso
  .datetime({ offset: true })
  .describe('Point in time an event was recorded, with an explicit UTC offset.');

/**
 * Content hash of a file or of a hashed payload: exactly 64 lowercase hex
 * characters (the canonical form of Node's `crypto` sha256 digest).
 */
export const Sha256Schema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, {
    error: 'Expected a sha256 digest: 64 lowercase hex characters.',
  })
  .describe('Content hash of a file or of a hashed payload: 64 lowercase hex characters.');

/**
 * A full-config fingerprint: the `fp2:` domain separator followed by the first
 * 16 hex characters of the sha256 digest of the canonical configuration.
 *
 * This is the EXACT shape `fingerprintV2` produces (`src/fingerprint.ts`), so
 * every fingerprint the package computes satisfies this schema by
 * construction. Constitution IV demands that a cache, index or comparison key
 * hashes the ENTIRE semantic configuration — a bare string cannot prove that,
 * because it cannot tell a `fp2:` digest from a name, a legacy hash or a
 * typo. Pinning the shape here makes the requirement structural.
 */
export const FingerprintSchema = z
  .string()
  .regex(/^fp2:[0-9a-f]{16}$/, {
    error:
      'Expected a fingerprint v2 digest: `fp2:` followed by exactly 16 lowercase hex characters.',
  })
  .describe('A full-config fingerprint: `fp2:<16 hex characters>`.');

/**
 * Axis-aligned bounding box in the pixel space of the source asset.
 *
 * Deliberately minimal: richer geometry (polygons, masks) belongs to the
 * later specs, and adding it must stay an additive change.
 */
export const RegionSchema = strict({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
}).describe('Axis-aligned bounding box in the pixel space of the source asset.');

/**
 * A human produced this record.
 *
 * `ref` is the stable identity of the person (e.g. `user:erik`), `displayName`
 * is the human-readable label shown in surfaces.
 */
export const HumanActorSchema = strict({
  kind: z.literal(ActorKindSchema.enum.human),
  ref: z.string().min(1),
  displayName: z.string().min(1).optional(),
}).describe('A human produced this record.');

/**
 * A model produced this record.
 *
 * Constitution II fixes the reference convention `model:<id>@<version>`: the
 * model id is carried in `ref` (prefixed by `model:` so a model output can
 * never be mistaken for a human one) and the model version in `version`.
 *
 * ## The canonical rule (ONE rule, stated once)
 *
 * `ref` is the FULL actor reference: `model:<id>` or `model:<id>@<version>`.
 * The `@<version>` suffix is the constitutional form and is ACCEPTED; the
 * `model:` prefix is REQUIRED; whitespace is REJECTED anywhere in the ref.
 * The separate `version` field carries the STRUCTURED version and both may be
 * present — a ref with the version inline and a `version` field agree, they
 * do not conflict. A consumer that only wants the version reads `version`; a
 * consumer that wants the full, human-readable identity reads `ref`.
 *
 * Examples:
 *  - `model:gpt-4o` — accepted (the model id alone).
 *  - `model:gpt-4o@2024-05-13` — accepted (the constitutional form).
 *  - `gpt-4o` — rejected (no `model:` prefix: it could be a human).
 *  - `model:gpt 4o` — rejected (whitespace is not allowed).
 */
export const ModelActorSchema = strict({
  kind: z.literal(ActorKindSchema.enum.model),
  ref: z.string().regex(/^model:[^@\s]+(@[^@\s]+)?$/, {
    error:
      'Model actor ref must be `model:<id>` or `model:<id>@<version>` (constitution II) — ' +
      'the `model:` prefix is required and whitespace is not allowed.',
  }),
  version: z.string().min(1),
}).describe('A model produced this record.');

/**
 * An agent produced this record.
 *
 * `agentRunId` links back to the `AgentRun` that produced it, so an
 * agent-authored label is traceable to its budget, tool calls and approvals.
 */
export const AgentActorSchema = strict({
  kind: z.literal(ActorKindSchema.enum.agent),
  ref: z.string().min(1),
  agentRunId: EntityIdSchema.optional(),
}).describe('An agent produced this record.');

/** Any producer of a record. */
export const ActorSchema = z
  .discriminatedUnion('kind', [HumanActorSchema, ModelActorSchema, AgentActorSchema])
  .describe('Any producer of a record: a human, a model or an agent.');

/**
 * The producers allowed to author an `Annotation`.
 *
 * Human or agent only — a model output is a `Prediction` and can never be an
 * `Annotation` (constitution II, FR-002).
 */
export const AnnotationActorSchema = z
  .discriminatedUnion('kind', [HumanActorSchema, AgentActorSchema])
  .describe('The producers allowed to author an Annotation: a human or an agent.');

/**
 * The only producer allowed to author a `Prediction`.
 *
 * Model only — a human label is an `Annotation` and can never be a
 * `Prediction` (constitution II, FR-002).
 */
export const PredictionActorSchema = z
  .discriminatedUnion('kind', [ModelActorSchema])
  .describe('The only producer allowed to author a Prediction: a model.');

/**
 * The canonical provenance bundle: who produced a record, through which
 * surface, in which session, and when.
 *
 * ## This is a REFERENCE shape, not the shape of any entity
 *
 * No entity in the domain model is built from this schema, and none is
 * expected to be: `Annotation` and `Prediction` carry the same four facts but
 * keep the field names of the spec's key-entity table (`createdAt` instead of
 * `recordedAt`), so binding them to a shared base type would rename a field
 * the spec fixes. `Annotation` and `Prediction` therefore spell the bundle
 * out in their own schemas, and this one exists to NAME it — to give the
 * constitution's requirement ("actor + surface + session + timestamp") a
 * single, testable definition instead of a phrase repeated in prose.
 *
 * It is deliberately NOT used as a base type: it would either duplicate the
 * two label schemas or force a rename. Use it to assert what a provenance
 * bundle IS, not to validate a record.
 */
export const ProvenanceSchema = strict({
  actor: ActorSchema,
  surface: SurfaceSchema,
  sessionId: z.string().min(1).optional(),
  recordedAt: TimestampSchema,
}).describe(
  'The canonical provenance bundle (REFERENCE shape — not bound to any entity): ' +
    'who produced a record, through which surface, in which session, and when.',
);

/**
 * An arbitrary JSON value: a string, a number, a boolean, null, an array or an
 * object.
 *
 * The fields that carry free-form payloads (`exifSanitizedJson`, `budgetJson`,
 * `resultsJson`, …) are typed with THIS schema rather than with `string`, so
 * the wire format says "a JSON value" and not "a string that happens to hold
 * JSON". It is also the single shared instance, which is what lets the
 * OpenAPI seed publish ONE `JsonValue` component instead of a private copy
 * per field.
 */
export const JsonValueSchema = z
  .json()
  .describe('An arbitrary JSON value: a string, number, boolean, null, array or object.');

export type EntityId = z.infer<typeof EntityIdSchema>;
export type Timestamp = z.infer<typeof TimestampSchema>;
export type Sha256 = z.infer<typeof Sha256Schema>;
export type Fingerprint = z.infer<typeof FingerprintSchema>;
export type Region = z.infer<typeof RegionSchema>;
export type HumanActor = z.infer<typeof HumanActorSchema>;
export type ModelActor = z.infer<typeof ModelActorSchema>;
export type AgentActor = z.infer<typeof AgentActorSchema>;
export type Actor = z.infer<typeof ActorSchema>;
export type AnnotationActor = z.infer<typeof AnnotationActorSchema>;
export type PredictionActor = z.infer<typeof PredictionActorSchema>;
export type Provenance = z.infer<typeof ProvenanceSchema>;
