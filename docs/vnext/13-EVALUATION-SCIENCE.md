# Evaluation science and benchmark governance

## Current observed baseline

On `feat/visual-lens`, a real `gpt-4o` run over 700 VisA images reports macro-F1 ≈ 0.9795 and balanced accuracy ≈ 0.9700. **Do not describe it as held-out accuracy**: upstream release lacked capture-group IDs and the generated split placed all 700 in `train`. This remains an artifact integrity/regression reference, not a validated estimate of generalization.

## Mandatory evaluation design (F1 gate)

1. Lock dataset source digest, license, selected sample hashes, ontology version and capture/group strategy.
2. Create nonempty train/validation/test split with independent groups where possible; near-duplicate collision tests run across partitions. Record label coverage; for rare classes report insufficient support.
3. Use training and validation only to fit and select models; **test cannot be used to calibrate a threshold or choose a checkpoint**.
4. Compare candidates on exactly same sample IDs, preprocessing rules (where meaningful) and fixed task schema; missing model outputs count as failures.
5. Record cost with provider/model/token rates as-of date; actual billing separated from estimates. Record p50/p95 latency including model loading separately.
6. Store model-version hash, hardware, Python/TS versions, seeds, prompt template, config fingerprint, split hash and code commit with results.
7. Run at least two seeds or repeats for stochastic models, report confidence intervals or variability; label small samples as exploratory.

## Task metrics

| Task | Metrics | Required caveat |
|---|---|---|
| Classification | macro F1, balanced acc., class precision/recall, confusion, abstention coverage | imbalance and rare classes |
| Anomaly detection | image AUROC/AUPRC, region IoU/PRO where applicable | mask quality + imbalance |
| Detection | mAP@[.5:.95], recall, FP per image | IoU thresholds and annotation quality |
| Segmentation | per-class Dice/IoU | empty/ambiguous masks |
| Retrieval | Recall@k, mAP/nDCG | query relevance judgment |
| Calibration | ECE, Brier, reliability diagram | calibration partition separate from test |
| Active learning | improvement per annotated sample/minute | compare vs random selection |
| Agents | task success, trajectory/tool correctness, evidence accuracy, false-action rate | cannot replace rule checks |
| Cost | $/correct image, labor minutes, p95, failure cost | recorded currency/date/rate |

## Three strata of tests

**Unit:** synthetic swatches, mocks, tiny fixtures validate plumbing. **Integrated real-data:** VisA selected real examples with pinned license and hash validate model output shape and reproducibility. **Scientific holdout:** independent locked test subset validates claims. Do not promote unit-fixture metrics to real-world quality.

## Evaluation anti-patterns to ban

No result without count/split/version; no post-hoc test selection; no test-set active learning; no silent filtering of hard cases; no per-class metric inferred from aggregate score; no claims of cost savings from list-price estimates alone; no swapping provider prompts in an uncontrolled comparison; no claims of calibration from verbal model confidence.

## Required scorecard

Include model names/revisions, dataset and license, N train/N val/N test, split method, per-class table, confusion, calibration, key failure slices, time, API tokens/cost where used, model size, reproducibility tuple, limitations and screenshot-friendly artifact. Regression gates must compare the same metric in the same regime and not silently compare synthetic to real datasets.
