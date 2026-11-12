# Observability, performance engineering and operations

## Required telemetry

OpenTelemetry-compatible traces with correlation `workspace_id`, `job_id`, `experiment_id`, `model_revision`, `snapshot_digest`, `request_id`; never include secrets or raw media. Span tree: API submission -> authorization -> store -> worker lease -> data read -> preprocessing -> inference -> calibration -> persistence -> evaluation -> report. Track retries, errors, fallbacks and approval pauses.

## Metrics

- Queue waiting time, worker utilization, job status/rate, worker crashes, lease expiration, cancellations.
- Inference p50/p95 (cold and warm), images/sec, batch size, model load times, peak CPU/RAM/MPS memory.
- VLM provider requests, token input/output, recorded billed cost or estimated list price with label, cache-hit rate, rate limit failures.
- Dataset ingestion bytes/sec, corruption, duplicate rate, index staleness, storage utilization, artifact checksum failures.
- Model quality by slice and time, calibration decay, drift metrics, human-review yield and duration.
- Agent tool trajectory quality, unsupported claims, approval frequency and denied effects.

## SLO/SLA distinction

Internal targets, not promises: >= 99% successful deterministic local job completion on valid fixtures, p95 progress event delay < 2s in local profile, successful job recovery from restart without duplicate result, no undeclared provider calls. Numeric performance thresholds set only after baseline from target hardware. Public SaaS uptime SLO out of scope for first demo.

## Reliability runbooks

- **Provider outage:** short circuit to local eligible model; if quality not safe, abstain. Mark missing cloud result; never silently alter suite comparability.
- **GPU OOM:** release model and memory, back off batch or switch to CPU if permitted; annotate fallback.
- **Index mismatch:** reject stale embedding index if encoder revision/dimensions/preprocessing differ; offer explicit rebuild.
- **Corrupt artifact:** quarantine, rebuild from source refs if available; never repair hash in place.
- **SQLite lock:** single writer, bounded busy timeout, queued writes, persistent event capture.
- **Experiment mismatch:** compare manifest fingerprints, refuse cross-run regression claim if different test subset.
- **Secret exposure:** revoke, rotate, scrub traces and check Git history, document blast radius.

## Release evidence

Every release includes changed contracts, test results, benchmark gates, dependency audit, compatibility matrix, deployment smoke tests and rollback path. Capture a machine-readable provenance tuple linked from the README demo result.
