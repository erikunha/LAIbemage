# Vision Lens — Canonical Engineering Specification vNext

**Date:** 2026-11-11. **Status:** design target and agent handoff; **not** a claim that these features are built. **Product:** Vision Lens (formerly LAIbemage / ai-image-labeling). **Repository:** `erikunha/LAIbemage`, working development branch `feat/visual-lens`. **Technical direction:** Python-first visual ML runtime + TypeScript-first product/developer platform; one contract spine, two public SDKs.

## How to use this package without losing work

1. Start with `00-ADOPTION-NO-OVERWRITE.md`. This document is essential when a coding agent is already working.
2. Compare the agent's **actual working tree and branch** with `01-REPO-STATE-2026-11-11.md`. The remote branch is a snapshot, not an assertion about unpushed edits.
3. Read `02-ARCHITECTURE-DECISION.md` and `adrs/ADR-011-python-first-ml-runtime.md`. These override the *future technical direction* of the previous design; **they do not invalidate or overwrite shipped TypeScript code**.
4. Read `03-PRODUCT-AND-SUCCESS.md`, `04-ARCHITECTURE-C4.md`, then the specific technical domains `05` through `22`.
5. Execute only the next unblocked implementation specification under `specs/`. Follow the release gates in `23-RELEASE-ROADMAP.md`.
6. Run the validation in `validation/validate_pack.py`. Use `docs` as reference; **do not copy schemas or migration SQL over tracked files** until compared with the live implementation.

## Authority and precedence

- **Reality:** local working tree > HEAD of active branch > publicly inspected `feat/visual-lens` > older `main` > old generated documentation.
- **Design target:** this package supersedes the 2026-11-10 LAIbemage master proposal *only where explicitly stated*. Product direction is approved by the user; implementation and accepted ADRs require repository integration.
- **Existing runtime contracts:** the implemented Zod and store schema in `packages/contracts` and `packages/core/src/store` stay canonical until new versions are deliberately shipped. Example schemas in this ZIP are **proposals**, not replacements.
- **Agent rule:** first produce a discrepancy report, then apply focused changes on a branch; never delete, reset, rebase, or overwrite unrelated user/agent work to fit this blueprint.

## North-star demo

A visitor imports a small licensed visual dataset, audits it, computes visual embeddings, compares a VLM with a local encoder + linear probe, reviews uncertain images, retrains on corrected data, and sees a **strictly held-out** evaluation of quality, p95 latency, cost per accepted result, and human-review work. CLI, Studio, Python library, npm SDK, API, and MCP expose the same audited operations. An investigation agent uses bounded tools and approval gates; it never silently trains, exports private images, or promotes models.

## Read map

| Area | Files |
|---|---|
| Adoption & observed state | `00`, `01`, `02`, `26` |
| Product | `03`, `22`, `24` |
| Architecture | `04`, `05`, `06`, `07`, `08`, `09` |
| Data & ML | `10`, `11`, `12`, `13`, `14`, `15`, `16` |
| Interfaces & operations | `17`, `18`, `19`, `20`, `21` |
| Roadmap, delivery | `23`, `25`, `specs/`, `adrs/` |
| Machine-readable examples | `contracts/proposed/`, `examples/`, `validation/` |
| Prior vision retained | `reference/LAIbemage_Master_2026-11-10.zip` (historical, NOT canonical) |

**Out of scope for first public demo:** SaaS billing and multitenancy, a generic enterprise data labeling replacement, training foundation models, on-device robotics control, real-time camera streams, distributed GPUs, autonomous irreversible actions.
