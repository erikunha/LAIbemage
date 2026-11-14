# Roadmap — Vision Lens

> **Last updated:** November 2026  
> **Status key:** 🟢 Shipped · 🔵 Planned · ⏸ Deferred · ❌ Removed · 🏗 Building (spec in progress)
>
> **North star:** a Visual Intelligence Engineering Workbench — the local-first engineering
> layer connecting visual data, specialized models and measured operational outcomes.
> Decisions: ADR-005 (pivot), ADR-006 (monorepo), ADR-007 (local-first), ADR-008 (evidence
> policy), ADR-009 (agent safety), ADR-010 (spec governance, superseded by ADR-020). Detailed
> plan lives in local planning material that is not tracked (ADR-020); this file is the tracked
> mirror.

---

## Phase map (Vision Lens)

```mermaid
flowchart LR
  F0["F0 Foundation<br/>001 monorepo<br/>002 contracts<br/>003 real benchmark"] --> F1["F1 Visual Data + Arena<br/>004 data engine<br/>005 embeddings<br/>006 arena"]
  F1 --> F2["F2 Learning<br/>007 training<br/>008 flywheel<br/>(first demo)"]
  F2 --> F3["F3 Interfaces + Agents<br/>009 API/jobs<br/>010 Studio<br/>011 MCP<br/>012 agent"]
  F3 --> F4["F4 Production<br/>013 gates, drift,<br/>cost optimizer"]
  F4 -. declared only .-> F5["F5 Frontier<br/>014 video / Physical AI /<br/>synthetic / doc-intel"]
```


| Phase | Focus | Specs | Outcome | Status |
|---|---|---|---|---|
| F0 | Foundation | 001 monorepo · 002 domain/contracts · 003 real benchmark | rebirth scaffold, entity store · VisA ground truth + runner (003, shipped) | 🏗 001 🟢 · 002 🟢 (domain contracts + entity store + legacy importer) · 003 🟢 (real VisA benchmark harness; the first measurement was taken on a degenerate all-train split and is retired, the tracked split is now a real 60/20/20 partition) |
| F1 | Visual Data + Arena | 004 data engine · 005 embeddings/search · 006 model arena | trustworthy datasets + calibrated model comparison | 🔵 |
| F2 | Learning | 007 training · 008 active-learning flywheel | specialized models + measured data loop — **first demo** | 🔵 |
| F3 | Interfaces + Agents | 009 API/jobs · 010 Studio · 011 MCP · 012 agent runtime | four equivalent surfaces + safe investigations | 🔵 |
| F4 | Production | 013 release gates, observability, drift, cost optimizer | promotion gates, incident primitives, cost control | 🔵 |
| F5 | Frontier | 014 declarations | video / Physical AI / synthetic / doc-intel reserved | ⏸ (declared) |

**First demo (closes F2):** import VisA subset → audit quality → embedding baseline probe →
arena (VLM vs local) → review hard cases (Studio) → AL batch → retrain → holdout delta
report (quality × cost × latency) → same investigation via agent over MCP.

---

## Historical record — v2.0 (legacy `ai-image-labeling` CLI)

Feature-complete and shipped (2024-01 → 2026-08). Preserved as `packages/core`/`cli`/`sdk`
(spec 001). Highlights: H1 cost & reliability (async batches, prompt caching, structured
output) · H2 data richness (lean schema, linking, SQLite) · H3 platform (hybrid routing,
self-critique, `--learn`, SDK, plugins) · H4–H5 hardening & breadth (Azure batch, atomic
writes) · H6 intelligence (suggest-categories, active-learn queue, calibration table) ·
H7 architecture gate (ports/adapters: Reporter, FileRepository; readonly data; provider
split) · H8 enterprise (S3/GCS/Azure outputs, webhooks, Bedrock/Vertex, TypeDoc) ·
H9 semantic retrieval (text embeddings + hybrid search) · H11 workflow intelligence
(sessions, consensus, diff).

Superseded by Vision Lens decisions:

