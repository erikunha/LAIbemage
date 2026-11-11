# VLN-005 — Move one ML capability to Python with parity, evidence and safe CPU execution.

**Status:** Proposed / reconcile before implementation. **Owner:** engineering. **Version:** vNext-2026-11-11. **Source:** design decision with repository baseline as observed on `feat/visual-lens`.

## User outcome
Move one ML capability to Python with parity, evidence and safe CPU execution.

## In scope / out of scope
Implement image decoder + visual encoder adapter (CLIP or SigLIP variant) on CPU; canonical preprocessing and embedding artifact output; MPS optional after CPU proof.

**Out of scope:** unrelated feature additions, broad repo rewrite, production SaaS changes, destructive migrations, release claims not backed by tests.

## Technical design and module responsibilities
Pin model revision/license/transform and preprocess fingerprint. Accept hashed asset refs; return vectors in content-addressed artifact with shape/dtype/digest. Avoid JSONL base64 vectors/images. Catch invalid image, OOM and unsupported model; emit latency/memory.

## Contract and data effects
Operation `vision.embed` with immutable dataset snapshot ID and encoder spec; response `embeddingRunId`, vector dim, dtype, count, artifact sha256, error samples.

Implementation must identify schema source, ownership, effect tier, idempotency and version. A behavior changing a persisted record must preserve provenance. Any new API operation must have a typed success and error result, and all external inputs are untrusted.

## Acceptance criteria
No model call without explicit download permission; 5-image fixture works on CPU; result repeatable within documented tolerance; output validates schema and refuses index mixing different dimensions/revisions.

## Test strategy
Preprocessing golden fixture; corrupt image; missing weights; license gate; TS worker bridge; CPU inference.

Each executed test and hardware/protocol measurement is recorded with the exact command, environment, git SHA, exit code and output artifact, not merely summarized as passing.

## Migration / rollback
Model adapter disabled in registry; TS existing textual embeddings retained.

## Agent definition of done
- [ ] Local working tree, branch and related specs inspected first.
- [ ] Failing test/fixture or measurable acceptance test committed before implementation.
- [ ] Correct contracts + error handling + bounded resource use.
- [ ] Existing TS and Python gates pass; new behavior has unit and integration coverage.
- [ ] Docs, ADR/roadmap status and user-facing CLI/SDK examples reconciled.
- [ ] Rollback strategy and unverified aspects documented.
