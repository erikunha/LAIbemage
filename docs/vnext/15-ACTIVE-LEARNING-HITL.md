# Active learning, annotation flywheel and human governance

## Core loop

Ingest -> validate -> initial predictions -> select unresolved examples -> human correct/approve -> new annotation version -> new training snapshot -> train candidate -> locked independent evaluation -> compare against baseline -> promote only if gate succeeds. The test split is never eligible for selection.

## Selection methods

- Uncertainty: entropy/margin/least-confidence using **calibrated** estimates; if uncalibrated, mark heuristic and do not treat score as probability.
- Diversity: cluster-balanced embedding selection, k-center/coreset, dedup-aware sampling.
- Disagreement: model ensemble variants, but do not elect higher self-reported confidence as truth.
- Business importance: boost rare critical classes, use explicit and auditable class weights.
- Budget: pick under `max_images`, `max_review_minutes`, `max_cloud_usd` and optional error-loss constraints.
- Baseline: compare each strategy against same-sized random and uncertainty-only batches; report variance and confidence intervals.

## Reviewer contract

`ReviewTask`: sample id, current ontology version, proposed label(s), underlying predictions, reason for review, evidence links, cost/time expectation and irreversible action flag. `ReviewDecision`: accept/reject/edit/escalate, human actor, timestamp, ontology, optional reason and supersession pointer. No bulk auto-accept of model labels into ground truth. Keyboard and undo flows are mandatory.

## Dataset versioning

After review, produce new `DatasetSnapshot` with lineage to prior snapshot and explicit changed annotation IDs. Training pipeline consumes that immutable snapshot. Never retroactively alter an earlier benchmark result to look better.

## Scientific exit criteria

For a fixed annotation budget, active selection should deliver a repeatable improvement against random selection on a separate locked test set, or the report should explicitly state "no demonstrated gain". Improvement must include cost of review and token usage to support the CostOps thesis.

## Safeguards

Separate user-approved labels from model suggestions; reviewer cannot inadvertently alter protected test labels; provenance and license carry through augmentations; auto-train requires explicit budget approval; cleanup does not delete historical audit evidence.
