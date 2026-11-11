# ADR 008 — Evidence policy: real benchmarks, calibrated confidence, full fingerprints, Prediction ≠ Annotation

| Field    | Value                   |
| -------- | ----------------------- |
| Status   | Accepted                |
| Date     | 2026-11-10              |
| Deciders | @erikunha |

## Context

Four evidence defects make the current system's accuracy claims untrustworthy as a platform:

1. **Synthetic benchmark** — `packages/core/tests/fixtures/benchmark/labels.json:2` self-describes:
   "Images are synthetic colour swatches — replace with real photos for meaningful accuracy
   metrics." The runner computes real metrics over meaningless ground truth.
2. **Declared confidence treated as probability** — `src/analyzer/consensus.ts:53-54` picks
   the consensus winner by "higher confidence", where confidence is the model's self-reported
   number. Verbalized VLM confidence is known to be poorly calibrated (EMNLP 2025 findings on
   verbalized confidence), so decisions built on it are noise-sensitive.
3. **Name-only cache fingerprint** — `computeCategoriesHash` (`src/index.ts:77-83`) hashes
   only sorted category *names*; changing a category's *description* (which changes the
   prompt and therefore results) leaves caches stale without detection.
4. **Labels without provenance** — analysis results and human overrides live in one flat
   cache; nothing structurally distinguishes a model's guess from approved ground truth.

## Decision

**Evidence policy for the Master platform (binding on specs 002/003/006/008):**

1. **Real-dataset benchmark as the only accuracy source.** The regression benchmark runs on a
   VisA-derived subset (10,821-image industrial anomaly dataset, CC BY 4.0 via the AWS Open
   Data registry) with seeded, manifest-pinned gold splits (spec 003). Synthetic fixtures
   remain only as unit-test inputs. MVTec AD (CC BY-NC-SA 4.0) is research-only; every
   dataset records license + source + checksums in `datasets/registry.json` **before** first
   use.
2. **Empirical calibration over declared confidence.** Probabilities used by any decision
   (consensus, cascade routing, review queues) must come from calibrated surfaces: per-model
   temperature scaling fitted on held-out data, agreement statistics across independent
   provider families (spec 006). Consensus v2 replaces "higher declared confidence wins" with
   a configurable agreement policy that can escalate or abstain → human review. The legacy
   rule survives one deprecation window behind a flag.
3. **Full-semantic-config fingerprints.** Any cache/index/comparison key hashes model,
   prompt template, taxonomy **including category descriptions**, preprocessing, data version
   and contracts version (fingerprint v2, spec 002). The name-only hash is a defect class:
   changing a description without changing a name must invalidate caches. One-time migration
   invalidates old caches with an explicit recompute notice.
4. **Prediction ≠ Annotation as a schema invariant.** Model outputs and human ground truth
   are separate entities with separate tables; every label carries provenance (actor
   human/model@version, surface, session, timestamp); originals stay immutable and derived
   artifacts carry lineage (constitution II).

**A claim without its reproduction record is a hypothesis.** Every metric artifact must
resolve dataset snapshot + split seed + config fingerprint + model version + environment
capture (constitution I), enforced by the 003 runner refusing to emit unattributed reports.

## Consequences

**Positive:**

- Accuracy, calibration and cost numbers become defensible (portfolio-grade evidence).
- Calibration unlocks what declared confidence never could: honest uncertainty, cascades,
  budget-aware active learning (specs 006/008).
- Fingerprint v2 removes a silent-correctness bug class permanently.

**Negative:**

- First run pays a one-time cache invalidation and recompute; communicated explicitly.
- Consensus v2 changes outputs for disagreement cases vs legacy behavior; deprecation flag
  and characterization tests (ported from `tests/analyzer/consensus.test.ts`) govern the
  transition.
- VisA download (~GB-class) is a documented, checksum-verified step that CI treats as
  cached-or-skip, never auto-download.
