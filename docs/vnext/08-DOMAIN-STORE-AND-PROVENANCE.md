# Domain store, datasets, immutable artifacts and provenance

## Starting point

`packages/core/src/store` already implements SQLite migrations, repositories, lineage and a legacy importer. **Preserve** this existing store; do not replace with a speculative PostgreSQL schema. SQLite WAL with single writer is the local-first choice. PostgreSQL is a future shared-deployment adapter only if justified.

## Entity relationships

- `Asset`: immutable source bytes, content hash, EXIF sanitation metadata and original URI; write-once CAS.
- `CaptureSession`: camera/source provenance, not a classification label.
- `Sample`: image/region/frame pointing at Asset; split membership belongs to a **DatasetSnapshot**.
- `OntologyVersion`: stable class keys, hierarchy, descriptions, aliases, parents, version fingerprint.
- `Prediction`: model-origin label, model version and raw scores, calibrated score optional, source sample/run.
- `Annotation`: reviewer- or agent-proposed artifact, separate from Prediction; human approval is explicit and append-only.
- `DatasetSnapshot`: immutable list of sample IDs, ontology, split assignments and source fingerprints.
- `ExperimentRun`, `EvaluationRun`, `ModelVersion`: config, metrics, dataset/model/code/environment/provenance links.
- `DerivedArtifact`, `FeedbackEvent`, `AgentRun`, `Deployment`: full history and operational state.

## Invariants

1. No mutable overwrite of original asset or prior annotation; corrections supersede with `superseded_by` and audit event.
2. Train/validation/test membership versioned at snapshot creation. No model trained on test split and no AL selection from test labels.
3. Asset-to-annotation lineage complete; every model output references model revision, preprocessing spec and evaluation protocol.
4. Missing provenance, cost or latency is explicit `unknown`, not zero. Raw self-declared confidence is not probability calibration.
5. Asset IDs stable by full hash when bytes available; remote placeholders flagged, cannot claim verified bytes.
6. Transactions across repositories use idempotency keys; new result artifacts become visible only after checksum and atomic completion.
7. Versioned schema migration uses backup/snapshot, rollback plan and test; no implicit migration in `GET` API.

## Storage layout

```text
VISION_LENS_HOME/
  metadata/visionlens.sqlite
  assets/sha256/aa/bb/<hash>
  artifacts/<kind>/<run-id>/<manifest.json|data...>
  models/<model-id>/<revision>/
  cache/encoders/<revision>/
  sessions/<session-id>/
  temp/<job-id>/
```

No path from client input is trusted; resolve against approved root, forbid traversal/symlinks escaping root, and use size quotas. Encrypt or redact EXIF GPS/device identifiers for publicly displayed assets. Record per-artifact license, consent/usage scope and deletion semantics; lifecycle policies separate git from model/dataset artifacts.

## Cross-language ownership

TypeScript store remains the sole writer for domain metadata initially. Python emits versioned artifact manifests for TS to validate and commit. Python may use a local MLflow store for experiment internals but **must not independently mutate the SQLite domain tables**. Future Python in-process SDK may use an adapter to a stable application repository API; define single-writer guarantees before allowing offline direct DB writes.

## Migration and compatibility

Existing `analysis_results.json` imports via `vision-lens import-run`, not a destructive conversion. Preserve original file bytes and classification provenance. Bump legacy hash to full-config fingerprint only behind a backward-compatible read strategy; unknown provider/model metadata must not be fabricated.
