# Shared contracts, JSONL worker protocol and API versioning

## Source of truth: do not fork the domain

The **implemented** `packages/contracts/src` Zod schemas and `openapi.snapshot.json` own the stable public entities. Python adapts by generated JSON Schemas/validators and cross-language fixture conformance. Internal Python tensors and experiment recipes may have Pydantic models; when crossing the boundary, export an explicit schema and version it under `contracts/` after validation.

**Current domain invariants:** Prediction != Annotation; immutable original assets; required provenance/lineage; versioned ontology, experiment and model; accurate unknown fields; no invented cost, confidence or latency on legacy import. Existing SQLite store migrations are authoritative until a tested migration supersedes them.

## Protocol envelope (proposed v1)

```json
{
  "protocol": "visionlens.worker.v1",
  "kind": "request",
  "requestId": "req_001",
  "operation": "vision.embed",
  "contractVersion": "1.0.0",
  "workspaceId": "local",
  "params": {
    "snapshotId": "snap_001",
    "encoder": "siglip2-base",
    "outputArtifactDir": "/approved/workspace/artifacts"
  },
  "budget": {"maxSeconds": 120, "maxTokens": 0, "maxUsdMicro": 0}
}
```

Wire details: UTF-8 one JSON object per line; no stdout logs; `hello` includes supported operations, protocol version, model capabilities; `progress`, `result`, `error` event frames always include `requestId`, `seq` and monotonically increasing progress; `result` emitted at most once; typed error `code` and `retryable`. Stderr carries structured logs with secret redaction. Unknown major protocol -> fail closed before work. Limit message bytes, nesting and fields. Enforce request TTL, cancellation, bounds for `max*` values. Never interpolate asset path into a shell command; process is launched from a fixed allowlist.

## Operation catalog (proposed)

| Code | Side effects | Inputs | Result | Tier |
|---|---|---|---|---|
| `dataset.inspect` | none | snapshotId | stats, coverage | read |
| `dataset.audit` | report artifact | snapshotId, rules | auditReportId | analyze |
| `vision.embed` | derived artifacts | snapshotId, encoder | embeddingRunId | bounded compute |
| `vision.predict` | predictions | snapshotId, modelId | predictionRunId | bounded compute |
| `model.train` | checkpoints | dataset splits, recipe, budget | experimentRunId | approval |
| `eval.run` | metrics/report | immutable eval split, modelId | evaluationRunId | bounded compute |
| `annotation.propose` | review queue | sample ids, candidates | proposalId | propose |
| `model.promote` | deployment mapping | model id, gate decision | promotionId | privileged approval |

## Worker handshake

Before accepting operations, validate protocol major, contract major, Python build, installed extras, device capabilities and max frame size; return structured `UNSUPPORTED_PROTOCOL` or `MISSING_EXTRA`. The Fastify process must not assume Python models exist merely because the service imports.

## HTTP API patterns

Existing `packages/contracts/openapi.snapshot.json` is an **entity/operation seed**, not a shipped network API. Do not overwrite it with a hand-written file. Evolve it through Zod source + snapshot test.

Proposed routes:

| Endpoint | Description |
|---|---|
| `POST /v1/datasets` | create dataset workspace and metadata |
| `POST /v1/datasets/{id}/snapshots` | create immutable snapshot |
| `GET /v1/datasets/{id}/audit` | return latest quality audit (not implicit new run) |
| `POST /v1/jobs` | submit named operation with idempotency and budget |
| `GET /v1/jobs/{id}` | job status/result reference |
| `GET /v1/jobs/{id}/events` | SSE with cursor and reconnect |
| `POST /v1/evaluations` | submit immutable evaluation |
| `GET /v1/evaluations/{id}` | metrics, errors, evidence references |
| `POST /v1/annotations/proposals` | queue proposals; no auto-promotion |
| `POST /v1/annotations/{id}/review` | explicit human decision |
| `GET /v1/models` | available models + capabilities |
| `POST /v1/agent-runs` | start bounded investigation; default read-only |

Use POST 202 with `Location` + immutable operation ID for async work. Response schema: `data`, `meta`, optional `error`; never hidden `200` on failed job. Resource authorization runs before lookup to prevent ID probing.

## Schema evolution

- Structural breaking changes bump major. Additional optional fields may be minor if consumers ignore unknowns by policy; existing strict schemas may require explicit versions.
- Each run records contract fingerprint, runtime build, ontology fingerprint and model revision.
- Keep golden payload snapshots for TS->Python->TS parity. Fuzz invalid enums, missing fields, huge arrays and malicious paths.
