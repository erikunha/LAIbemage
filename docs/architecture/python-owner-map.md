# Python owner map

What moves to Python, what stays in TypeScript, and the exact import directions between the two.
The tracked decision is `docs/adr/011-python-first-ml-runtime.md`; this map is the working
reference it points at. It describes the tree as it ships today (the as-built state), and every
current-state claim carries a `path:line`. Design rows name their pack source under `docs/vnext/`.

The static proof of the rules in this map is `pnpm run check:owner-boundaries`
(`scripts/check-owner-boundaries.mjs`), proven by `packages/core/tests/owner-boundaries.test.ts`.

## Concern ownership

| Concern | Owner | Direction | Where it lives today | Source |
|---|---|---|---|---|
| External domain entity schemas | `@vision-lens/contracts` (Zod) | TypeScript owns, Python adapts | `packages/contracts/src/entities/index.ts:11` | `docs/vnext/02-ARCHITECTURE-DECISION.md:7` |
| Reserved entity names (`track`, `frame`, `calibration`, `synchronized-sequence`) | `@vision-lens/contracts` | TypeScript owns | `packages/contracts/src/entities/reserved.ts:15` | `docs/vnext/02-ARCHITECTURE-DECISION.md:7` |
| Worker protocol vocabulary (protocol id, five operations, ten error codes, retryable flags) | one frozen vocabulary, two mirrored definitions | shared surface, kept identical by the static check | `packages/contracts/src/worker/protocol.ts:19`, `python/visionlens/src/visionlens/protocol.py:18`, `python/visionlens/src/visionlens/errors.py:39` | `docs/vnext/02-ARCHITECTURE-DECISION.md:8` |
| Worker host (spawn, framing, handshake, cancel, deadline) | `packages/core/src/worker/` | stays in TypeScript | `packages/core/src/worker/client.ts:1` | `docs/vnext/05-PYTHON-CORE-AND-PYPI.md:26` (the `bridge` role, host side) |
| Worker process (frames on stdout, logs on stderr) | `visionlens` | Python | `python/visionlens/src/visionlens/worker.py:182` | `docs/vnext/05-PYTHON-CORE-AND-PYPI.md:26` |
| Encoder and preprocessing fingerprint | `visionlens` | Python | `python/visionlens/src/visionlens/encoder.py:56`, `:82` | `docs/vnext/05-PYTHON-CORE-AND-PYPI.md:17`, `:19` (simulated as-built) |
| Model registry (the simulated runtime's placeholder list) | `visionlens` | Python | `python/visionlens/src/visionlens/registry/simulated.py:109` | `docs/vnext/11-VISION-MODEL-REGISTRY-INFERENCE.md:5` (the record shape), `docs/architecture/model-registry.md` (the two registries) |
| Model capability registry (the pinned records of the models the platform may run) | one record set, two readers | the data is shared and the refusals are the same, measured by `scripts/registry/parity-check.ts` | `datasets/registry.json` (the records), `packages/core/src/benchmark/registry.ts:410` (the TypeScript accessor), `python/visionlens/src/visionlens/registry/loader.py:334` (the Python loader) | `docs/vnext/11-VISION-MODEL-REGISTRY-INFERENCE.md:5`, `docs/architecture/model-registry.md` |
| Model weights (the fetch, the gates and the local cache) | `visionlens` | Python | `python/visionlens/src/visionlens/encoders/weights.py:643` (the loader), `:205` (the license gate), `python/visionlens/src/visionlens/hashing.py:22` (the one way to digest) | `docs/vnext/19-SECURITY-PRIVACY-SUPPLY-CHAIN.md:10`, `:15`, `docs/architecture/model-registry.md` (the loader) |
| Operation handlers (embed, predict, audit, eval, train) | `visionlens` | Python | `python/visionlens/src/visionlens/operations.py:278` | `docs/vnext/05-PYTHON-CORE-AND-PYPI.md:21-23` |
| Golden worker transcript | `visionlens` | Python | `python/visionlens/src/visionlens/golden/__init__.py:1` | `docs/vnext/adrs/ADR-011-python-first-ml-runtime.md:18` (golden path) |
| Store, lineage, migrations | `packages/core/src/store/` | stays in TypeScript, sole domain writer | `packages/core/src/store/db.ts:1`, `lineage.ts`, `migrations/` | `docs/vnext/08-DOMAIN-STORE-AND-PROVENANCE.md:46` |
| LLM Vision providers | `packages/core/src/analyzer/providers/` | stays in TypeScript until contract parity and profiling justify moving it | `AGENTS.md:85` | `docs/vnext/02-ARCHITECTURE-DECISION.md:9` |
| Image preprocessing pipeline (Sharp) | `packages/core/src/processor/` | stays in TypeScript until parity and profiling justify moving it | `AGENTS.md:89` | `docs/vnext/02-ARCHITECTURE-DECISION.md:9` |
| Node CLI bins | `packages/cli/` | stays in TypeScript, `vision-lens` canonical | `packages/cli/package.json:10-11` | `docs/vnext/02-ARCHITECTURE-DECISION.md:30` |
| npm SDK | `packages/sdk/` | stays in TypeScript | `packages/sdk/package.json:7-9` | `docs/vnext/02-ARCHITECTURE-DECISION.md:31` |
| Application API and Studio apps | `apps/` | stays in TypeScript | `docs/architecture/monorepo-map.md` (layout) | `docs/vnext/04-ARCHITECTURE-C4.md:12` |
| Python services (`vision`, `training`, `agents`) | `services/` | thin adapters, stdlib-only skeletons | `services/vision/src/vision_lens_vision/__init__.py:3` | `docs/vnext/02-ARCHITECTURE-DECISION.md:33`, `docs/vnext/05-PYTHON-CORE-AND-PYPI.md:5` |
| Worker runtime container | `docker/runtime/` | Python only, no Node | vendored wheel copy, guarded by `pnpm run docker:vendor:check` (`scripts/check-docker-vendor.mjs:1`) | `docs/architecture/monorepo-map.md` (layout) |
| Python packaging | `python/visionlens/` | one distribution, extras frozen, the base install carries Pydantic and the extra sets stay empty | `python/visionlens/pyproject.toml:6`, `:16`, `:21-25` | `docs/vnext/05-PYTHON-CORE-AND-PYPI.md:34-35` |

## Import boundary table

The enforced rules. `check:owner-boundaries` encodes the first five; each is observable in the
tree today and each is proven to fire by a planted violating fixture.

| Rule | Direction | Statement | Observable today | Enforcement |
|---|---|---|---|---|
| `PY-NO-TS` | `python/`, `services/` into any TypeScript package | forbidden: no `@scope/name` specifier, no `node:` builtin, no module path rooted at `packages` or `apps`, no relative import escaping its scanned root | every `.py` file imports only the standard library, its own package and the dependencies its distribution declares (`python/visionlens/src/visionlens/worker.py:14-22`, `python/visionlens/src/visionlens/config.py:16-20`) | `scripts/check-owner-boundaries.mjs` (rule `PY-NO-TS`); `AGENTS.md:105` |
| `HOST-NO-PYTHON` | `packages/core/src/worker/` into `python/` or `services/` | forbidden beyond the protocol: the host never imports, reads or names Python source; the launch seam is the environment | interpreter and script resolve from `VISION_LENS_WORKER_INTERPRETER` / `VISION_LENS_WORKER_SCRIPT`, never a hardcoded path (`packages/core/src/worker/client.ts:39-48`, `:130-131`) | `scripts/check-owner-boundaries.mjs` (rule `HOST-NO-PYTHON`) |
| `HOST-IMPORTS` | imports inside `packages/core/src/worker/` | allowed: Node stdlib, `@vision-lens/contracts`, files inside `worker/`, `packages/core/src/utils/`; everything else forbidden | the seven worker files (host.ts included) import only those (`packages/core/src/worker/client.ts:1-22`) | `scripts/check-owner-boundaries.mjs` (rule `HOST-IMPORTS`); `AGENTS.md:97`; eslint scoped rule |
| `PROTOCOL-PARITY` | `protocol.ts` against `protocol.py` + `errors.py` | the frozen vocabulary must be identical on both sides: protocol id, major, version, the five operation codes, the ten error codes, every retryable flag | `WORKER_PROTOCOL_ID` `packages/contracts/src/worker/protocol.ts:19` equals `PROTOCOL` `python/visionlens/src/visionlens/protocol.py:18`; operations `protocol.ts:64` equal `protocol.py:30`; codes and flags `protocol.ts:84-118` equal `errors.py:39-51`, `:54-65` | `scripts/check-owner-boundaries.mjs` (rule `PROTOCOL-PARITY`) |
| `CONTRACT-VERSION` | Python `CONTRACT_VERSION` against `CONTRACTS_VERSION` | the contract version the worker stamps on frames must equal the contracts package version | `1.0.0` on both sides (`python/visionlens/src/visionlens/protocol.py:20`, `packages/contracts/src/version.ts:9`) | `scripts/check-owner-boundaries.mjs` (rule `CONTRACT-VERSION`) |
| contracts purity | anything into `packages/contracts/src/` | zod only, no import from core, cli, sdk, apps | `AGENTS.md:103` | eslint import rules (pre-existing) |

## Inverse dependencies

What must never happen, stated from the Python side:

- Python never owns the TypeScript SQLite store schema and never independently mutates the domain
  tables: the store stays the sole domain writer and Python emits versioned artifacts for
  TypeScript to validate and commit (`docs/vnext/04-ARCHITECTURE-C4.md:18`,
  `docs/vnext/08-DOMAIN-STORE-AND-PROVENANCE.md:46`). Observable today: no Python file imports or
  opens `sqlite3`; the worker's only outputs are protocol frames
  (`python/visionlens/src/visionlens/worker.py:1-9`).
- TypeScript never reimplements ML numerical code (`docs/vnext/04-ARCHITECTURE-C4.md:13`): the
  encoder, its preprocessing fingerprint and the model registry exist only in Python
  (`python/visionlens/src/visionlens/encoder.py:56`, `registry/simulated.py:109`). The TypeScript Sharp
  pipeline is image preparation, not ML, and stays until parity and profiling justify moving it
  (`docs/vnext/02-ARCHITECTURE-DECISION.md:9`).
- Neither side invents a competing entity variant (`docs/vnext/07-CONTRACTS-PROTOCOL.md:5`):
  entities are Zod in `packages/contracts`; Python carries no entity schemas at all, only the
  worker vocabulary and the library's own typed records
  (`python/visionlens/src/visionlens/__init__.py:53-95`).
- A declared Python dependency is not a license to reach into TypeScript: `PY-NO-TS` holds for
  the declared-dependency future exactly as it holds for the present, where the base install
  declares Pydantic and nothing else (`AGENTS.md:105`,
  `docs/vnext/05-PYTHON-CORE-AND-PYPI.md:5`).

## Side-effect permission table

The frozen v1 operation catalog. Rows come from the proposed catalog
(`docs/vnext/07-CONTRACTS-PROTOCOL.md:32-41`); the three codes the proposal lists but v1 does
not accept (`dataset.inspect`, `annotation.propose`, `model.promote`) are named as deferred at
`packages/contracts/src/worker/protocol.ts:60-63` and must stay unaccepted in v1. Every request
carries a `budget` (`packages/contracts/src/worker/request.ts`), binary images travel as validated
asset references, never base64 in line JSON (`docs/vnext/02-ARCHITECTURE-DECISION.md:8`,
`packages/contracts/src/worker/request.ts:31`).

| Operation | Side effects | Inputs | Result | Tier |
|---|---|---|---|---|
| `vision.embed` | derived artifacts | snapshotId, encoder | embeddingRunId | bounded compute |
| `vision.predict` | predictions | snapshotId, modelId | predictionRunId | bounded compute |
| `dataset.audit` | report artifact | snapshotId, rules | auditReportId | analyze |
| `eval.run` | metrics and report | immutable eval split, modelId | evaluationRunId | bounded compute |
| `model.train` | checkpoints | dataset splits, recipe, budget | experimentRunId | approval |

Cross-language rules: stable operation codes, error codes and emitted metrics; English model
text never decides program control (`docs/vnext/02-ARCHITECTURE-DECISION.md:35`).

## Versioning

- Contracts are versioned at `packages/contracts/src/version.ts:9` (`1.0.0`); a breaking change
  requires a major bump, decided by `checkVersionBump` (`packages/contracts/src/version-guard.ts:215`).
- The protocol version is independent and mirrored: `1.0.0` on both sides
  (`packages/contracts/src/worker/protocol.ts:25`, `python/visionlens/src/visionlens/protocol.py:19`).
- The protocol major lives inside the id string `visionlens.worker.v1`: a major change is a
  different protocol id and a handshake refusal, not a version bump
  (`packages/contracts/src/worker/protocol.ts:13-19`).
- The contract version each frame stamps equals `CONTRACTS_VERSION`
  (`python/visionlens/src/visionlens/protocol.py:20`, enforced as `CONTRACT-VERSION` above).
