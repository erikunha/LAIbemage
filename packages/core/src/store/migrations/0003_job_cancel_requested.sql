-- 0003_job_cancel_requested — the CANCEL_REQUESTED job state and the audit
-- ledger of job-state transitions (spec 018, task 4.3; FR-012).
--
-- WHAT CHANGES
--
--   1. `experiment_runs.status` widens from six states to seven: the new
--      intermediate `cancel_requested` sits between `running` and the
--      terminal `cancelled`. Cancellation is best effort, so a run is first
--      MARKED as cancel-requested (the operator's intent, durable even if
--      the host dies mid-cancellation), and only the confirmed stop moves it
--      to the immutable terminal `cancelled`.
--   2. A new append-only `job_transitions` table: the audit ledger. Every
--      status transition of an experiment run is appended there by the
--      repository layer, and UPDATE/DELETE against it are refused BY
--      TRIGGER, so the ledger is immutable at the database level, not by
--      convention (the pack's rule: "every transition appended to audit
--      ledger", docs/vnext/09-RUNTIME-JOBS-RESILIENCE.md:5).
--
-- WHY A TABLE REBUILD
--
-- SQLite cannot widen a CHECK constraint in place, and the bytes of 0001 are
-- immutable once applied (the migration runner hashes them). The rebuild
-- follows the documented SQLite procedure (sqlite.org/lang_altertable,
-- section 7), adapted to the runner's contract that every migration runs
-- INSIDE one transaction with `foreign_keys = ON` (db.ts: a pragma toggle is
-- a no-op inside a transaction):
--
--   * Every affected table is renamed to a quarantine name first. A rename
--     re-points the tables that reference it, so the quarantine set is the
--     whole reference closure of `experiment_runs`: evaluation_runs,
--     model_versions, legacy_imports, legacy_sample_payloads, predictions,
--     deployments, derived_artifacts, plus the label_view that joins
--     predictions and model_versions.
--   * The canonical tables are created again under their real names —
--     byte-identical DDL to 0001/0002 EXCEPT the widened status CHECK — and
--     every row is copied.
--   * The quarantine tables are dropped LEAVES FIRST: by the time a
--     quarantined parent dies, nothing references it, so DROP TABLE's
--     implicit delete fires no ON DELETE action and no row is lost.
--   * Indices, the append-only triggers and label_view are recreated.
--
-- The migration is DATA-PRESERVING: no row is dropped, no foreign key is
-- severed (tests/store/cancel-transition.test.ts proves both on a seeded
-- store, and PRAGMA foreign_key_check must stay empty). It is additive in
-- meaning: every status the old CHECK accepted is still accepted.
--
-- Destructive changes to this schema require a MAJOR CONTRACTS_VERSION bump.

-- 1. Quarantine: rename the whole reference closure (references follow).
ALTER TABLE experiment_runs RENAME TO experiment_runs_q;
ALTER TABLE evaluation_runs RENAME TO evaluation_runs_q;
ALTER TABLE model_versions RENAME TO model_versions_q;
ALTER TABLE legacy_imports RENAME TO legacy_imports_q;
ALTER TABLE legacy_sample_payloads RENAME TO legacy_sample_payloads_q;
ALTER TABLE predictions RENAME TO predictions_q;
ALTER TABLE deployments RENAME TO deployments_q;
ALTER TABLE derived_artifacts RENAME TO derived_artifacts_q;
DROP VIEW label_view;

-- 2. The canonical tables again (identical to 0001/0002 except the CHECK).
CREATE TABLE experiment_runs (
  id                   TEXT PRIMARY KEY,
  kind                 TEXT NOT NULL CHECK (kind IN ('classify', 'train', 'eval', 'arena', 'al', 'agent')),
  input_snapshot_id    TEXT REFERENCES dataset_snapshots(id) ON DELETE SET NULL,
  config_fingerprint   TEXT NOT NULL,
  status               TEXT NOT NULL
    CHECK (status IN ('queued', 'running', 'cancel_requested', 'succeeded', 'failed', 'cancelled', 'abstained')),
  metrics_summary_json TEXT,
  started_at           TEXT NOT NULL,
  ended_at             TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE TABLE evaluation_runs (
  id               TEXT PRIMARY KEY,
  experiment_run_id TEXT NOT NULL REFERENCES experiment_runs(id) ON DELETE CASCADE,
  protocol         TEXT NOT NULL,
  results_json     TEXT NOT NULL,
  report_path      TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

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

CREATE TABLE legacy_imports (
  manifest_id         TEXT PRIMARY KEY,
  run_path            TEXT NOT NULL,
  shape               TEXT NOT NULL,
  experiment_run_id   TEXT NOT NULL REFERENCES experiment_runs(id) ON DELETE RESTRICT,
  ontology_version_id TEXT REFERENCES ontology_versions(id) ON DELETE RESTRICT,
  model_version_id    TEXT NOT NULL REFERENCES model_versions(id) ON DELETE RESTRICT,
  counts_json         TEXT NOT NULL,
  imported_at         TEXT NOT NULL
);

CREATE TABLE legacy_sample_payloads (
  sample_id     TEXT NOT NULL REFERENCES samples(id) ON DELETE CASCADE,
  manifest_id   TEXT NOT NULL REFERENCES legacy_imports(manifest_id) ON DELETE RESTRICT,
  condition_text TEXT,
  payload_json  TEXT NOT NULL,
  PRIMARY KEY (sample_id, manifest_id)
);

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

-- The audit ledger. One row per status transition, appended by the
-- repository (never updated, never deleted: the triggers below refuse both
-- at the database level). `from_status` is NOT NULL: a ledger row is a
-- TRANSITION, and a run's initial state lives in the run row itself.
CREATE TABLE job_transitions (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES experiment_runs(id) ON DELETE RESTRICT,
  from_status  TEXT NOT NULL
    CHECK (from_status IN ('queued', 'running', 'cancel_requested', 'succeeded', 'failed', 'cancelled', 'abstained')),
  to_status    TEXT NOT NULL
    CHECK (to_status IN ('queued', 'running', 'cancel_requested', 'succeeded', 'failed', 'cancelled', 'abstained')),
  reason       TEXT,
  recorded_at  TEXT NOT NULL
);

-- 3. Copy every row.
INSERT INTO experiment_runs (id, kind, input_snapshot_id, config_fingerprint, status, metrics_summary_json, started_at, ended_at, created_at, updated_at)
  SELECT id, kind, input_snapshot_id, config_fingerprint, status, metrics_summary_json, started_at, ended_at, created_at, updated_at FROM experiment_runs_q;
INSERT INTO evaluation_runs (id, experiment_run_id, protocol, results_json, report_path, created_at, updated_at)
  SELECT id, experiment_run_id, protocol, results_json, report_path, created_at, updated_at FROM evaluation_runs_q;
INSERT INTO model_versions (id, name, version, registry_state, recipe_json, artifact_path, calibration_ref, model_card_path, experiment_run_id, created_at, updated_at)
  SELECT id, name, version, registry_state, recipe_json, artifact_path, calibration_ref, model_card_path, experiment_run_id, created_at, updated_at FROM model_versions_q;
INSERT INTO legacy_imports (manifest_id, run_path, shape, experiment_run_id, ontology_version_id, model_version_id, counts_json, imported_at)
  SELECT manifest_id, run_path, shape, experiment_run_id, ontology_version_id, model_version_id, counts_json, imported_at FROM legacy_imports_q;
INSERT INTO legacy_sample_payloads (sample_id, manifest_id, condition_text, payload_json)
  SELECT sample_id, manifest_id, condition_text, payload_json FROM legacy_sample_payloads_q;
INSERT INTO predictions (id, sample_id, model_version_id, label_key, probability_raw, probability_calibrated, latency_ms, cost_micro_usd, agreement_json, actor_kind, actor_ref, actor_version, surface, session_id, created_at, updated_at)
  SELECT id, sample_id, model_version_id, label_key, probability_raw, probability_calibrated, latency_ms, cost_micro_usd, agreement_json, actor_kind, actor_ref, actor_version, surface, session_id, created_at, updated_at FROM predictions_q;
INSERT INTO deployments (id, model_version_id, target, config_json, active, promoted_at, pinned_from_id, created_at, updated_at)
  SELECT id, model_version_id, target, config_json, active, promoted_at, pinned_from_id, created_at, updated_at FROM deployments_q;
INSERT INTO derived_artifacts (id, kind, source_asset_ids_json, source_snapshot_id, transform, transform_fingerprint, encoder_model_version_id, created_at, updated_at)
  SELECT id, kind, source_asset_ids_json, source_snapshot_id, transform, transform_fingerprint, encoder_model_version_id, created_at, updated_at FROM derived_artifacts_q;

-- 4. Drop the quarantine tables, leaves first: nothing references a
--    quarantined table by the time it dies, so no ON DELETE action fires
--    and no copied row is lost.
DROP TABLE predictions_q;
DROP TABLE deployments_q;
DROP TABLE derived_artifacts_q;
DROP TABLE legacy_sample_payloads_q;
DROP TABLE evaluation_runs_q;
DROP TABLE legacy_imports_q;
DROP TABLE model_versions_q;
DROP TABLE experiment_runs_q;

-- 5. Indices again (they died with the quarantined tables).
CREATE INDEX idx_experiment_runs_input_snapshot_id ON experiment_runs(input_snapshot_id);
CREATE INDEX idx_experiment_runs_started_at ON experiment_runs(started_at);
CREATE INDEX idx_evaluation_runs_experiment_run_id ON evaluation_runs(experiment_run_id);
CREATE INDEX idx_model_versions_experiment_run_id ON model_versions(experiment_run_id);
CREATE INDEX idx_model_versions_name_version ON model_versions(name, version);
CREATE INDEX idx_predictions_sample_id ON predictions(sample_id);
CREATE INDEX idx_predictions_model_version_id ON predictions(model_version_id);
CREATE INDEX idx_predictions_created_at ON predictions(created_at);
CREATE INDEX idx_deployments_model_version_id ON deployments(model_version_id);
CREATE INDEX idx_derived_artifacts_source_snapshot_id ON derived_artifacts(source_snapshot_id);
CREATE INDEX idx_derived_artifacts_encoder_model_version_id ON derived_artifacts(encoder_model_version_id);
CREATE INDEX idx_legacy_imports_experiment_run_id ON legacy_imports(experiment_run_id);
CREATE INDEX idx_legacy_imports_manifest_id ON legacy_sample_payloads(manifest_id);
CREATE INDEX idx_legacy_sample_payloads_condition ON legacy_sample_payloads(condition_text);
CREATE INDEX idx_job_transitions_run_id ON job_transitions(run_id);
CREATE INDEX idx_job_transitions_recorded_at ON job_transitions(recorded_at);

-- 6. The ledger is append-only BY CONSTRUCTION, not by convention.
CREATE TRIGGER job_transitions_append_only_update BEFORE UPDATE ON job_transitions
BEGIN
  SELECT RAISE(ABORT, 'job_transitions is an append-only audit ledger: UPDATE is refused');
END;

CREATE TRIGGER job_transitions_append_only_delete BEFORE DELETE ON job_transitions
BEGIN
  SELECT RAISE(ABORT, 'job_transitions is an append-only audit ledger: DELETE is refused');
END;

-- 7. The read-only join view again (identical to 0001).
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
