# ADR 011 - Python-first ML runtime, TypeScript-first application

| Field    | Value                                  |
| -------- | -------------------------------------- |
| Status   | Accepted                               |
| Date     | 2026-11-12                             |
| Deciders | @erikunha (decision delegated to the delivery loop and recorded 2026-11-12) |

## Context

ADR-006 (2026-11-10) put the ML side of Vision Lens into three Python services behind a
JSON-lines worker protocol. The vnext design pack then proposed a different shape: one public
Python distribution owning the ML runtime, with TypeScript keeping the application and the
domain (`docs/vnext/02-ARCHITECTURE-DECISION.md:5-9`). The runtime landed code-first: the
`visionlens` package shipped (spec 017), the frozen `visionlens.worker.v1` protocol shipped on
both languages (spec 018), and the cross-language integration suite went green, all before any
tracked decision document existed. Spec 016 audited that divergence on 2026-11-12 and the
maintainer chose to implement the spec against the tree that now exists: this ADR is the missing
decision record, written as built.

The number 011 is the slot the pack reserved for this decision; it is free because the
agent-surface decision took 019 (`docs/adr/019-provider-agnostic-agent-surface.md:65-66`,
`docs/migration/vision-lens-vnext-reconciliation.md:221`).

## Decision

**Python owns the ML runtime. TypeScript owns the application and the domain. The frozen JSONL
worker protocol is the only runtime boundary between them.**

1. The Python side is one public distribution, `visionlens` at `python/visionlens/`
   (`python/visionlens/pyproject.toml:6`). It owns the encoder, the preprocessing fingerprint,
   the model registry, the operation handlers and the worker process
   (`python/visionlens/src/visionlens/encoder.py:56`, `registry/simulated.py:109`, `operations.py:278`,
   `worker.py:183`). Its API works from a Python process without Node, Fastify or the npm SDK
   (`docs/vnext/02-ARCHITECTURE-DECISION.md:5`). As built the runtime is deterministic and
   carries two direct third-party dependencies, Pydantic and Pillow, with the four transitive
   packages Pydantic brings; the typed facade needs Pydantic and the image decoder needs Pillow
   (`dependencies = ["pydantic>=2.12,<3", "pillow>=13,<14"]`, `python/visionlens/pyproject.toml:18`;
   the amendments below record both decisions and their dates); the PyTorch, scikit-learn and
   Transformers stacks remain optional extras, and only the `vision` extra carries one today
   (`python/visionlens/pyproject.toml:30-38`).
2. TypeScript keeps the frontend apps, the Node CLI, the npm SDK, the application API and job
   orchestration, the integrations, the local metadata store and the current legacy image
   workflow (`docs/vnext/02-ARCHITECTURE-DECISION.md:6`): `apps/`, `packages/cli/`,
   `packages/sdk/`, `packages/core/src/store/`, `packages/core/src/analyzer/providers/` and
   `packages/core/src/processor/` all stay, with the provider and Sharp pipelines explicitly not
   ported until contract parity and profiling justify it (`docs/vnext/02-ARCHITECTURE-DECISION.md:9`).
3. The boundary is the long-lived JSONL worker speaking `visionlens.worker.v1`: the TypeScript
   host in `packages/core/src/worker/client.ts` spawns a Python process, writes hello, request
   and cancel frames to its stdin and reads progress, result and error frames from its stdout
   (`packages/core/src/worker/client.ts:1-22`). The interpreter and worker script come from the
   environment, never from a hardcoded path (`packages/core/src/worker/client.ts:36-45`). Binary
   images travel as validated asset references, never base64 inside line JSON
   (`docs/vnext/02-ARCHITECTURE-DECISION.md:8`).
4. `@vision-lens/contracts` stays canonical for external domain entities, public operation
   payloads and OpenAPI (`docs/vnext/02-ARCHITECTURE-DECISION.md:7`). Python carries no entity
   schemas: its only shared vocabulary is the frozen worker protocol
   (`python/visionlens/src/visionlens/__init__.py:60-102`). When Python later needs entity
   validation, the validators are generated from versioned JSON Schema, never hand-copied
   (`docs/vnext/07-CONTRACTS-PROTOCOL.md:5`).