| Was | Now |
|---|---|
| "No GUI / no HTTP server" (ROADMAP 2026-05: "What we are not building") | Superseded by ADR-005 — Studio, API and MCP are core surfaces (specs 009–011) |
| H12 COCO/YOLO/Label-Studio exports (YOLO = artificial full-image boxes, H12.2) | Spec 004: Ultralytics **classification** layout (per-class/split dirs); detection exports only with real geometry; Label-Studio flow → 010 review + 008 queue |
| H13 FTS5 / quantization / RRF; H15 HNSW/sharding | Superseded by spec 005 (LanceDB + real visual encoders); text search remains available |
| H14 CLIP-via-Ollama, query expansion, rerank | Absorbed into spec 005 encoder registry (SigLIP 2 / CLIP / DINOv2 on MPS) |
| H16 integrity items (readonly partial cache, maxAttempts rename, dep classification, index schema versioning, fs/sdk docs) | Spec 001/002 hygiene tasks — per-item status in the H16 table below |
| "Video out of scope" | F5 frontier track (spec 014) |
| Multi-user/SaaS exclusion | Still excluded for the product; SaaS exploration was a separate unmerged track |

### H16 integrity carryovers — status (spec 001)

| Item | Status | Note |
|---|---|---|
| H16.1 readonly partial cache | ✅ | all `PartialAnalysisCache` fields `readonly`; type-level test asserts mutation fails typecheck (`packages/core/tests/types.test.ts`) |
| H16.2 maxAttempts rename | ✅ | shipped earlier in 8da7a28 |
| H16.3 dependency classification | ✅ | `better-sqlite3` in `packages/core` optionalDependencies; guarded dynamic import with actionable error + missing-module test (`packages/core/tests/reporter/sqlite-missing.test.ts`) |
| H16.4 FileRepository in run paths | ✅ | shipped with H7 ports/adapters |
| H16.5 index schema versioning | 🔵 | superseded by 002 fingerprint v2 — full-config fingerprints replace the name-only hash |
| H16.6 fs/sdk docs rows | ✅ | AGENTS.md boundary table carries `packages/core/src/fs/` + `packages/sdk/` rows |

---

## Vision Lens phases in detail

### F0 — Foundation (specs 001–003)

- Monorepo (pnpm + Turborepo), `vision-lens` CLI + `ai-image-labeling` compat alias, CI fast gate,
  AGENTS boundary table for package layout — **zero behavior change, 361 tests green
  throughout** (001).
- Domain model + `packages/contracts` (14 entities, Zod, OpenAPI), SQLite store,
  fingerprint v2 fixing `src/index.ts:77` name-only hash (002).
- Shipped in 002: 14 versioned Zod entities with Prediction≠Annotation enforced structurally,
  the generated OpenAPI 3.1 seed, the SQLite entity store with migrations, repositories and
  the lineage walk, and the idempotent `vision-lens import-run` legacy importer.
- Real benchmark, **shipped under 003**: VisA subset (CC BY 4.0, license registry), seeded
  gold splits, metrics runner (per-class F1, ECE calibration, latency, cost), regression
  baselines. The dataset is fetched and checksum-pinned (`datasets/registry.json`), the
  committed gold manifest holds 700 real images (`benchmarks/splits/visa-subset.gold.json`), and
  the first real run scored `gpt-4o` at **macro F1 0.9795** / **balanced accuracy 0.9700** over
  all 700 of them. The tracked evidence is the gold set, the raw predictions and the baseline
  (`benchmarks/splits/visa-subset.gold.json`, `benchmarks/predictions/visa-subset.gpt-4o.json`,
  `benchmarks/baselines/visa-subset.json`); the run report (`benchmarks/results/<runId>/`) is a
  local artifact that the documented command reproduces. Every number comes from the 003
  artifacts (`benchmarks/baselines/<suite>.json`, `benchmarks/splits/*.gold.json`,
  `datasets/registry.json`) produced by `vision-lens benchmark run|gate|report`.
  **That first number is retired, not a product claim.** It was measured on the v1 split, whose
  700 assignments were all in `train`: the upstream release has no session information, so each
  class is one capture group, and a group larger than every quota cannot be divided into three
  partitions. With no held-out set it measures nothing, so the baseline entry carries
  `status: "retired"` and the reason. The tracked split is now the v2 one
  (`benchmarks/splits/visa-subset.v2.gold.json`, strategy `stratified`, 420 train / 140 val /
  140 test, item-level and stratified by class and anomaly), the suite id is `visa-subset.v2`,
  and the benchmark gate refuses to bless a number that was measured on a split other than the
  tracked one. The first measurement on the v2 split is still to be run.
