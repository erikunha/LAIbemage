# Product and portfolio specification

## Positioning

**Vision Lens** is a local-first Visual AI Engineering Workbench: curate visual data, adapt/compare specialized vision models, measure quality and operating cost, and verify agent-assisted decisions. It is not merely an image labeler nor a generic hosted annotation SaaS. Primary audience: CV/ML engineers, applied AI engineers, data quality teams and systems-oriented software engineers.

## Core jobs-to-be-done

1. Given unorganized images, determine dataset completeness, licensing, duplicates, label reliability and splitting risks.
2. Given two model approaches, compare them under the **same locked evaluation protocol** rather than just prompt anecdotes.
3. Given limited budget, decide which examples merit human review or an expensive VLM call.
4. Given review corrections, train/adapt a small model and demonstrate improvement on a genuinely unseen test set.
5. Given suspicious output, trace the prediction through asset bytes, model checkpoint, preprocessing, ontology, prompt, calibration, evidence and feedback.
6. Given a request through Python, TS SDK, CLI, Studio or MCP, execute the **same application operation** with equivalent results and permissions.

## Personas

| Persona | Critical workflow | Acceptance |
|---|---|---|
| Researcher | Compare zero-shot encoder, linear probe, VLM | reproducible metrics, splits and environment |
| Annotation reviewer | Correct uncertain examples | provenance, keyboard flow, batch undo, review time |
| Platform engineer | Deploy/rollback model under limits | artifact pinning, fail-closed gates, telemetry |
| Applied AI engineer | Agent investigates dataset failures | tool traces, bounded permissions, artifact citations |
| Developer | Integrate from Python or npm | typed SDK, examples, reproducible local start |

## Outcome metrics

- **Scientific:** macro F1, per-class precision/recall, balanced accuracy, AUROC where relevant, ECE/Brier, IoU/mAP per task, confidence intervals; measure on explicit test partitions.
- **Operational:** p50/p95 latency, batch throughput, peak RAM/VRAM, failure/retry counts, run success, cost per correctly processed image including human review.
- **Review:** correction yield, minutes per resolved mistake, accepted label count, disagreement types, post-review improvement vs random sampling.
- **Developer:** first successful Python run, first SDK run, CLI/API/Studio/MCP contract parity, setup failures, linkable artifact report.

## First public showcase

A single reproducible walkthrough using a documented licensed subset (VisA or alternate). Visitors can inspect sample records, compare predictions, see the ground truth and review queue, and reproduce a non-paid baseline. BYOK is optional and sandboxed. No marketing claims are made from the current all-train benchmark.

## Not building yet

Multi-tenant SaaS, facial recognition of persons, medical diagnosis, unrestricted code-executing agents, production controls on robotics, large-scale distributed GPU training. Advanced modules may be researched but are not dependencies of the first demo.
