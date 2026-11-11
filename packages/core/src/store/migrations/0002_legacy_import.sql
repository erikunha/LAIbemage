-- 0002_legacy_import — the bookkeeping of the legacy-run importer (spec 002, task 4).
--
-- APPEND-ONLY migration: it only ADDS two tables. It does not touch any table
-- created by 0001_init, and it does not rewrite any data. The migration
-- runner records its hash, so it can never be silently edited later.
--
-- ## Why a table at all
--
-- The importer needs two things the domain model does not have:
--
--   1. **A home for the run manifest id.** The identity of a legacy run is
--      `sha256(canonicalJson(parsedContent))`. It is the idempotency key
--      (SC-002): importing the same run twice must produce ZERO new rows.
--      The PRIMARY KEY below is the guard — a second import finds the row and
--      writes nothing. `processedDate` is NOT used as the identity: two
--      different runs can share it.
--
--   2. **A home for the legacy carry-over.** The legacy `condition` field
--      (17 free-text values in the wild) has NO target in the domain model.
--      It is real data, so it is not dropped — and it is not normalized into
--      a category or a defect enum either. It is stored VERBATIM here, next
--      to the sample it belongs to, OUTSIDE the contracts: the public
--      contract must not pretend a legacy free-text field is part of the
--      domain model.
--
-- ## Conventions
--
-- Same conventions as 0001_init: snake_case columns, canonical JSON in the
-- JSON columns (produced by `canonicalJson` from @vision-lens/contracts),
-- and `created_at`/`updated_at` bookkeeping on the ledger table.
--
-- Destructive changes to this schema require a MAJOR CONTRACTS_VERSION bump.

-- The ledger of imported legacy runs. One row per imported run.
--
-- `manifest_id` is the content hash of the run and the PRIMARY KEY: the
-- uniqueness constraint IS the idempotency guard.
--
-- `counts_json` stores the mapping counts of the import, so a re-import
-- reports exactly what the first import wrote.
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

-- The legacy carry-over: the VERBATIM legacy record of every imported image,
-- attached to the sample it produced.
--
-- `condition_text` is the explicit column for the legacy `condition` field
-- (queryable); `payload_json` holds the whole legacy record verbatim so
-- nothing is lost — the descriptions, the elements, the legacy numbers.
--
-- The primary key is (sample, manifest): the same sample imported by a
-- DIFFERENT run gets its own carry-over row, while re-importing the SAME
-- run can never duplicate a row.
CREATE TABLE legacy_sample_payloads (
  sample_id     TEXT NOT NULL REFERENCES samples(id) ON DELETE CASCADE,
  manifest_id   TEXT NOT NULL REFERENCES legacy_imports(manifest_id) ON DELETE RESTRICT,
  condition_text TEXT,
  payload_json  TEXT NOT NULL,
  PRIMARY KEY (sample_id, manifest_id)
);

CREATE INDEX idx_legacy_imports_experiment_run_id ON legacy_imports(experiment_run_id);
CREATE INDEX idx_legacy_imports_manifest_id ON legacy_sample_payloads(manifest_id);
CREATE INDEX idx_legacy_sample_payloads_condition ON legacy_sample_payloads(condition_text);