- Synthetic accuracy claims retired: the legacy colour-swatch harness (package script
  `benchmark:legacy`, formerly the default accuracy runner) stays only as a unit-test
  fixture; it is not an accuracy source (ADR-008).

### F1 — Visual Data + Arena (004–006)

- Ingestion (hashing, EXIF sanitize, thumbnails, bomb guards), immutable snapshots,
  data-quality lab (dup/near-dup, leakage, imbalance), corrected exports (004).
- Python vision service (SigLIP 2 / CLIP / DINOv2 on MPS, memory admission), LanceDB,
  hybrid visual/text search, clustering (005).
- Model Arena: suites across VLM providers × encoder-probe × trained models; temperature
  scaling calibration; consensus v2 (agreement, not declared confidence — fixes
  `src/analyzer/consensus.ts:53`); Pareto reports (006).

### F2 — Learning (007–008) — first demo

- Training engine: linear probe → staged/full fine-tune, MPS backoff, MLflow local,
  checkpoints/resume, model registry v0 + model cards with license lineage (007).
- Flywheel: uncertainty×diversity selection, review queue, budget-aware cascade
  (local → specialized → VLM → human), holdout-proven delta reports (008). `--learn`
  stays as prompt aid during its deprecation window, superseded by real training.

### F3 — Interfaces + Agents (009–012)

- Fastify API + OpenAPI from contracts + SQLite job queue (resumable, idempotent, SSE)
  (009).
- Studio: dataset explorer, annotation review with provenance (AI-suggested ≠
  human-approved), experiment compare, A/B arena. **Visual design arrives from an external
  uxpilot.ai prototype** — spec 010 defines structure/flows and the integration point
  (tokens + skin layer), not the visual language (010).
- MCP server: tiered tools (read → analyze → propose → gated → approval-required), untrusted
  visual content as data, no fs/exec surface (011, ADR-009).
- Agent runtime: LangGraph investigator, budgets, checkpoints, approval gates,
  artifact-cited reports, evaluation harness with golden tasks (012).

### F4 — Production (013)

Release gates (macro-F1 floor, critical-class recall floor, calibration drift bound,
latency/cost budgets) · promotion/rollback via registry pin · inference service with
content-hash caching · OpenTelemetry traces + cost ledger · drift monitors (embedding PSI,
label distribution, calibration decay) → incident primitives ("time travel") ·
total-expected-cost optimizer reports (inference + review + FP + FN).

### F5 — Frontier (014, declared only)

Video intelligence · Physical AI sensors (Calibration, SynchronizedSequence reserved in 002)
· synthetic data factory (real-holdout-validated) · document intelligence ·
open-vocabulary concepts · SAM-family GPU workers (optional adapters, ADR-007).
Activation requires a new ADR + spec per track.

---

## Phase map (vNext series, 015-027)

The canonical design package delivered 2026-11-11 is integrated verbatim under `docs/vnext/`
(64 tracked files, `docs/vnext/MANIFEST.sha256` validated). It supersedes the earlier design
only where it says so (`docs/vnext/00-ADOPTION-NO-OVERWRITE.md`): Python-first public ML
library, a lightweight remote SDK split from the fat in-process exports, Python usable
in-process without an HTTP server, the VisA number treated as a regression baseline with no
holdout claim, registry and publishing gates before any availability claim, and one Python
distribution with optional extras. The working breakdown of the pack is local planning
material (ADR-020); this section is the tracked mirror. Statuses here are implementation
statuses in words, not the emoji key above: done, partially shipped (concrete gaps named),
divergence recorded (maintainer decision pending), not started. Each milestone ships one
reproducible vertical slice and counts as done only after passing its exit gate; the full
train definition (R0 to R9) is `docs/vnext/23-RELEASE-ROADMAP.md`.

