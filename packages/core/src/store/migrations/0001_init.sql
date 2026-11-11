-- 0001_init — the Vision Lens domain store (spec 002, US2 / US4).
--
-- Conventions used by every table in this file:
--
--   * Column names are snake_case; the repository layer maps them to the
--     camelCase field names of the contracts in @vision-lens/contracts.
--   * JSON-shaped columns hold CANONICAL JSON (sorted keys, no whitespace),
--     produced by `canonicalJson` from the contracts. Absent is NULL.
--   * Every table carries `created_at` (insert time) and `updated_at`
--     (bumped on every write). They are store-owned bookkeeping columns and
--     are NOT part of the contract entity shape.
--   * Identity is UUIDv7 (TEXT), matching `z.uuidv7()` in the contracts.
--
-- Constitutional invariants enforced AT THE DATABASE LEVEL (second line of
-- defence behind the contracts):
--
--   * Provenance is mandatory: annotations and predictions carry NOT NULL
--     actor kind/ref, surface, session id and recorded timestamp. The
--     provenance that has a natural value — `actor_ref` and `surface` — is
--     CHECK-constrained against the empty string, so "provenance is
--     mandatory" is STRUCTURAL and not a convention: a raw INSERT with
--     `actor_ref = ''` is refused by SQLite itself.
--   * The "not recorded" sentinel: the fields the CONTRACTS leave optional
--     (`sessionId` on annotations and on predictions) live in NOT NULL
--     columns that store the empty string when nothing was recorded. The
--     sentinel is a storage detail: the repository layer reads it back as
--     `undefined` (see `repositories/base.ts`), so an entity read from the
--     database still satisfies its contract schema. `session_id` is
--     therefore deliberately NOT CHECK-constrained against `''`.
--   * Prediction != Annotation: `annotations.actor_kind` is CHECK-constrained
--     to human|agent and `predictions.actor_kind` to model, so a model output
--     can never be recorded as an annotation and vice versa.
--   * Lineage is mandatory: `derived_artifacts.source_asset_ids_json`,
--     `transform` and `transform_fingerprint` are NOT NULL, and the source
--     list must be a non-empty JSON array.
--   * Originals are immutable: an asset is content-addressed by `sha256`
--     unless it is explicitly flagged `unhashed = 1` (the CHECK makes those
--     two states mutually exclusive).
--
-- Destructive changes to this schema require a MAJOR CONTRACTS_VERSION bump
-- (see migrate.ts).

