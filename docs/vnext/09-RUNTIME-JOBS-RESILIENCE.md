# Jobs, worker lifecycle and resource governance

## Job lifecycle

`CREATED -> QUEUED -> LEASED -> RUNNING -> (SUCCEEDED|FAILED|CANCELED|PARTIAL)`; `LEASED/RUNNING -> LOST` after heartbeat expiry and then a bounded retry if operation allows it. Terminal state immutable. Cancellation is best effort and has `CANCEL_REQUESTED` intermediate state. Every transition appended to audit ledger.

## Required Job fields

`id, operation, contract_version, workspace_id, subject_id, actor, idempotency_key, input_fingerprint, status, attempt, max_attempts, lease_owner, lease_until, heartbeat_at, created_at, started_at, ended_at, budget, resources, output_manifest_id, error_code, retention_policy`.

## Execution rules

- Persistent queue stored in existing SQLite using one writer and short transactions. Avoid adding Redis/Temporal until evidence of throughput or fault tolerance requirements.
- Lease by compare-and-set; heartbeat while worker running; queue limits per workspace and execution type (CPU vs MPS vs remote provider).
- Resource budget covers wall time, CPU/RAM/VRAM, token calls, USD micro-cost, image count, artifact bytes and nested agent iterations. When exhausted, fail closed with partial report.
- MPS model residency is controlled by a shared semaphore; no two heavy models assumed to fit. `DevicePlanner` checks actual capability at runtime; CPU fallback must be recorded, not hidden.
- Provider 429/503 and transient I/O errors use bounded backoff with jitter; deterministic invalid inputs do not retry. Never retry non-idempotent external action without reconciliation.
- Durable resumption requires checkpoint plus input/config fingerprint equality. Resume refuses changed ontology, model revision or dataset hash.
- SSE stream supports cursor (`Last-Event-ID`), history catchup, reconnect and terminal event, without holding a DB lock.

## Fault injection / acceptance

Kill Python worker mid-embedding, interrupt trainer after checkpoint, exhaust disk, corrupt an image, force provider timeout, issue duplicate idempotency key, cancel training during model save, restart API with pending jobs. Success means no double billing, no orphan models promoted, no corrupted snapshots and useful error reporting to the CLI/UI.

## Observability fields

Each job span includes operation, fingerprint, dataset hash, model revision, worker runtime version, resource decision, attempts, token usage, latency, cost, reviewer minutes and failure code; never raw images or secrets in telemetry.