```mermaid
flowchart LR
  R2[["R2 Data Foundation<br/>shipped<br/>021 done · 022 shipped"]] --> R3["R3 Visual Embeddings<br/>open · no ticket yet"]
  R3 --> R4["R4 Model Arena<br/>open · no ticket yet"]
  R4 --> R5["R5 Training Flywheel<br/>open · 023 not started"]
  R2 --> R4
  R2 --> R5
  R2 --> R6["R6 Studio and API<br/>open · 024/025 not started"]
  R2 --> R7["R7 SDK, MCP and Agent<br/>open · 026 decision pending"]
```

Shape key: the subroutine box is partially shipped, plain boxes are open. R2 feeds every later
milestone: the leakage-resistant split and the scorecard gate what R3 through R7 may claim.

| Release | Focus (specs in this series) | Exit gate | Status |
|---|---|---|---|
| R0 Reconcile | reconciliation record, baseline, the Python-first decision (015, 016) | zero lost work; green baseline; signed reconciliation | 015 done · 016 divergence recorded, maintainer decision pending |
| R1 Python Library | public `visionlens` wheel (017), JSONL worker protocol (018), CPU vision adapter (019), TS facade (020) | the wheel works without Node; TS and Python reach golden parity | 017 and 018 partially shipped · 019 partially shipped · 020 divergence recorded, maintainer decision pending |
| R2 Data Foundation | leakage-resistant split (021), evaluation scorecard v2 (022) | nonempty train/val/test; source, license and hash gating | 021 done · 022 shipped |
| R3 Visual Embeddings | no ticket in this series yet | Recall@k test; hardware profiling; index mismatch tests | not started |
| R4 Model Arena | no ticket in this series yet | identical locked test set; per-class plus cost and latency reports | not started |
| R5 Training Flywheel | encoder plus linear probe baseline (023) | active learning vs random; independent holdout delta | not started |
| R6 Studio and API | thin npm remote client (024), read-only Studio Arena slice (025) | one guided end-to-end workflow with accessibility and SSE | not started |
| R7 SDK, MCP and Agent | MCP dataset investigator (026) | same operation parity; injection and budget approval gates | divergence recorded, maintainer decision pending |
| Process | ADR-020 repository separation (027) | knowledge kept under `docs/procedures/`; the tracked-file guard stays green | done |

Spec-level statuses (post-audit, 2026-11-12; row 019 updated 2026-11-14):

