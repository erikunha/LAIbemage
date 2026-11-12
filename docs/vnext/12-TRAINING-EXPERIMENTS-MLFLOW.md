# Training, experimentation and model governance

## Training maturity ladder

1. **M0 baseline:** frozen encoder embeddings -> scikit-learn logistic regression; deterministic split and seed; class weights documented.
2. **M1 linear head:** train only classifier head on frozen PyTorch backbone; test calibration and inference export.
3. **M2 fine-tune:** selectively unfreeze layers, optimizers/schedulers, early stopping, augmentations; checkpoint/resume.
4. **M3 task-specific:** anomaly detection, detection/segmentation adapters when labels exist; task-specific metrics.
5. **M4 efficient deployment:** quantization/distillation/ONNX where supported; re-evaluate accuracy, calibration and latency on representative device.

Do **not** train full foundation models or attempt distributed GPUs to demonstrate ML engineering. Demonstrating correct experimental control, leakage prevention and deployment quality is higher-value than a large training job.

## Recipe contract

A recipe must include dataset snapshot fingerprint and partition IDs, ontology version, exact model checkpoint hash, preprocessing fingerprint, optimizer+hyperparameters, seeds, device policy, augmentation pipeline, max epochs, early stopping criterion, checkpoint interval, resources and budget. A single config file is stored alongside the resolved environment and result. Hyperparameter search may use Optuna with bounded trial count; no test-set optimization.

## MLflow

Log resolved params, dataset lineage, code/git commit, train/val curves, confusion matrix, calibration, model file hash, data card and model card; local file backend first. MLflow is experiment system of record for ML artifacts, but the domain store maintains the canonical pointers and promotion approvals. Model promotions require a gate evaluation against locked test data and an explicit reviewer decision. No automatically approved `best_model` after seeing test performance multiple times.

## Experiment discipline

- Fix seeds but do not claim exact reproducibility across all GPU kernels; report tolerance and environment.
- Keep validation for model selection and calibration. Test partition is used for final evidence after selection.
- Check that a metric improvement is robust to repeated seeds, confidence intervals and per-class regression.
- Track training energy or GPU time where feasible; compare total expected cost not only API tokens.
- Treat missing/failed predictions as errors in metrics, not as deleted samples that improve scores.

## Model card minimum

Description, intended tasks, data source/license, train/val/test splits and hashes, critical failure modes, subgroup/slice metrics, calibration, latency hardware, dependencies, security provenance, reviewers, approved use, limitations and rollback target.

## Model promotion gate example

Reject if holdout missing, identity leakage found, critical-class recall below floor, ECE above maximum, cost savings require violating quality, model license disallows distribution, or artifact hash mismatches. Favor explicit `inconclusive` when statistical support is insufficient.
