import fc from 'fast-check';

/**
 * Arbitraries for the domain model (spec 002).
 *
 * They generate payloads that are VALID for the corresponding schema, so the
 * property tests can assert round-tripping instead of asserting that the
 * generator and the schema happen to agree on what is invalid.
 *
 * Determinism: every property test uses `PROPERTY_SEED` and `PROPERTY_RUNS`
 * below, so a failure is reproducible in CI.
 */

/** Fixed seed used by every property test in this package. */
export const PROPERTY_SEED = 20261110;

/** Number of generated cases per property test. */
export const PROPERTY_RUNS = 100;

/** A UUIDv7 — the identity format of the domain model. */
export const uuidV7Arb = fc.uuid({ version: 7 });

/**
 * An ISO-8601 timestamp with an explicit offset.
 *
 * The offsets vary on purpose: a generator that only ever produced `Z` would
 * keep the suite green even if `TimestampSchema` regressed to the default
 * `z.iso.datetime()`, which rejects every offset but `Z`. Mixing `Z` and
 * local offsets makes the property tests cover the rule the schema states.
 */
export const timestampArb = fc
  .tuple(
    fc.integer({ min: 0, max: 4_102_444_800 }),
    fc.constantFrom('Z', '+02:00', '-05:30', '+00:00', '+09:00'),
  )
  .map(([seconds, offset]) =>
    offset === 'Z'
      ? new Date(seconds * 1000).toISOString()
      : new Date(seconds * 1000).toISOString().replace('Z', offset),
  );

/** A sha256 digest (64 lowercase hex characters). */
export const sha256Arb = fc
  .uint8Array({ minLength: 32, maxLength: 32 })
  .map((bytes) => Buffer.from(bytes).toString('hex'));

/**
 * A full-config fingerprint v2 digest (`fp2:<16 hex>`) — the exact shape
 * `fingerprintV2` produces.
 */
export const fingerprintArb = fc
  .uint8Array({ minLength: 8, maxLength: 8 })
  .map((bytes) => `fp2:${Buffer.from(bytes).toString('hex')}`);

/** Any JSON value. */
export const jsonArb = fc.jsonValue();

/** A non-empty string (ids, labels, refs, paths). */
export const nonEmptyStringArb = fc.string({ minLength: 1, maxLength: 24 });

/**
 * A model actor reference.
 *
 * Both canonical forms are generated: `model:<id>` and the constitutional
 * `model:<id>@<version>`.
 */
export const modelRefArb = fc.constantFrom(
  'model:alpha',
  'model:beta-2',
  'model:gamma-7',
  'model:gpt-4o@2024-05-13',
  'model:openai/gpt-4o@2024-01',
);

/** A bounding box in pixel space. */
export const regionArb = fc.record({
  x: fc.integer({ min: 0, max: 10_000 }),
  y: fc.integer({ min: 0, max: 10_000 }),
  width: fc.integer({ min: 1, max: 10_000 }),
  height: fc.integer({ min: 1, max: 10_000 }),
});

/** A human actor. */
export const humanActorArb = fc.record({
  kind: fc.constant('human'),
  ref: nonEmptyStringArb,
  displayName: fc.option(nonEmptyStringArb, { nil: undefined }),
});

/** A model actor. */
export const modelActorArb = fc.record({
  kind: fc.constant('model'),
  ref: modelRefArb,
  version: nonEmptyStringArb,
});

/** An agent actor. */
export const agentActorArb = fc.record({
  kind: fc.constant('agent'),
  ref: nonEmptyStringArb,
  agentRunId: fc.option(uuidV7Arb, { nil: undefined }),
});

/** One taxonomy category (description included — it is load-bearing). */
export const categoryArb = fc.record({
  key: fc.constantFrom('kitchen', 'bathroom', 'assembly', 'packaging'),
  name: fc.constantFrom('Kitchen', 'Bathroom', 'Assembly line', 'Packaging'),
  description: fc.string({ maxLength: 40 }),
});

/** One agent tool call. */
export const toolCallArb = fc.record({
  tool: fc.constantFrom('read_asset', 'search_samples', 'propose_label'),
  tier: fc.constantFrom('read', 'analyze', 'propose', 'gated-execute', 'approval-required'),
  at: timestampArb,
  args: fc.option(jsonArb, { nil: undefined }),
  ok: fc.option(fc.boolean(), { nil: undefined }),
});