| Spec | Pack id | Release | Scope | Status |
|---|---|---|---|---|
| 015 | VLN-001 | R0 | reconciliation report and the baseline record the rest of the series cites | done |
| 016 | VLN-002 | R0 | Python-first ML runtime ADR and the owner map of what moves to Python | divergence recorded, maintainer decision pending: the spec's python-ownership artifacts (its numbered ADR, the owner map, the boundary checker) never landed; `python/visionlens` exists and supersedes the spec's "no python yet" premise |
| 017 | VLN-003 | R1 | public `visionlens` distribution: packaging, extras, wheel, publishing gates | partially shipped: the wheel is built, `uv.lock` and the release gate landed with PR #42, the typed facade for capabilities and image metadata shipped with the dated packaging amendment of ADR-011, and the verification workflow that runs the gate in CI landed with no registry credential and no publish step |
| 018 | VLN-004 | R1 | cross-language JSONL worker protocol: handshake, events, errors, cancellation | partially shipped: the protocol landed across contracts, core and Python (both hosts and the suites); golden fixtures, secret redaction, retry backoff, the `CANCEL_REQUESTED` job transition, the schema generator and the ADR still open |
| 019 | VLN-005 | R1 | one CPU vision adapter with golden predictions and fingerprints | partially shipped: the model capability registry landed, with the pinned siglip2-base record (the exact revision, the sha256 of the real weights and the license, refused unless all three are present) and the two readers that resolve it, refusing the same records field by field; the CPU adapter, the golden parity gate and the inference-time failure paths (missing weights, corrupt image, license gate) are still open |
| 020 | VLN-006 | R1 | TypeScript facade over the Python worker, old CLI path preserved | divergence recorded, maintainer decision pending: the facade module it names (`packages/core/src/facade/`) never landed; the TS host client shipped inside the worker module as-built |
| 021 | VLN-007 | R2 | leakage-resistant train/val/test partition and the gate that protects it | done |
| 022 | VLN-008 | R2 | evaluation scorecard: held-out metrics, calibration, per-sample artifacts | shipped: the scorecard module, the regime gate and five suites, the `benchmark scorecard` CLI command with its typed refusals, the committed pointer directory and the documentation of the held-out figure landed. The CLI `benchmark gate` carries no scorecard yet, so a suite cannot migrate from the whole-set regime to the scorecard regime from the command line yet |
| 023 | VLN-009 | R5 | local encoder plus linear probe baseline, recorded on CPU and MPS | not started |
| 024 | VLN-010 | R6 | thin npm remote client with no heavy transitives | not started |
| 025 | VLN-011 | R6 | read-only Studio Arena slice over the controlled API | not started |
| 026 | VLN-012 | R7 | MCP dataset investigator: tool parity, injection and budget gates | divergence recorded, maintainer decision pending: `packages/mcp/` does not exist; only the read-only contract inputs it cites are in the tree |
| 027 | - | process | ADR-020 repository separation: procedures kept, personal machinery removed, tracked-file guard green | done |

The three divergence rows (016, 020, 026) each carry their divergence record inline, naming
how the written plan and the shipped tree drifted apart (audited 2026-11-12), and leave the
maintainer the choice between rewriting as-built, closing as superseded, or implementing
later; no choice is recorded yet.

| Series | State after the reconciliation audit (015, done) |
|---|---|
| 001-014 foundation | largely landed at the foundation: monorepo (001), entities and contracts (002), real benchmark splits (003); 004 and 006 partially landed; 005, 007, 008, 011, 012, 013, 014 not started; 009 and 010 placeholders. Tracked record: `docs/migration/vision-lens-vnext-reconciliation.md` |

---

## What we are not building (current)

| Item | Reason |
|---|---|
| Owned foundation models | Adapt, evaluate and operate existing ones (constitution governance) |
| Multi-user / SaaS / RBAC | Single-user local-first; revisit with validated demand (vision monetization hypotheses) |
| Distributed/multi-GPU training | One MPS device; CUDA only via optional adapters (ADR-007) |
| Medical imaging vertical | Validation/regulatory burden out of scope for now |
| Local planning material in git | Planning stays local (ADR-020); ADRs + this roadmap are the tracked record |

## Metrics that matter (Vision Lens additions)

| Area | Metric | Target |
|---|---|---|
| Evidence | Benchmark on real data only (VisA subset) | enforced (003) |
| Calibration | ECE per model on the gold split | reported every arena run (006) |
| Reproducibility | Same config+snapshot+seed+env → val macro-F1 Δ | ≤ 0.02 (007) |
| Flywheel | AL batch → holdout macro-F1 delta vs random batch | measured, reported per round (008) |
| Cost | Cost per correctly-processed image (cascade vs single-model) | Pareto-reported (006/013) |
| Review | Human review minutes per accepted model improvement | ledger-tracked (008/013) |
| Integration | CLI = API = Studio = MCP parity table | green in CI (009/011) |
| Ops | p95 list endpoints @10k samples | < 50 ms (009) |

(Legacy CLI metrics — cache hit rate, unknown rate, hybrid cost split — remain tracked in
`packages/core`.)
