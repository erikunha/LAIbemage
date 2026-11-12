# Vision models, local/hosted routing, device and inference contracts

## Model capability registry

Each record: `modelId`, `revision`, source URI+digest, license/usage restrictions, required extras, tasks, preprocessing fingerprint, device support (`cpu`, `mps`, `cuda`), input image size, tokenizer/feature extractor, output shape, latency/cost profile, calibration status and trust policy. `latest` never used in saved evaluation runs.

## Candidate families (adapters, not permanent pins)

- Image-text retrieval / zero-shot: CLIP, SigLIP2, OpenCLIP families.
- Visual feature extraction: DINOv2/DINOv3 or alternatives after checking local weights and license.
- Classification: frozen encoder + logistic regression/linear probe, ResNet/ViT transfer learning.
- Detection: YOLO/RT-DETR behind a common geometry contract; commercial use license must be verified.
- Segmentation: SAM family with optional GPU worker; MPS/CPU capability determined experimentally.
- OCR/document layouts: PaddleOCR family when document-intelligence module is activated.
- General VLM: existing OpenAI/Anthropic/Google/Ollama adapters retained until validated migration; structured outputs versioned and provider failures isolated.

## Inference shape

`PredictRequest` binds dataset snapshot + model version + preprocessing + taxonomy + seed + budgets + slice; `PredictResult` is append-only per sample, with `label`, optional geometry, raw score, calibrated probability optional, cost, latency and artifact references. No uncited per-image model claim of certainty. Pixel-level predictions must use consistent coordinate convention (image orientation, normalized vs absolute, shape/version).

## Processing pipeline

`asset reference -> image decode/orientation -> canonical preprocessing -> batch admission -> model inference -> postprocess -> calibration -> schema validation -> persist predictions -> trace`. Every step has a fingerprint; two runs with different preprocessing cannot be compared as equivalent without notation.

## Cascade selection

Local cheapest model first when predicted reliability meets calibrated criterion; escalate uncertain outliers to stronger specialized model, then VLM, then human review. Implement as **policy** with target critical-class recall floor, latency budget and expected unit cost. Route based on held-out calibrated reliability and runtime constraints, not VLM self-reported confidence. Log route decisions for offline evaluation and drift analysis.

## Core safety

Untrusted model artifacts may execute Python pickles or custom code. Prefer safetensors and allowlisted sources/revisions; no auto-loading arbitrary `.pt` from untrusted upload. Disable network in isolated inference worker unless provider access explicitly required. Image text/OCR is data, never agent instruction.

## Hardware matrix

CPU always tested; MPS tested on eligible macOS with recorded PyTorch version and operator limits; CUDA optional separate runner. Benchmark different hardware separately. Report throughput, p50/p95 per image, cold/warm start and peak RSS/VRAM. `device='auto'` emits chosen device and fallback reason.
