-- 0001_init.rollback — undoes 0001_init completely.
--
-- Rollback scripts are REAL, not decorative (spec 002, plan: "Reliability |
-- WAL crash test; idempotent importer; rollback scripts"). The migration
-- runner refuses to roll back a migration whose rollback script is missing.
--
-- The objects are dropped in reverse dependency order.

DROP VIEW IF EXISTS label_view;

DROP TABLE IF EXISTS derived_artifacts;
DROP TABLE IF EXISTS feedback_events;
DROP TABLE IF EXISTS deployments;
DROP TABLE IF EXISTS evaluation_runs;
DROP TABLE IF EXISTS predictions;
DROP TABLE IF EXISTS annotations;
DROP TABLE IF EXISTS model_versions;
DROP TABLE IF EXISTS experiment_runs;
DROP TABLE IF EXISTS samples;
DROP TABLE IF EXISTS assets;
DROP TABLE IF EXISTS dataset_snapshots;
DROP TABLE IF EXISTS ontology_versions;
DROP TABLE IF EXISTS agent_runs;
DROP TABLE IF EXISTS capture_sessions;

-- `schema_migrations` is intentionally KEPT: the runner manages it and it is
-- the ledger that proves which migrations were applied.