5. Versioning: contracts are `1.0.0` with a breaking change requiring a major bump, decided by
   `checkVersionBump` (`packages/contracts/src/version.ts:9`,
   `packages/contracts/src/version-guard.ts:215`). The protocol version is independent and
   mirrored at `1.0.0` on both sides (`packages/contracts/src/worker/protocol.ts:25`,
   `python/visionlens/src/visionlens/protocol.py:19`), and the protocol major lives inside the
   id string, so a major change is a handshake refusal, not a version bump
   (`packages/contracts/src/worker/protocol.ts:13-19`).

The per-concern owner table, the import directions and the side-effect permissions live in the
tracked owner map, `docs/architecture/python-owner-map.md`.

## Amendment 2026-11-14: the base install carries Pydantic, and the lock decision is taken

**Deciders**: @erikunha (the maintainer directed closing the open typed facade of the public
distribution on 2026-11-14; the call was delegated to the delivery loop and recorded here).

This ADR was accepted as built on 2026-11-12, when the Python runtime carried no third-party
package at all. The typed facade the pack asks the distribution to ship
(`docs/vnext/specs/VLN-003-python-public-wheel.md:14`, `:17`) needs a versioned Pydantic model
for its configuration (`python/visionlens/src/visionlens/config.py:1`), and the pack puts
Pydantic in the base install (`docs/vnext/05-PYTHON-CORE-AND-PYPI.md:34`). The two
statements could not both stand, so the packaging section of this ADR is amended, in the same
change that ships the facade.

**What changes.** The base install is no longer standard-library only. It carries Pydantic,
with the four transitive packages Pydantic brings, and nothing else:
`dependencies = ["pydantic>=2.12,<3"]` (`python/visionlens/pyproject.toml:18`).
The runtime keeps every other property the acceptance recorded: the heavy stacks (PyTorch,
scikit-learn, Transformers, MLflow, LangGraph, FastAPI, Uvicorn) stay out of the base install,
the extra names and their (empty) sets are unchanged
(`python/visionlens/pyproject.toml:30-38`), the import isolation contract still holds, and no
GPU or ML framework enters a consumer install.

**Why Pydantic and not an extras-gated config.** The facade's configuration is a typed,
versioned record that round-trips through plain JSON. Gating it behind an extra would put the
public configuration behind a capability extra, which is the opposite of the intent: the base
install must be usable on its own. The alternative to the typed config, a hand-written
dataclass with its own validation, would duplicate a dependency the ecosystem already
maintains, and the pack's own dependency policy names Pydantic for exactly this role.

**The lock decision, taken.** The acceptance left one workspace lock as a later decision
"when the dependency sets stop being empty". They are no longer empty, so the decision is
taken here: **one lock per publishable distribution**. The distribution keeps
`python/visionlens/uv.lock`, exact pins for its own base requirement and its development
group, with the `exclude-newer` cutoff that makes the resolution reproducible. The three
service skeletons keep their per-service locks and their empty dependency sets. A shared
workspace lock lands when a second publishable distribution exists or when two packages must
resolve a shared version of the same dependency; until then a workspace lock would couple
packages that share nothing.

**What this amendment does not change.** The wire protocol, the ownership boundary, the
entity rules, the compatibility rules and the hardware, security and test obligations stand
as accepted. The library-level error codes the facade introduces
(`python/visionlens/src/visionlens/errors.py`) are not wire codes: the frozen worker
vocabulary stays exactly the ten codes it had, and the gate that proves it
(`python/visionlens/tests/test_protocol.py:29`) still passes.