/** One approval decision. */
export const approvalArb = fc.record({
  tool: fc.constantFrom('write_report', 'run_experiment', 'promote_model'),
  tier: fc.constantFrom('gated-execute', 'approval-required'),
  decision: fc.constantFrom('approved', 'denied'),
  decidedBy: nonEmptyStringArb,
  at: timestampArb,
});

/* -------------------------------------------------------------------------- */
/* Entity arbitraries                                                          */
/* -------------------------------------------------------------------------- */

/**
 * An asset.
 *
 * The `sha256` ⟷ `unhashed` invariant is honored by the generator: a hashed
 * asset always carries its digest, an unhashed one never does. The generator
 * therefore produces only payloads the CONTRACT accepts, which is what the
 * round-trip property test needs.
 */
export const assetArb = fc
  .record({
    id: uuidV7Arb,
    kind: fc.constantFrom('image', 'video', 'audio', 'other'),
    bytes: fc.option(fc.integer({ min: 0, max: 1_000_000_000 }), { nil: undefined }),
    width: fc.option(fc.integer({ min: 0, max: 100_000 }), { nil: undefined }),
    height: fc.option(fc.integer({ min: 0, max: 100_000 }), { nil: undefined }),
    exifSanitizedJson: fc.option(jsonArb, { nil: undefined }),
    captureSessionId: fc.option(uuidV7Arb, { nil: undefined }),
    path: fc.option(nonEmptyStringArb, { nil: undefined }),
    createdAt: timestampArb,
    hashState: fc.oneof(
      fc.constant({ unhashed: true, sha256: undefined } as const),
      fc.record({ unhashed: fc.constant(false), sha256: sha256Arb }),
    ),
  })
  .map(({ hashState, ...rest }) => ({ ...rest, ...hashState }));

export const captureSessionArb = fc.record({
  id: uuidV7Arb,
  startedAt: timestampArb,
  endedAt: fc.option(timestampArb, { nil: undefined }),
  source: fc.constantFrom('line-a/cam-03', 'bench-2/scanner', 'manual-import'),
  contextJson: fc.option(jsonArb, { nil: undefined }),
});

export const sampleArb = fc.record({
  id: uuidV7Arb,
  assetId: uuidV7Arb,
  region: fc.option(regionArb, { nil: undefined }),
  split: fc.option(fc.constantFrom('train', 'val', 'test', 'holdout', 'unassigned'), {
    nil: undefined,
  }),
  snapshotIds: fc.option(fc.array(uuidV7Arb, { maxLength: 3 }), { nil: undefined }),
  sourceCaptureFrame: fc.option(nonEmptyStringArb, { nil: undefined }),
  createdAt: timestampArb,
});

export const ontologyVersionArb = fc.record({
  id: uuidV7Arb,
  version: nonEmptyStringArb,
  categories: fc.array(categoryArb, { maxLength: 5 }),
  fingerprint: fingerprintArb,
  parentId: fc.option(uuidV7Arb, { nil: undefined }),
  createdAt: timestampArb,
});

export const annotationArb = fc.record({
  id: uuidV7Arb,
  sampleId: uuidV7Arb,
  ontologyVersionId: uuidV7Arb,
  labelKey: fc.constantFrom('kitchen', 'bathroom', 'assembly'),
  geometry: fc.option(regionArb, { nil: undefined }),
  // Human OR agent — never a model (constitution II).
  actor: fc.oneof(humanActorArb, agentActorArb),
  surface: fc.constantFrom('cli', 'studio', 'api', 'mcp', 'agent'),
  sessionId: fc.option(nonEmptyStringArb, { nil: undefined }),
  createdAt: timestampArb,
  supersededBy: fc.option(uuidV7Arb, { nil: undefined }),
});

export const predictionArb = fc.record({
  id: uuidV7Arb,
  sampleId: uuidV7Arb,
  modelVersionId: uuidV7Arb,
  labelKey: fc.constantFrom('kitchen', 'bathroom', 'assembly'),
  probabilityRaw: fc.double({ min: 0, max: 1 }),
  probabilityCalibrated: fc.option(fc.double({ min: 0, max: 1 }), { nil: undefined }),
  latencyMs: fc.option(fc.integer({ min: 0, max: 600_000 }), { nil: undefined }),
  costMicroUsd: fc.option(fc.integer({ min: 0, max: 10_000_000 }), { nil: undefined }),
  agreementJson: fc.option(jsonArb, { nil: undefined }),
  // Model only — never a human (constitution II).
  actor: modelActorArb,
  // Provenance is complete (US4): the surface is REQUIRED, the session is not.
  surface: fc.constantFrom('cli', 'studio', 'api', 'mcp', 'agent'),
  sessionId: fc.option(nonEmptyStringArb, { nil: undefined }),
  createdAt: timestampArb,
});

