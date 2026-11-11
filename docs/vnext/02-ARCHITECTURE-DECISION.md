# Architecture decision — Python-first for ML, TypeScript-first for platform

## Decision statement

- **Python package `visionlens`** owns in-process image/embedding/training/inference/evaluation capabilities, model adapters, numerical processing and training recipes. Built on PyTorch/scikit-learn/Transformers as optional extras. Its API must work from a Python process *without* Node, Fastify or the npm SDK.
- **TypeScript** keeps frontend, Node CLI, lightweight npm SDK, application API/job orchestration, integrations, local metadata store and current legacy image workflow while migration proceeds.
- **`@vision-lens/contracts` remains canonical** for existing external domain entities, public operation payloads and OpenAPI. Generate Python validators/adapters from versioned JSON Schema; do not invent competing entity variants. Python-specific tensor/recipe types can live in Python with exported schemas when crossing the runtime boundary.
- **Bridge:** long-lived Python worker via versioned JSONL for local app, batch operations and CLI; authenticated API adapter for remote workers when necessary. Transfer binary images via validated asset references or bounded uploads, not base64 megabytes in line-oriented JSON.
- **No big-bang port:** current TypeScript providers and Sharp pipeline remain until contract parity and profiling support moving them. Python-first means ML research/production code ownership, not indiscriminate rewriting.

## Why not all-Python?

A web frontend and npm SDK serve different consumers. Porting the tested Node CLI/provider ecosystem to Python at once would add risk and remove an existing adoption channel without improving ML capability. Likewise, maintaining independent ML algorithms in TS and Python would produce behavioral drift.

## End state

```text
Web Studio (Next.js) --HTTP--+    Python SDK (in-process) --+
Node CLI (vision-lens) ------+                                 
TS npm SDK (@vision-lens/sdk)-+--> App/API & Job orchestration -> VisionLens Python runtime
MCP (TS tools) --------------+                |                  (embeddings, train,
                                             |                   inference, evaluations)
                                TS domain + store (Zod) -------+
                                        |                      |
                                   SQLite + CAS         MLflow / ML artifacts
```

## Compatibility rules

1. `vision-lens` bin remains canonical; `ai-image-labeling` compatibility alias maintained during transition with a sunset policy.
2. `@vision-lens/sdk` is already a *fat local facade*. Do not silently replace exports with HTTP-only client: add a new entrypoint (`@vision-lens/sdk/client`) or major version, keep `@vision-lens/sdk/legacy` where required.
3. Python PyPI package proposal `visionlens` / import `visionlens` (registry availability pending) is **one distribution**, extras `[vision]`, `[training]`, `[agents]`, `[server]`, `[all]` only when package dependencies are truly compatible.
4. Existing three Python service skeletons stay as adapters initially; they may import the public Python package. No forced directory moves in R0.
5. All persisted snapshots and contracts are versioned. Incompatible changes require explicit migration, old fixture support and a version gate.
6. Cross-language operations use stable `operation` codes, error codes and emitted metrics; never parse English model text to decide program control.

**Acceptance of the architecture change:** dual-runtime parity tests pass for one golden inference path, old Node CLI suite stays green, Python works standalone and can be packaged into a wheel, and `@vision-lens/sdk/client` can call the application API without Python installed in the JS consumer environment.
