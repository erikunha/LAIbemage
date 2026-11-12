# Release train 2026-Q4 to 2028+ (milestone gates, not promises)

**Execution principle:** each milestone ships one reproducible vertical slice; work already completed in public `feat/visual-lens` stays counted. Dates are planning windows subject to the local agent's actual progress and scientific evidence. No global milestone status may become `DONE` without passing its gate.

| Milestone | Work | Already observed? | Exit gate |
|---|---|---|---|
| **R0 — Reconcile** | compare working tree, branch/docs/spec-kit; record baseline; approve Python-first ADR | partial: monorepo/contracts/store/bench exist | zero lost work; green baseline; signed reconciliation |
| **R1 — Python Library** | public `visionlens` package, base IO, CPU inference, JSONL bridge, contract adapters | Python skeletons only | wheel works without Node; TS↔Python golden parity |
| **R2 — Data Foundation** | robust import, immutable snapshots, audit, leakage-resistant split | TS 14 entities/store/VisA import present | nonempty train/val/test, source/license/hash gating |
| **R3 — Visual Embeddings** | local encoders CLIP/SigLIP, index, hybrid search, CPU/MPS | proposed, not implemented in inspected branch | Recall@k test, hardware profiling, index mismatch tests |
| **R4 — Model Arena** | VLM vs local vs probe, calibration, Pareto, uncertainty comparison | TS benchmark scaffold and VLM baseline present | identical locked test set, per-class + cost/latency reports |
| **R5 — Training Flywheel** | PyTorch/sklearn recipes, MLflow, review/AL, retrain/eval | Python training skeleton | AL vs random benchmark, independent holdout delta |
| **R6 — Studio/API** | Fastify async jobs, Next.js explorer, review, experiment and Arena | placeholders | one guided end-to-end workflow with accessibility and SSE |
| **R7 — SDK/MCP/Agent** | light npm client, CLI/API parity, MCP tool tiers, supervised agent | npm re-export/CLI exist | same operation parity, injection + budget approval gates |
| **R8 — Optimized Runtime** | cascade routing, ONNX where suitable, cost/drift, model promotion | planned | Pareto and regression gate; rollback works |
| **R9 — Frontier** | video, doc intelligence, Physical AI, synthetic factory, agents network | declared only | independent ADR + real demand + dataset/evaluation |

## Dependencies

- R1 requires R0; R2 can advance alongside R1 but must resolve split blocker before R4 or R5.
- R3 depends on library and dataset interfaces (R1/R2).
- R4 depends on valid held-out test split (R2), model adapters (R3) and complete cost recording.
- R5 depends on R4 and human review workflow; no training improvement claims without locked test data.
- R6 can ship early read-only Studio without R5; robust review flow requires R2.
- R7 MCP and agents depend on stable domain operations and policy engine, not on every R6 UI feature.
- R8 follows measured demand/operational data. R9 never blocks public portfolio launch.

## Prioritized next 12 tickets

| ID | Deliverable | Done evidence |
|---|---|---|
| VLN-001 | Reconciliation and baseline report | branch status/diffs, tests, assigned KEEP/AMEND decisions |
| VLN-002 | ADR Python-first + owner map | review and no conflicting code claims |
| VLN-003 | `visionlens` package skeleton | clean venv import, wheel+sdist test |
| VLN-004 | Cross-language protocol v1 handshake | malformed/mismatch/cancel tests |
| VLN-005 | Python CPU embed/infer one adapter | golden predictions with fingerprints |
| VLN-006 | TS facade to Python worker | old CLI continues, explicit new route |
| VLN-007 | Fix split policy for VisA | nonempty disjoint partitions, leakage audit |
| VLN-008 | Evaluation scorecard v2 | held-out metrics, calibration, per-sample artifacts |
| VLN-009 | Local encoder + probe baseline | CPU/MPS recorded runs |
| VLN-010 | Thin npm remote client entrypoint | browser/Node smoke tests; no Sharp transitives |
| VLN-011 | Read-only Studio Arena slice | accessible 10k sample virtualization; controlled API |
| VLN-012 | MCP investigate one dataset | tool parity + injection and budget tests |

## Stop conditions

Do not add second vector database without benchmark showing actual need; no multiagent swarm without evaluated benefit; no GPU training service before CPU/MPS recipe; no external SaaS billing without customer validation. Early public GitHub demo is allowed with R4 read-only artifacts and explicit limitations.