**Evidence for this amendment** (macOS 26.6.2, Darwin 25.6.0, arm64, Python 3.15.0,
uv 0.11.21, repository HEAD `2b38011` plus this change's files): the release gate run of
2026-11-14 passed 14 steps with 0 failed and 0 not run, and its output artifact is the gate's
local evidence file `python/visionlens/release/gate/run-20261114T105117Z.json`, which the
repository keeps out of git, quoted in the change report of the pull request that carries this
amendment, together with the package tests and the mypy gate; the re-dated license audit
(`python/visionlens/release/license-audit.md`) records the license of every package the base
install now carries.

## Amendment 2026-11-14: the base install carries the image decoder too

**Deciders**: @erikunha (the maintainer directed shipping the CPU vision adapter on 2026-11-14;
the call was delegated to the delivery loop and recorded here).

The amendment of 2026-11-14 put Pydantic in the base install and said the base carries
"nothing else". That was true while the whole runtime was simulated and nothing decoded an
image. The CPU vision adapter of VLN-005 decodes one, and the decoder is a core operation of
the distribution, not a capability extra: a caller that installs `visionlens` and asks for an
embedding must get an image decoder in return.

**What changes.** The base install carries Pillow next to Pydantic:
`dependencies = ["pydantic>=2.12,<3", "pillow>=13,<14"]`
(`python/visionlens/pyproject.toml:18`). The `vision` extra keeps the heavy stack and only
the heavy stack: torch, transformers and safetensors
(`python/visionlens/pyproject.toml:30-34`).

**Why the pack allows it.** The dependency policy names what the base install should include:
"Pydantic, limited I/O and lightweight NumPy only if core operations truly need it", and
forbids "no mandatory GPU/PyTorch/Transformers/MLflow download"
(`docs/vnext/05-PYTHON-CORE-AND-PYPI.md:34`). Pillow is the limited I/O of the image decoder,
and no GPU, PyTorch, Transformers or MLflow download enters a consumer install.

**Why Pillow and not a hand-written decoder.** The decoder refuses a truncated file, a pixel
bomb and a file whose magic bytes contradict its extension, BEFORE the pixel buffer is
allocated (`docs/vnext/19-SECURITY-PRIVACY-SUPPLY-CHAIN.md:23`). That is a job for a
battle-tested decoder, and a second decoder written here would be a second thing to keep
correct. The heavy ML stack stays behind the extra, where it belongs.

**What this amendment does not change.** The wire protocol, the ownership boundary, the
entity rules, the compatibility rules and the hardware, security and test obligations stand
as accepted. The frozen worker vocabulary stays exactly the ten codes it had, and the gate
that proves it (`python/visionlens/tests/test_protocol.py:29`) still passes. The base install
still installs no GPU or ML framework, and the metadata test that proves it
(`python/visionlens/tests/test_build_metadata.py:16`) names the two packages the base carries.

## Amendment 2026-11-14: the device planner admits the CPU only

**Deciders**: @erikunha (the maintainer directed shipping the CPU vision adapter on 2026-11-14;
the call was delegated to the delivery loop and recorded here).

The CPU vision adapter of VLN-005 asks the machine where a run happens. The pack asks the
`DevicePlanner` to check MPS availability, available memory and operator compatibility, and
to accept a CPU fallback with a status
(`docs/vnext/05-PYTHON-CORE-AND-PYPI.md:61`), and it asks the CPU to be the reference path
(`docs/vnext/adrs/ADR-017-local-first-hardware.md:9`). The adapter of this ticket runs on the
CPU, so the planner has to answer for a machine that has an accelerator and for one that has
not, and the answer must be the same in the capability report and in the run.

**What changes.** There is one device vocabulary and one resolver, in
`python/visionlens/src/visionlens/runtime/device.py`:

- `KNOWN_DEVICES` is every device the platform knows by name (`cpu`, `mps`, `cuda`), the
  device support a registry record carries
  (`docs/vnext/11-VISION-MODEL-REGISTRY-INFERENCE.md:35`);
- `ADMITTED_DEVICES` is the devices a run may use, in the order `auto` prefers them, and it
  holds the CPU only;
- `REQUESTABLE_DEVICES` is what a request may name (`auto` plus the admitted devices), and
  the configuration reads it instead of carrying a second list
  (`python/visionlens/src/visionlens/config.py:34`);
- the capability report asks the planner and reads its answer, instead of resolving the
  device on its own (`python/visionlens/src/visionlens/capabilities.py:87`).

`auto` resolves to an admitted device and records why it fell back. The reason names the
accelerators the platform knows and what the machine has of them, so a run on a Mac with MPS
says that the machine provides MPS and that this build does not admit it. An explicit
accelerator is refused with its reason: a request for a device this build does not run fails
instead of running somewhere else.

**What is deferred, and why.** The memory admission and the operator compatibility check the
pack names for MPS are NOT implemented
(`docs/vnext/05-PYTHON-CORE-AND-PYPI.md:61`). Admitting MPS without them would claim a
capability the platform does not have, so MPS is not admitted, and the pack's own rule
applies: an unsupported device falls back or fails with a reason, never silently
(`docs/vnext/05-PYTHON-CORE-AND-PYPI.md:56`). The admission is a one-line change: when the
memory admission and the operator check land, `ADMITTED_DEVICES` grows, `auto` prefers the
accelerator, and the refusal disappears with it. The device names in the registry record are
the vocabulary of the models, not a claim that this build runs them.

**What this amendment does not change.** The wire protocol, the ownership boundary, the
entity rules, the compatibility rules and the security and test obligations stand as
accepted. The frozen worker vocabulary stays exactly the ten codes it had, and the gate that
proves it (`python/visionlens/tests/test_protocol.py:29`) still passes. The CPU remains the
reference path, and the recorded run of the adapter is a CPU run
(`docs/architecture/vision-adapter.md`).

## As built today

| Side | Ships | Evidence |
|---|---|---|
| Python | the `visionlens` wheel source: simulated encoder, model registry, five operation handlers, the JSONL worker, the golden transcript and the typed facade; the base install carries Pydantic and Pillow, Python `>=3.11` | `python/visionlens/pyproject.toml:10-38`, `python/visionlens/src/visionlens/golden/__init__.py:1` |
| Python | three service skeletons as thin adapters (`SERVICE_NAME` only, no dependencies) | `services/vision/src/vision_lens_vision/__init__.py:3`, `services/vision/pyproject.toml:6` |
| Python | the worker runtime container: the vendored wheel copy, no Node, byte-guarded | `docker/runtime/`, `scripts/check-docker-vendor.mjs:1` |
| TypeScript | the worker host: spawn, framing, handshake, cancel ladder, deadline, budget | `packages/core/src/worker/client.ts:1` |
| Shared | the frozen vocabulary, defined once per language and proven identical | `packages/contracts/src/worker/protocol.ts:19`, `python/visionlens/src/visionlens/protocol.py:18` |
| Cross-language | the real TypeScript host against the real Python worker over the wire | `packages/core/tests/worker/python-integration.test.ts:21-34` |

Not implemented, and not claimed: the heavy ML stacks behind the extras (the `vision` extra
now carries them, but no consumer install pulls them), the `@vision-lens/sdk/client`
entrypoint, and any PyPI or npm
publication. Those remain gated by the acceptance conditions below.

## Supersession record against ADR-006

ADR-006 stays byte-unchanged; this ADR supersedes part of it by addition
(`docs/vnext/00-ADOPTION-NO-OVERWRITE.md:36`).

| ADR-006 clause | Line | Disposition |
|---|---|---|
| Rule 1, contracts-first | `docs/adr/006-monorepo-ts-python.md:42` | Stays in force; it is the reason Python may not fork the domain |
| Rule 2, the TS-Python boundary is explicit and versioned, services invoked through the worker protocol | `docs/adr/006-monorepo-ts-python.md:46` | Replaced: one Python distribution may also run in-process from Python; the worker protocol is the cross-language transport, not the only execution shape |
| Rule 3, boundaries survive the move | `docs/adr/006-monorepo-ts-python.md:50` | Stays in force, extended with the Python side of the owner map |
| Rule 4, one environment per service, MPS-first with CPU fallback | `docs/adr/006-monorepo-ts-python.md:53` | Split: MPS-first with CPU fallback stays (ADR-007 owns it, `docs/adr/007-local-first-infra.md:28`); one-environment-per-service is replaced by one distribution with optional extras |
| Rule 5, the root stays thin | `docs/adr/006-monorepo-ts-python.md:55` | Stays in force |
| Container layout, `services/{vision,training,agents}` | `docs/adr/006-monorepo-ts-python.md:35-37` | Stays; the services become adapters over the public package (`docs/vnext/02-ARCHITECTURE-DECISION.md:33`) |

## Compatibility rules

| Surface | Rule | Today |
|---|---|---|
| CLI bins | `vision-lens` stays canonical, `ai-image-labeling` stays as an alias with a sunset policy (`docs/vnext/02-ARCHITECTURE-DECISION.md:30`) | both bins unchanged (`packages/cli/package.json:10-11`); no sunset date set yet |
| npm SDK | root exports are kept until a versioned migration; a lightweight client is a new entrypoint, never a silent replacement (`docs/vnext/02-ARCHITECTURE-DECISION.md:31`) | exports still `.` and `./cli` (`packages/sdk/package.json:7-9`); `./client` not yet added |
| Contracts | no breaking change without a major bump (`packages/contracts/src/version-guard.ts:215`) | `1.0.0` (`packages/contracts/src/version.ts:9`) |
| Store | forward-only migrations, SQLite store preserved, not replaced (`docs/vnext/08-DOMAIN-STORE-AND-PROVENANCE.md:5`) | `packages/core/src/store/migrations/` |
| Persisted snapshots and datasets | versioned; incompatible changes need explicit migration (`docs/vnext/02-ARCHITECTURE-DECISION.md:34`) | tracked manifests unchanged by this ADR |
| Cross-language operations | stable operation codes, error codes and emitted metrics; English model text never decides program control (`docs/vnext/02-ARCHITECTURE-DECISION.md:35`) | frozen on both sides (`packages/contracts/src/worker/protocol.ts:64-118`) |

## Packaging and dependency rules

- One publishable distribution under `python/visionlens/`, tentative PyPI name `visionlens`
  (registry availability unverified, see Open decisions); the three services stay thin runnable
  entrypoints, and no service directory is renamed (`docs/vnext/05-PYTHON-CORE-AND-PYPI.md:5`).
- Extras naming, resolved: the pack carried two lists, `[vision] [training] [agents] [server]
  [all]` (`docs/vnext/02-ARCHITECTURE-DECISION.md:32`) against `vision train agents server all`
  (`docs/vnext/05-PYTHON-CORE-AND-PYPI.md:35`). As built the distribution freezes the first set,
  full words matching the service names, and rejects the `train` spelling
  (`python/visionlens/pyproject.toml:30-38`).
- Python minimum 3.11, justified by the service skeletons that already declare `>=3.11`
  (`python/visionlens/pyproject.toml:10`, `services/vision/pyproject.toml:5`); 3.12 and 3.13
  enter the matrix only after the dependencies prove compatible
  (`docs/vnext/05-PYTHON-CORE-AND-PYPI.md:33`).
- The base install carries no mandatory GPU, PyTorch, Transformers or MLflow download
  (`docs/vnext/05-PYTHON-CORE-AND-PYPI.md:34`): it carries Pydantic and Pillow and nothing else
  (`python/visionlens/pyproject.toml:18`), as the amendments of 2026-11-14 record.
- Heavy imports stay lazy and raise an actionable `MissingExtraError` naming the exact install
  command (`docs/vnext/05-PYTHON-CORE-AND-PYPI.md:35`); as built the `MISSING_EXTRA` error code
  is already frozen in the wire vocabulary (`packages/contracts/src/worker/protocol.ts:86`) and
  the worker self-reports it for a registry model whose extra is absent
  (`python/visionlens/src/visionlens/errors.py:24`).
- `uv` management continues; the lock decision is taken in the amendment of 2026-11-14: one lock per
  publishable distribution, the shared workspace lock deferred to the point where a second
  distribution exists.
- Pure-Python universal wheel, no bundled model checkpoints, opt-in Hugging Face downloads with
  license and SHA provenance (`docs/vnext/05-PYTHON-CORE-AND-PYPI.md:37`); the wheel target
  ships `src/visionlens` only (`python/visionlens/pyproject.toml:40-41`).
- Publication block: nothing is published until the registry check, the license audit, the
  README and local wheel plus sdist tests in a clean consumer install pass, and no availability
  or unclaimed-name claim is made from this repository today
  (`docs/vnext/05-PYTHON-CORE-AND-PYPI.md:38`,
  `docs/migration/vision-lens-vnext-reconciliation.md:374`).

## Hardware, security and test obligations

These gate the first real (non-simulated) ML work; none is claimed as done.

| Area | Acceptance condition | Source |
|---|---|---|
| Device planning | `DevicePlanner` checks MPS availability, memory and operator compatibility, accepts a CPU fallback with a status; CUDA optional, isolated in GPU workers; as built the planner admits the CPU only, refuses an accelerator this build does not run and names the accelerators the machine has, and the memory admission and the operator check are deferred (the amendment of 2026-11-14) | `docs/vnext/05-PYTHON-CORE-AND-PYPI.md:61` |
| Operation fallback | an unsupported operation falls back or fails with a reason, never silently changes method; hashes, split, model revision and device metadata enter every run manifest | `docs/vnext/05-PYTHON-CORE-AND-PYPI.md:56` |
| Scheduling | `BatchScheduler` reduces batch size on transient exhaustion with bounded attempts and explicit `resource_fallback` events | `docs/vnext/05-PYTHON-CORE-AND-PYPI.md:63` |
| Training | the `Trainer` checkpoints, reduces batch size or fails explicitly on MPS OOM, and never claims equivalence after a hyperparameter change; a missing calibration is `null`, never 1.0 | `docs/vnext/05-PYTHON-CORE-AND-PYPI.md:64-66` |
| Untrusted input | MIME versus magic bytes, dimension and decoded-pixel caps, archive limits, traversal and symlink protection, path allowlist, SSRF protection | `docs/vnext/19-SECURITY-PRIVACY-SUPPLY-CHAIN.md:9` |
| Model artifacts | allowlisted repositories with exact revision and SHA, license and terms registry, vulnerability scanning, safetensors preference, no arbitrary pickle, `trust_remote_code=False` outside an audited sandbox | `docs/vnext/19-SECURITY-PRIVACY-SUPPLY-CHAIN.md:10` |
| Privacy | default local processing, per-provider egress disclosure, EXIF redaction, retention and deletion; secrets, PII, raw images and local paths redacted from logs and traces | `docs/vnext/19-SECURITY-PRIVACY-SUPPLY-CHAIN.md:14-16` |
| Agent threats | the six threat cases carried as security acceptance conditions | `docs/vnext/19-SECURITY-PRIVACY-SUPPLY-CHAIN.md:20-25` |
| Test layers | the reconciliation gate runs first (existing suites freshly executed, no older count cited as fresh); then the blocking contract layer (Zod, Python JSON Schema, OpenAPI, npm client), worker integration, CLI parity, security, and the packaging gate (wheel plus sdist in a clean install) | `docs/vnext/21-TEST-AND-QUALITY-PLAN.md:9-17`, `:21` |
| Hardware matrix | CPU green on every PR, MPS on an actual Mac, CUDA optional; unverified platforms are listed, never assumed | `docs/vnext/21-TEST-AND-QUALITY-PLAN.md:15`, `:39` |

## Migration and rollback

Migration proof, per `docs/vnext/02-ARCHITECTURE-DECISION.md:37`:

| Acceptance condition | Status as built |
|---|---|
| Dual-runtime parity on one golden inference path | partially proven: the cross-language suite runs the real TS host against the real Python worker (`packages/core/tests/worker/python-integration.test.ts:21-34`), the pack's frame examples validate in both languages (`packages/contracts/tests/worker/pack-examples.test.ts`, `python/visionlens/tests/test_pack_examples.py`), and the Python golden transcript pins one scripted session byte for byte (`python/visionlens/src/visionlens/golden/__init__.py:1`); a real-model golden path lands with the CPU vision adapter (spec 019) |
| The old Node CLI suite stays green | unchanged by this ADR; the CLI bins and exports are untouched |
| Python works standalone and packages into a wheel | the package builds its wheel from `src/visionlens` (`python/visionlens/pyproject.toml:40-41`); the container image consumes it (`docker/runtime/`) |
| `@vision-lens/sdk/client` calls the application API with no Python in the JS consumer environment | not yet built; the entrypoint does not exist (`packages/sdk/package.json:7-9`) |

Rollback: revert the commit that carries this ADR, the owner map and the static check. This
decision changes no runtime code, no migration and no data, so reverting restores the previous
behavior exactly, and ADR-006, never edited, still stands on its own terms
(`docs/vnext/00-ADOPTION-NO-OVERWRITE.md:36`).

## Validation before acceptance

Carried from the pack's own ADR-011 (`docs/vnext/adrs/ADR-011-python-first-ml-runtime.md:17-21`):

1. Compared against `docs/adr/005` through `010`: 005 and 008 are untouched; 006 is superseded in
   part by the record above; 007 carries the ordering conflict recorded under Open decisions; 009
   and 010 are unaffected.
2. One implementation-compatible golden path and a rollback strategy: the cross-language suite
   and the golden transcript named above; the rollback is the revert above.
3. Shipped TypeScript features and the compatibility aliases preserved: both CLI bins
   (`packages/cli/package.json:10-11`) and the SDK exports (`packages/sdk/package.json:7-9`)
   unchanged.
4. Source docs and the architecture tests updated in one focused change: the owner map, the
   static check and its suite, all in the same change as this ADR.

## Guard

The owner map is enforced statically and fails closed: `pnpm run check:owner-boundaries`
(`scripts/check-owner-boundaries.mjs`) scans the tree, rejects any Python import of a TypeScript
package, any host import reaching past the protocol, any drift between the two protocol
definitions, and any contract-version disagreement; it also proves its own scanner fires on
planted violations. `packages/core/tests/owner-boundaries.test.ts` asserts both directions: the
clean tree passes and planted violations are rejected. A mutation run on 2026-11-12 confirmed
each rule reddens on a violating scratch tree and the clean tree stays green.

## Open decisions

| Decision | State |
|---|---|
| Registry names `visionlens` and `@vision-lens` | unverified against their registries; no availability claim made (`docs/migration/vision-lens-vnext-reconciliation.md:345-346`) |
| Extras naming | resolved as built (full-word set); the maintainer may reopen it before the first publication |
| The Python lock layout | decided 2026-11-14 by the amendment of 2026-11-14: one lock per publishable distribution, the shared workspace lock deferred to the point where a second distribution exists |
| ADR-007 MPS-first versus the pack's ADR-017 CPU-reference | an ordering conflict, not a contradiction; recorded for the ADR-017 acceptance text, ADR-007 left unedited (`docs/migration/vision-lens-vnext-reconciliation.md:216`) |
| Acceptance of this ADR and the later pack ADRs | decided 2026-11-12: this ADR is ACCEPTED (the maintainer delegated the call; the decision records as-built reality, byte-unchanged ADR-006 supersession included); the seven later pack ADRs stay design targets whose acceptance is milestone-gated by the vNext release train as their specs land, so no unbuilt surface is claimed (`docs/migration/vision-lens-vnext-reconciliation.md:347-348`) |
| Agent tier vocabulary, cancel spelling, approval contract, worker identity space | belong to their own ADRs (`docs/migration/vision-lens-vnext-reconciliation.md:335-344`) |

## Evidence

Executed for this change on macOS 25.6 (darwin, arm64), Node v24.22.1, pnpm 11.0.8, repository
HEAD `352d2504418008e6d9695ad7b509cf970cfc4178` plus this change's new files; output artifact is
the console output of each command, quoted in the change report.

| Gate | Command | Exit |
|---|---|---|
| Owner boundary check, clean tree and self-proof | `pnpm run check:owner-boundaries` | 0 |
| Boundary suite, both directions | `pnpm exec vitest run packages/core/tests/owner-boundaries.test.ts` | 0 (3 tests) |
| Type check | `pnpm typecheck` | 0 |
| Lint | `pnpm lint` | 0 |
| Doc drift | `pnpm run docs:check` | 0 |
| Meta guard (AGENTS.md budget, harness leakage) | `pnpm exec vitest run packages/core/tests/meta/ai-config.test.ts` | 0 (19 tests) |