-- The migration ledger. The runner bootstraps this table before the first
-- migration is applied, so it is created defensively here as well.
CREATE TABLE IF NOT EXISTS schema_migrations (
  id         TEXT PRIMARY KEY,
  hash       TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

-- A capture session: one device/camera producing a stream of frames.
CREATE TABLE capture_sessions (
  id           TEXT PRIMARY KEY,
  started_at   TEXT NOT NULL,
  ended_at     TEXT,
  source       TEXT NOT NULL,
  context_json TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- An agent investigation. Referenced by annotations authored by an agent.
CREATE TABLE agent_runs (
  id                TEXT PRIMARY KEY,
  goal              TEXT NOT NULL,
  status            TEXT NOT NULL,
  budget_json       TEXT NOT NULL,
  tool_calls_json   TEXT NOT NULL,
  approvals_json    TEXT NOT NULL,
  report_path       TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- An immutable version of the label taxonomy.
CREATE TABLE ontology_versions (
  id              TEXT PRIMARY KEY,
  version         TEXT NOT NULL,
  categories_json TEXT NOT NULL,
  fingerprint     TEXT NOT NULL,
  parent_id       TEXT REFERENCES ontology_versions(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- An immutable, content-addressed view of a dataset.
CREATE TABLE dataset_snapshots (
  id                 TEXT PRIMARY KEY,
  manifest_hash      TEXT NOT NULL,
  split_assignments  TEXT NOT NULL,
  ontology_version_id TEXT NOT NULL REFERENCES ontology_versions(id) ON DELETE RESTRICT,
  parent_snapshot_id TEXT REFERENCES dataset_snapshots(id) ON DELETE SET NULL,
  lineage_json       TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

-- An original, immutable media file.
CREATE TABLE assets (
  id                 TEXT PRIMARY KEY,
  sha256             TEXT,
  kind               TEXT NOT NULL CHECK (kind IN ('image', 'video', 'audio', 'other')),
  bytes              INTEGER,
  width              INTEGER,
  height             INTEGER,
  exif_sanitized_json TEXT,
  capture_session_id TEXT REFERENCES capture_sessions(id) ON DELETE SET NULL,
  unhashed           INTEGER NOT NULL CHECK (unhashed IN (0, 1)),
  path               TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  -- sha256 is present exactly when the asset is hashed: the two states are
  -- mutually exclusive (an unhashed asset carries a path-hash placeholder id
  -- instead of a content hash).
  CHECK ((unhashed = 1 AND sha256 IS NULL) OR (unhashed = 0 AND sha256 IS NOT NULL))
);

-- A labelled unit of observation: one asset, optionally one region of it.
CREATE TABLE samples (
  id                    TEXT PRIMARY KEY,
  asset_id              TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  region_json           TEXT,
  split                 TEXT,
  snapshot_ids_json     TEXT NOT NULL DEFAULT '[]',
  source_capture_frame  TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

-- One run of the pipeline (classify / train / eval / arena / al / agent).
CREATE TABLE experiment_runs (
  id                   TEXT PRIMARY KEY,
  kind                 TEXT NOT NULL CHECK (kind IN ('classify', 'train', 'eval', 'arena', 'al', 'agent')),
  input_snapshot_id    TEXT REFERENCES dataset_snapshots(id) ON DELETE SET NULL,
  config_fingerprint   TEXT NOT NULL,
  status               TEXT NOT NULL
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'abstained')),
  metrics_summary_json TEXT,
  started_at           TEXT NOT NULL,
  ended_at             TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

-- A versioned model in the registry.
--
-- `experiment_run_id` is a STORE-OWNED link column (see the store schema
-- documentation): the contracts' ModelVersion has no pointer to the run that
-- produced it, but the auditor walk (spec 002, task 5.2) must reach the
-- experiment run from a prediction. It is NULL when the model version was
-- imported without that context.
CREATE TABLE model_versions (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  version            TEXT NOT NULL,
  registry_state     TEXT NOT NULL
    CHECK (registry_state IN ('draft', 'candidate', 'registered', 'deprecated', 'legacy')),
  recipe_json        TEXT,
  artifact_path      TEXT,
  calibration_ref    TEXT,
  model_card_path    TEXT,
  experiment_run_id  TEXT REFERENCES experiment_runs(id) ON DELETE SET NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

-- A human- (or agent-) authored ground-truth label.
--
-- PROVENANCE IS MANDATORY: actor kind/ref, surface, session id and the
-- recorded timestamp are NOT NULL. `actor_ref` and `surface` are
-- CHECK-constrained against the empty string: an annotation that says WHO
-- produced it or THROUGH WHICH SURFACE can never be blank, not even through a
-- raw INSERT that bypasses the repository.
--
-- `session_id` is NOT NULL with the empty string as the "no session recorded"
-- sentinel, because the contract marks `sessionId` optional — a NOT NULL
-- column with a sentinel keeps the column non-nullable now and avoids a
-- table rebuild when the contracts later require a session. The sentinel is
-- read back as `undefined` (never as `''`), so the round trip preserves the
-- contract.
CREATE TABLE annotations (
  id                   TEXT PRIMARY KEY,
  sample_id            TEXT NOT NULL REFERENCES samples(id) ON DELETE CASCADE,
  ontology_version_id  TEXT NOT NULL REFERENCES ontology_versions(id) ON DELETE RESTRICT,
  label_key            TEXT NOT NULL,
  geometry_json        TEXT,
  actor_kind           TEXT NOT NULL CHECK (actor_kind IN ('human', 'agent')),
  actor_ref            TEXT NOT NULL CHECK (actor_ref <> ''),
  actor_display_name   TEXT,
  actor_agent_run_id   TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  surface              TEXT NOT NULL CHECK (surface <> ''),
  session_id           TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  superseded_by        TEXT REFERENCES annotations(id) ON DELETE SET NULL
);

-- A model-produced label.
--
-- PROVENANCE IS MANDATORY (same rules as annotations) and the actor is
-- constrained to `model`: a human label can never be stored here
-- (constitution II, FR-002). `actor_ref` and `surface` are CHECK-constrained
-- against the empty string, for the same reason as on `annotations`.
--
-- `session_id` is NOT NULL and carries the "not recorded" sentinel; see the
-- header comment of this file.
CREATE TABLE predictions (
  id                      TEXT PRIMARY KEY,
  sample_id               TEXT NOT NULL REFERENCES samples(id) ON DELETE CASCADE,
  model_version_id        TEXT NOT NULL REFERENCES model_versions(id) ON DELETE RESTRICT,
  label_key               TEXT NOT NULL,
  probability_raw         REAL NOT NULL CHECK (probability_raw >= 0 AND probability_raw <= 1),
  probability_calibrated  REAL CHECK (probability_calibrated IS NULL OR (probability_calibrated >= 0 AND probability_calibrated <= 1)),
  latency_ms              REAL,
  cost_micro_usd          REAL,
  agreement_json          TEXT,
  actor_kind              TEXT NOT NULL CHECK (actor_kind = 'model'),
  actor_ref               TEXT NOT NULL CHECK (actor_ref <> ''),
  actor_version           TEXT NOT NULL,
  surface                 TEXT NOT NULL CHECK (surface <> ''),
  session_id              TEXT NOT NULL,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);

-- The measured evaluation of one experiment under a named protocol.
CREATE TABLE evaluation_runs (
  id               TEXT PRIMARY KEY,
  experiment_run_id TEXT NOT NULL REFERENCES experiment_runs(id) ON DELETE CASCADE,
  protocol         TEXT NOT NULL,
  results_json     TEXT NOT NULL,
  report_path      TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

-- A model version made available on a target.
CREATE TABLE deployments (
  id               TEXT PRIMARY KEY,
  model_version_id TEXT NOT NULL REFERENCES model_versions(id) ON DELETE RESTRICT,
  target           TEXT NOT NULL,
  config_json      TEXT NOT NULL,
  active           INTEGER NOT NULL CHECK (active IN (0, 1)),
  promoted_at      TEXT,
  pinned_from_id   TEXT REFERENCES deployments(id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

-- An append-only signal about a sample (correction / flag / production).
CREATE TABLE feedback_events (
  id           TEXT PRIMARY KEY,
  sample_id    TEXT NOT NULL REFERENCES samples(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('correction', 'flag', 'production')),
  payload_json TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- An artifact derived from original assets (thumbnail, embedding, report,
-- mask, crop).
--
-- LINEAGE IS MANDATORY: the source asset list, the transform and the
-- transform fingerprint are NOT NULL and the source list must be a non-empty
-- JSON array. `source_snapshot_id` is nullable (a derivation may reference
-- assets without a snapshot) but the repository layer enforces that at least
-- one source is present.
--
-- `encoder_model_version_id` is a STORE-OWNED link column (see the store
-- schema documentation): the contracts' DerivedArtifact carries no pointer to
-- the model that produced it, but the auditor walk must reach the encoder of
-- an embedding.
CREATE TABLE derived_artifacts (
  id                        TEXT PRIMARY KEY,
  kind                      TEXT NOT NULL CHECK (kind IN ('thumbnail', 'embedding', 'report', 'mask', 'crop')),
  source_asset_ids_json     TEXT NOT NULL,
  source_snapshot_id        TEXT REFERENCES dataset_snapshots(id) ON DELETE SET NULL,
  transform                 TEXT NOT NULL,
  transform_fingerprint     TEXT NOT NULL,
  encoder_model_version_id  TEXT REFERENCES model_versions(id) ON DELETE SET NULL,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  CHECK (
    json_valid(source_asset_ids_json)
    AND json_type(source_asset_ids_json) = 'array'
    AND json_array_length(source_asset_ids_json) >= 1
  )
);

-- READ-ONLY join view for UI convenience: one row per (sample × annotation ×
-- prediction) combination.
--
-- It is read-only BY CONSTRUCTION: it is a SQL VIEW, and SQLite rejects any
-- INSERT/UPDATE/DELETE against a view that has no INSTEAD OF trigger
-- ("cannot modify label_view because it is a view"). The view never writes.
CREATE VIEW label_view AS
SELECT
  s.id                        AS sample_id,
  s.asset_id                  AS asset_id,
  s.split                     AS split,
  a.path                      AS asset_path,
  a.sha256                    AS asset_sha256,
  a.unhashed                  AS asset_unhashed,
  ann.id                      AS annotation_id,
  ann.label_key               AS annotation_label_key,
  ann.actor_kind              AS annotation_actor_kind,
  ann.actor_ref               AS annotation_actor_ref,
  ann.surface                 AS annotation_surface,
  ann.session_id              AS annotation_session_id,
  ann.created_at              AS annotation_created_at,
  ann.superseded_by           AS annotation_superseded_by,
  pred.id                     AS prediction_id,
  pred.label_key              AS prediction_label_key,
  pred.probability_raw        AS prediction_probability_raw,
  pred.probability_calibrated AS prediction_probability_calibrated,
  pred.latency_ms             AS prediction_latency_ms,
  pred.cost_micro_usd         AS prediction_cost_micro_usd,
  pred.model_version_id       AS prediction_model_version_id,
  mv.name                     AS model_name,
  mv.version                  AS model_version
FROM samples s
JOIN assets a ON a.id = s.asset_id
LEFT JOIN annotations ann ON ann.sample_id = s.id
LEFT JOIN predictions pred ON pred.sample_id = s.id
LEFT JOIN model_versions mv ON mv.id = pred.model_version_id;

-- Indices on the hot paths: every foreign key that is joined or filtered on,
-- plus the created_at timeline used by the "what happened when" queries.

CREATE INDEX idx_assets_sha256 ON assets(sha256);
CREATE INDEX idx_assets_created_at ON assets(created_at);
CREATE INDEX idx_assets_capture_session_id ON assets(capture_session_id);

CREATE INDEX idx_samples_asset_id ON samples(asset_id);
CREATE INDEX idx_samples_created_at ON samples(created_at);

CREATE INDEX idx_annotations_sample_id ON annotations(sample_id);
CREATE INDEX idx_annotations_superseded_by ON annotations(superseded_by);
CREATE INDEX idx_annotations_ontology_version_id ON annotations(ontology_version_id);
CREATE INDEX idx_annotations_created_at ON annotations(created_at);
CREATE INDEX idx_annotations_actor_agent_run_id ON annotations(actor_agent_run_id);

CREATE INDEX idx_predictions_sample_id ON predictions(sample_id);
CREATE INDEX idx_predictions_model_version_id ON predictions(model_version_id);
CREATE INDEX idx_predictions_created_at ON predictions(created_at);

CREATE INDEX idx_model_versions_experiment_run_id ON model_versions(experiment_run_id);
CREATE INDEX idx_model_versions_name_version ON model_versions(name, version);

CREATE INDEX idx_experiment_runs_input_snapshot_id ON experiment_runs(input_snapshot_id);
CREATE INDEX idx_experiment_runs_started_at ON experiment_runs(started_at);

CREATE INDEX idx_dataset_snapshots_parent_snapshot_id ON dataset_snapshots(parent_snapshot_id);
CREATE INDEX idx_dataset_snapshots_created_at ON dataset_snapshots(created_at);

CREATE INDEX idx_evaluation_runs_experiment_run_id ON evaluation_runs(experiment_run_id);
CREATE INDEX idx_deployments_model_version_id ON deployments(model_version_id);
CREATE INDEX idx_feedback_events_sample_id ON feedback_events(sample_id);
CREATE INDEX idx_derived_artifacts_source_snapshot_id ON derived_artifacts(source_snapshot_id);
CREATE INDEX idx_derived_artifacts_encoder_model_version_id ON derived_artifacts(encoder_model_version_id);
CREATE INDEX idx_ontology_versions_parent_id ON ontology_versions(parent_id);
