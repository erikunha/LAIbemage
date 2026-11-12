# Test pyramid, evaluation harness and quality gates

## Test layers

| Layer | What it proves | Gate |
|---|---|---|
| Type + lint | TS strict, Python typing/lint | PR fast gate |
| Unit/properties | hashes, codecs, splits, calibration, policies, money | PR fast gate |
| Contract | Zod ↔ Python JSON Schema ↔ OpenAPI ↔ npm client | PR blocking |
| Store | SQLite migrations, idempotency, CAS, lineage, crash | PR blocking |
| Worker integration | JSONL handshake/progress/error/cancel, timeout, binary references | PR blocking |
| CLI parity | legacy flags and new operation envelope | PR blocking |
| Studio E2E | guided import/review/arena, accessibility | UI PR blocking |
| Scientific benchmark | real licensed held-out samples, seeds, calibration, slice regressions | model promotion gate |
| Hardware | CPU every PR; MPS actual Mac; CUDA optional | scheduled/feature gate |
| Security/adversarial | malicious files, prompt injection, path traversal, tool privilege | PR security gate |
| Packaging | wheel+sdist, npm ESM typings/browser imports, clean consumer installs | release gate |

## Reconciliation gate first

Before adding Python package, execute existing pnpm tests, contracts snapshot test, store migration tests, benchmark run in an environment where it does not incur paid calls. Capture baseline results and failing tests. Avoid citing older counts as freshly executed.

## Deterministic examples

- Same source hash + config -> same artifact manifest where deterministic; compare only stable fields when hardware/run time varies.
- Dataset split impossible due to missing groups -> explicit `INVALID_SPLIT`/`INCONCLUSIVE`, no fabricated validation.
- Prediction with calibrated probability but no calibration artifact -> validation rejects.
- Model returns unsupported class -> exception/abstain with provenance; no coercion into a valid class silently.
- Duplicate job submission with same idempotency key -> same job/result reference, no second provider charge.
- A failed worker emits error event and never produces a successful model promotion.
- GitHub/npm/python package smoke tests verify new packages without editing global Python/Node installs.

## CI outline

PR fast: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm check:boundaries`, `uv run ... pytest`, generated-contract drift check, package build. Nightly: license-aware dataset availability, real benchmark where data pre-staged, MPS if self-hosted runner, security checks. Paid VLM CI only with budgeted explicit opt-in and separate restricted token.

## Release criteria

All critical features have test traceability: requirement ID -> spec -> test -> artifact -> measured result. Documentation changed in same PR. No "TODO" in approved API contract, release model card or error handling path. Explicitly list unverified hardware/platforms rather than assuming support.
