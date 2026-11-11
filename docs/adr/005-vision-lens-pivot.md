# ADR 005 — Vision Lens pivot: a Visual Intelligence Engineering Workbench

| Field    | Value                   |
| -------- | ----------------------- |
| Status   | Accepted                |
| Date     | 2026-11-10              |
| Deciders | @erikunha |
| Supersedes | `ROADMAP.md` "Historical record — v2.0" → the superseded row `"No GUI / no HTTP server" (ROADMAP 2026-05: "What we are not building")` (ROADMAP.md:57); the live exclusion list is "What we are not building (current)" (ROADMAP.md:147-155), which no longer carries the GUI / HTTP-server exclusions |

## Context

The project (product name for the evolution: **Vision Lens**; repository
`erikunha/LAIbemage`, whose CLI bin was named `ai-image-labeling` before the rename) is a
feature-complete v2.0 CLI: seven vision-LLM providers, hybrid local/cloud routing, consensus,
temporal sessions, text embeddings with keyword/semantic search, a plugin system, a TypeScript
SDK and 361 green tests over a ports-and-adapters architecture. The 2026-05 roadmap closed with an
explicit exclusion list: no GUI and no HTTP server — both recorded as superseded by this ADR in the
roadmap's "Historical record — v2.0" table (ROADMAP.md:57), and both absent from the current
"What we are not building (current)" list (ROADMAP.md:147-155).

The maintainer's 2026-11 strategy review redefined the goal: the project must demonstrate
Applied AI Engineer, ML Engineer and Staff/Principal Software Engineering competence as one
longitudinal system — real datasets with ground truth, trainable specialized models, empirical
evaluation and calibration, active learning with measured data flywheels, cost optimization,
agents with verifiable tools and approvals, and professional interfaces — instead of consuming
vision-LLM APIs around a single pipeline.

The old exclusions were correct for a batch classifier and are wrong for that platform:
human review needs a UI, equivalence across surfaces needs an API, and external agents need
MCP. None of them is decoration; each is load-bearing in the engineering cycle the strategy
demands.

## Decision

Vision Lens (the evolution of the CLI) becomes a **Visual Intelligence Engineering
Workbench**: a local-first platform
combining visual data engineering, multimodal intelligence (visual embeddings first,
classification, detection/segmentation later), training and experimentation, evaluation and
optimization (empirical calibration, Pareto quality/cost/latency), human-in-the-loop review,
agent-assisted investigation, and four equivalent surfaces — CLI (`vision-lens`, with
`ai-image-labeling` kept as a compatibility alias inside the CLI package), HTTP API,
Studio, and an MCP server.

Delivery is phased (F0–F5), each phase ending in a demonstrable end-to-end slice:

| Phase | Focus | Specs |
|---|---|---|
| F0 | monorepo foundation, domain contracts, real benchmark | 001–003 |
| F1 | visual data engine, embeddings/search, model arena | 004–006 |
| F2 | training engine, active-learning flywheel | 007–008 |
| F3 | API/jobs, Studio, MCP, agent runtime | 009–012 |
| F4 | release gates, observability, drift, cost optimizer | 013 |
| F5 | frontier declarations (video, Physical AI, synthetic data) | 014 |

The first public demo closes F2: import a real dataset (VisA subset) → audit data quality →
baseline linear probe → compare VLM against the local model in the arena → review hard cases →
active-learning batch → retrain → holdout evaluation → quality/cost/latency delta report → the
same investigation executed by an agent over MCP.

Historical horizons fold into the new plan rather than being discarded: H9/H11 remain shipped
as-is; H12 (exports) moves to spec 004 with the YOLO classification-format correction; H13,
H14 and H15 (search-infrastructure upgrades) are superseded by spec 005's LanceDB plus real
visual encoders; H16 integrity items land inside specs 001/002.

The remaining exclusions are re-evaluated, not inherited: GUI and HTTP server are now in scope
by this ADR; multi-user SaaS stays out (single-user local-first; the untracked 2026-07 SaaS
exploration was a separate track that never merged); video moves from "out of scope" to a
declared F5 frontier track (spec 014); domain-specific output fields stay out of the core
schema — domain meaning belongs to the versioned ontology (spec 002).

## Consequences

**Positive:**

- One system now exercises data engineering → computer vision → deep learning → ML systems →
  agent engineering → MLOps → production AI, which is the stated portfolio goal.
- The existing provider abstraction, ports/adapters boundaries and test discipline carry over
  as `packages/core` — the pivot preserves the strongest prior investment instead of rewriting it.
- Review, calibration and cost loops finally have UI and API surfaces, closing the data
  flywheel the CLI alone could only half-run.
- CLI compatibility (`ai-image-labeling` bin, kept inside the CLI package as a compatibility
  alias) keeps source installs and scripts working through a documented deprecation window
  (spec 001).

**Negative:**

- Scope grows by an order of magnitude; phased delivery and "each spec ships a slice" are the
  only controls against a permanent half-built state.
- A TS + Python monorepo adds tooling weight (pnpm + uv, two test stacks), accepted and
  bounded by ADR-006.
- The old "not building" table becomes historical: every future exclusion must now be argued
  on its own evidence, not quoted.
