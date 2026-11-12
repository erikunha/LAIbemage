-- 0002_legacy_import.rollback — undoes 0002_legacy_import completely.
--
-- The objects are dropped in reverse dependency order. The tables of
-- 0001_init are untouched: rolling back this migration removes the legacy
-- import bookkeeping and nothing else.

DROP INDEX IF EXISTS idx_legacy_sample_payloads_condition;
DROP INDEX IF EXISTS idx_legacy_imports_manifest_id;
DROP INDEX IF EXISTS idx_legacy_imports_experiment_run_id;

DROP TABLE IF EXISTS legacy_sample_payloads;
DROP TABLE IF EXISTS legacy_imports;

-- `schema_migrations` is intentionally KEPT: the runner manages it and it is
-- the ledger that proves which migrations were applied.
