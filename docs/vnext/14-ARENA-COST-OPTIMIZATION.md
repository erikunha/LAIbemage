# Model Arena and AI CostOps engine

## Product objective

Compare model strategies by **quality, coverage, latency, cost and review workload** under one evaluation protocol; choose a non-dominated Pareto candidate or declare insufficient evidence. The tool does not crown a universally best model.

## Arena comparison

On the same immutable evaluation snapshot, run (A) VLM cloud, (B) local zero-shot encoder, (C) encoder+probe or fine-tuned model, (D) cascaded routing. Store per-sample prediction and errors, confidence (raw/calibrated), output category, model ID, time, tokens, API rate timestamp, fallback decision and provenance. UI supports side-by-side disagreements and slicing by class/device/quality.

## Economic model

```text
ExpectedCostPerAcceptedDecision =
  (InferenceCost + CloudEscalationCost + HumanReviewCost
   + InfrastructureCost + EstimatedErrorLoss) / AcceptedCorrectDecisions
```

`EstimatedErrorLoss` requires a domain-specific loss matrix or is marked `not_estimated`. Show both measured cost (API/compute) and hypothetical business loss separately. Report `coverage` and `abstain_rate` alongside accuracy. An optimization that reduces tokens while multiplying false negatives fails the gate.

## Router decision

1. Require valid per-model calibration or empirical reliability for the target domain.
2. Apply user policy on critical class recall, false negative cost, max latency, privacy and offline-only constraints.
3. Decide local/probe first for eligible class/difficulty slices, then stronger vision model, then human review.
4. Record decision reason, route path and cost; enforce calls/budgets.
5. Periodically reevaluate routing on drifted data. Route rules change only after a new versioned policy is approved.

## UX artifacts

Pareto scatter: x = cost per 1k images, y = macro F1 with optional band; markers encode latency; linked per-sample diff viewer; critical-class regression table; a tab for "Where model B loses to A"; cost calculator with actual vs estimated badges; reviewer time assumption inputs. Never show false precision.

## Test cases

VLM self-reports 0.99 confidence but fails calibration; cached output produced by different preprocessing; cloud unavailable; public model license prohibited in commercial dataset; critical class absent in test; route exceeds $ cap; local model too large for MPS; ambiguous category. All must yield explicit, correct status rather than silent fallback.