export const datasetSnapshotArb = fc.record({
  id: uuidV7Arb,
  manifestHash: sha256Arb,
  splitAssignments: sha256Arb,
  ontologyVersionId: uuidV7Arb,
  parentSnapshotId: fc.option(uuidV7Arb, { nil: undefined }),
  createdAt: timestampArb,
  lineageJson: fc.option(jsonArb, { nil: undefined }),
});

export const experimentRunArb = fc.record({
  id: uuidV7Arb,
  kind: fc.constantFrom('classify', 'train', 'eval', 'arena', 'al', 'agent'),
  inputSnapshotId: fc.option(uuidV7Arb, { nil: undefined }),
  configFingerprint: fingerprintArb,
  status: fc.constantFrom('queued', 'running', 'succeeded', 'failed', 'cancelled', 'abstained'),
  metricsSummaryJson: fc.option(jsonArb, { nil: undefined }),
  startedAt: timestampArb,
  endedAt: fc.option(timestampArb, { nil: undefined }),
});

export const modelVersionArb = fc.record({
  id: uuidV7Arb,
  name: fc.constantFrom('siglip-2', 'clip-vit', 'qwen-vl'),
  version: nonEmptyStringArb,
  registryState: fc.constantFrom('draft', 'candidate', 'registered', 'deprecated', 'legacy'),
  recipe: fc.option(jsonArb, { nil: undefined }),
  artifactPath: fc.option(nonEmptyStringArb, { nil: undefined }),
  calibrationRef: fc.option(nonEmptyStringArb, { nil: undefined }),
  modelCardPath: fc.option(nonEmptyStringArb, { nil: undefined }),
  createdAt: timestampArb,
});

export const evaluationRunArb = fc.record({
  id: uuidV7Arb,
  experimentRunId: uuidV7Arb,
  protocol: fc.constantFrom('holdout-v1', 'arena-v2'),
  resultsJson: jsonArb,
  reportPath: fc.option(nonEmptyStringArb, { nil: undefined }),
  createdAt: timestampArb,
});

export const deploymentArb = fc.record({
  id: uuidV7Arb,
  modelVersionId: uuidV7Arb,
  target: fc.constantFrom('local', 'mps', 'server'),
  configJson: jsonArb,
  active: fc.boolean(),
  promotedAt: fc.option(timestampArb, { nil: undefined }),
  pinnedFromId: fc.option(uuidV7Arb, { nil: undefined }),
  createdAt: timestampArb,
});

export const feedbackEventArb = fc.record({
  id: uuidV7Arb,
  sampleId: uuidV7Arb,
  kind: fc.constantFrom('correction', 'flag', 'production'),
  payloadJson: jsonArb,
  createdAt: timestampArb,
});

export const agentRunArb = fc.record({
  id: uuidV7Arb,
  goal: fc.constantFrom('audit duplicate images', 'compare arena winners'),
  status: fc.constantFrom('queued', 'running', 'succeeded', 'failed', 'cancelled', 'abstained'),
  budgetJson: jsonArb,
  toolCalls: fc.array(toolCallArb, { maxLength: 4 }),
  approvals: fc.array(approvalArb, { maxLength: 3 }),
  reportPath: fc.option(nonEmptyStringArb, { nil: undefined }),
  createdAt: timestampArb,
});

export const derivedArtifactArb = fc.record({
  id: uuidV7Arb,
  kind: fc.constantFrom('thumbnail', 'embedding', 'report', 'mask', 'crop'),
  sourceAssetIds: fc.array(uuidV7Arb, { minLength: 1, maxLength: 3 }),
  sourceSnapshotId: fc.option(uuidV7Arb, { nil: undefined }),
  transform: fc.constantFrom('resize:256', 'embed:siglip2', 'crop:center'),
  transformFingerprint: fingerprintArb,
  createdAt: timestampArb,
});
