# Vision Lens vNext reconciliation (VLN-001)

| Field    | Value                    |
| -------- | ------------------------ |
| Status   | Proposed                 |
| Date     | 2026-11-11               |
| Deciders | @erikunha                |
| Ticket   | VLN-001, phase R0, role architecture |
| Repository | `erikunha/LAIbemage`, branch `feat/visual-lens`, commit `6c3d95f` |
| This report | branch `feat/vnext-reconciliation`, commit `ed327ff` |
| Design baseline | `VisionLens_2027_Canonical_Spec` (2026-11-11), integrated at `docs/vnext/` |

This report reconciles the canonical vNext design baseline with the repository as it actually
is. The protocol names it `docs/migration/vision-lens-vnext-reconciliation.md` and the ticket
names it `docs/migration/vnext-reconciliation.md`; the protocol's name is used here. It changes no runtime code and performs no destructive git operation. Its acceptance
criterion is that it names every impacted package and conflicting ADR, carries the test
evidence, and identifies exactly one next implementation pull request.

## 1. Provenance and method

The design baseline is the package the maintainer delivered at
`~/Downloads/VisionLens_2027_Canonical_Spec`. It is copied into the repository at `docs/vnext/`,
which is the location its own adoption protocol names: "Introduce the canonical package in
`docs/vnext/` initially, not as blind replacements for `README.md`, `AGENTS.md`, `ROADMAP.md`, or
`docs/adr/006-monorepo-ts-python.md`".

All 64 files of the integrated package match the manifest, verified by SHA-256 over the whole tree, and the repository holds no file under `docs/vnext/` that the package does not contain.
The pack's own validator therefore holds inside the repository:

```
$ python3 docs/vnext/validation/validate_pack.py
WARN: jsonschema unavailable; JSON schema validation not checked
Files: 74 Manifest: 64 Errors: 0
```

The pack's `MANIFEST.sha256` covers 64 files. The one file it does not cover is the manifest
itself. The optional `jsonschema` check was skipped because the package is not installed. Without it
the validator neither proves the three proposed JSON Schemas are valid Draft 2020-12 schemas nor
pairs the two that have an example file with those examples; `job-status.v1.schema.json` has no
example at all. That check is listed in section 12 as unverified.

### 1.1 The first integration dropped the 12 specs, and how that was found

The copy was not complete when the first integration commit was made, and the validator output
quoted above was produced against a working tree rather than against the committed tree. A
machine-wide gitignore rule (a bare `specs` entry in the developer's global git ignore) matched
`docs/vnext/specs/`, so the 12 `VLN-*` tickets were silently excluded from the commit while the
files themselves stayed in the working tree, where they were readable and where the validator
passed. The committed tree was missing all 12 of them, and the validator run against that tree
reported `Errors: 12`, because `MANIFEST.sha256` lists every one of them.

The repair is a follow-up commit that stages the 12 specs, together with a narrow negation in the
repository's own `.gitignore`:

```
!docs/vnext/specs/
```

The negation is deliberately scoped. It re-includes the pack's directory and nothing else, so the
spec-kit personal flow stays ignored everywhere else in the repository. The committed tree is now
complete: all 64 package files are present, the manifest and the tree agree, and the validator
reports `Errors: 0` against the committed tree. The branch that carries this repair also carries
the negation, so the two changes travel together through the merge into `main`.

What was read: the adoption protocol, the observed repository state, the architecture decision,
all 28 numbered design documents, all 8 ADRs, all 12 `VLN-*` tickets, the
execution backlog, the proposed contracts and examples, the validation script, and the full
specification. The prior spec-kit material under `specs/001-014` was listed but not read: it is
the maintainer's personal planning material, excluded from git by ADR-010, and it is not
overwritten by this baseline.

What was NOT done, deliberately: no branch was switched, no commit was rewritten, no untracked
file was deleted, no spec material was renumbered, and no runtime code was modified.

## 2. The inventory the adoption protocol asks for

The protocol's first required step is a read-only inventory. It was taken, and it is recorded
here so the next reader does not have to repeat it.

The branch is `feat/vnext-reconciliation`, created from `feat/visual-lens` at `6c3d95f`. The
last eight commits are the agent-surface work of this session and the benchmark milestone:

```
ed327ff docs(vnext): integrate the canonical design baseline and reconcile it
6c3d95f fix(agents): repoint the skills at the real monorepo paths
ec70169 docs(standards): state the engineering bar and record the agent surface
a9f1535 docs(review): define what a review reports and what blocks a merge
422a309 fix(agents): repoint the agent surface at the real monorepo paths
f3e6fbf feat(agents): make the project skills canonical and provider-agnostic
44cfce7 chore(benchmarks): attribute the baseline to the run it was recorded from
e7ddab9 docs(benchmark): tell the truth about the first real measurement
```

The working tree at `ed327ff` carried no tracked modification. The untracked paths were:

```
COMPETITIVE_BRIEF.md          DOCUMENTS.md                 IMPLEMENTATION_PLAN.md
MARKET_SIZING.md              SAAS_ROADMAP.md              SCENARIO_ANALYSIS.md
SYSTEM_DESIGN.md              UNIT_ECONOMICS.md            docs/adrs/
examples/categories.commercial-inspection.json
examples/categories.home-inspection.json
examples/categories.insurance-claim.json
examples/categories.pre-purchase-inspection.json
examples/categories.rental-turnover.json
playbook/                     saas-scaffold/
```

Those are the maintainer's own planning material for the SaaS direction. None of it is part of
the vNext programme, none of it was read, none of it was deleted, and none of it is in git. The
change from `6c3d95f` to `ed327ff` touches only `docs/`: 54 files, 4190 insertions.

The open pull requests are ten Dependabot branches, all of them dependency bumps for the
GitHub Actions and the toolchain. None of them touches the contracts, the store or the
benchmark, and none is blocked by this baseline.

The spec-kit material under `specs/001-014` and `.specify/` was listed, not read, and not
modified. It stays untracked, as ADR-010 requires.

## 3. Baseline evidence, executed

Every command below was executed on this machine against commit `6c3d95f`. Node
`v24.22.1`, pnpm `11.0.8` (the version the repository pins), macOS on arm64.

| Gate | Command | Exit | Result |
| --- | --- | --- | --- |
| Lint | `PATH=/tmp/pnpm11:$PATH pnpm run lint` | 0 | no findings |
| Type check | `PATH=/tmp/pnpm11:$PATH pnpm run typecheck` | 0 | 9 of 9 tasks successful |
| Unit tests | `PATH=/tmp/pnpm11:$PATH pnpm test` | 0 | 844 passed, 4 skipped, 848 total |
| Module boundaries | `PATH=/tmp/pnpm11:$PATH pnpm run check:boundaries` | 0 | the LLM SDK boundary rule fires on its fixture and passes the clean one |
| Build | `PATH=/tmp/pnpm11:$PATH pnpm run build` | 0 | 6 of 6 packages |
| Golden bin tests | `PATH=/tmp/pnpm11:$PATH pnpm --filter @vision-lens/cli run test:bins` | 0 | 21 of 21 |
| Python services | `python3 -m pytest services -q` | 0 | 3 passed |
| Commit messages | `PATH=/tmp/pnpm11:$PATH pnpm exec commitlint --from 44cfce7 --to HEAD` | 0 | no violations |
| Agent surface | `PATH=/tmp/pnpm11:$PATH pnpm exec tsx scripts/check-agent-surface.mjs` | 0 | 10 canonical skills, provider symlinks verified |

The number 848 is the freshly executed count, not a remembered one. The package's own
inspection reported 361, which is the count at the earlier monorepo migration.

On the re-run that an independent verifier performed at `ed327ff`, the type check and the build
were served entirely from the turbo cache (9 cached of 9, 6 cached of 6). The test suite, the
boundary proof and the golden bin tests recompiled and ran.

## 4. Classification per module

`KEEP` means the shipped code is the answer and the baseline agrees. `AMEND` means the shipped
code is right in substance but needs a named change. `DEFER` means the baseline's item is
correct and is not the next thing to build. `SUPERSEDE` means the baseline replaces a decision
the repository already made, and the replacement has to be accepted first. `CONFLICT` means the
two disagree in a way only the maintainer can settle.

| Module | Verdict | Code pointer | What the baseline says and what the repository has |
| --- | --- | --- | --- |
| Domain contracts | SUPERSEDE (in part, pending) | `packages/contracts/src/entities/` (14 entities, 4 reserved stubs) | The baseline names the same 14 entities and says the implemented Zod stays canonical. The proposed schemas in `docs/vnext/contracts/proposed/` describe a transport and job model, not a different domain model. The supersession is pending: it happens when ADR-011 is accepted, and until then the shipped contracts stand. |
| Contract manifest and version guard | KEEP | `packages/contracts/src/manifest.ts`, `version-guard.ts` | The manifest is derived from the live schemas, so it cannot drift. The baseline's "major is a structural break" matches the guard's six breaking kinds. |
| OpenAPI seed | AMEND | `packages/contracts/src/openapi.ts`, `packages/contracts/openapi.snapshot.json` | The snapshot is generated and holds 28 paths whose operation ids are prefixed `spec002Skeleton`. The baseline proposes real `/v1` routes. The generator changes; the snapshot is regenerated, never hand-edited. |
| Domain store | KEEP | `packages/core/src/store/`, migrations `0001_init.sql`, `0002_legacy_import.sql` | The baseline says to preserve the SQLite store and never replace it with a speculative Postgres, and that TypeScript is the only domain writer. The repository already satisfies this. |
| Job entity and lifecycle | AMEND | `packages/contracts/src/enums.ts` (`JobState`), `0001_init.sql` CHECK constraint | The baseline proposes a 10-state lifecycle with `created`, `leased`, `cancel_requested`, `canceled`, `lost`, `partial`. The repository has 6 states and a SQLite CHECK that enforces them. Widening the enum is additive under the guard, but the CHECK constraint needs a new numbered migration with its rollback. |
| Worker protocol | DEFER | absent | `visionlens.worker.v1` has no implementation and no schema in `packages/contracts`. It is VLN-004, blocked by VLN-002. |
| Operation registry | DEFER | absent | The baseline proposes 8 operation codes; the repository has none. ADR-016 would build it on the existing `AGENT_TOOL_TIERS` enum rather than a second tier vocabulary. |
| Agent permission tiers | CONFLICT | `packages/contracts/src/enums.ts` (`AGENT_TOOL_TIERS`), `docs/adr/009-agent-safety-tiers.md` | The repository implements 5 tiers (`read`, `analyze`, `propose`, `gated-execute`, `approval-required`). The baseline's tables introduce `bounded compute` and `privileged approval`. One vocabulary has to win. |
| Approvals | AMEND | `packages/contracts/src/entities/agent-run.ts` (`ApprovalSchema`) | ADR-009 requires a tool to return a pending approval request and to execute only after an explicit token. The schema can record only a finished decision, with no token, no TTL and no scope. ADR-018 asks for TTL and scope; making them required is a breaking change that forces a major `CONTRACTS_VERSION` bump. |
| CLI | KEEP | `packages/cli/src/index.ts`, `packages/cli/src/help.ts` | The `vision-lens` bin is canonical and the `ai-image-labeling` compatibility alias exists, exactly as the baseline's compatibility rule 1 requires. The baseline adds `--json` envelopes, `--dry-run` and a `doctor` subcommand; those are additive. |
| npm SDK | AMEND | `packages/sdk/package.json` (`exports`: `.`, `./cli`), `packages/sdk/src/index.ts` | The baseline wants a lightweight `@vision-lens/sdk/client` and a deprecated `/legacy`, while the root keeps its exports until a versioned migration. The root currently re-exports the cloud storage adapters, so a browser bundle would drag in the AWS, Azure and GCP SDKs. |
| Core providers and Sharp pipeline | KEEP | `packages/core/src/analyzer/providers/`, `packages/core/src/processor/` | The baseline says explicitly that there is no big-bang port: the current TypeScript providers and the Sharp pipeline stay until contract parity and profiling justify moving them. |
| Legacy analysis flow | KEEP | `packages/core/src/index.ts`, `packages/cli/src/commands/import-run.ts` | The baseline keeps `vision-lens import-run` for the legacy `analysis_results.json`. The command exists. |
| Python services | AMEND | `services/vision`, `services/training`, `services/agents` | The three skeletons stay as adapters and may import the public package. Each `pyproject.toml` declares no dependencies, so there is no ML code to move, only topology. No `python/` directory exists yet. |
| Python package `visionlens` | DEFER | absent | VLN-003, blocked by VLN-002. It needs one distribution with extras, a `uv` workspace lock, and a wheel that installs on CPU with no Node. |
| Python CPU vision adapter | DEFER | absent | VLN-005, blocked by VLN-003 and VLN-004. One image decoder and one visual encoder on CPU, with an operation code `vision.embed` and no model call without an explicit download permission. |
| TypeScript facade over the Python runtime | DEFER | absent | VLN-006, blocked by VLN-004 and VLN-005. An application service that routes to the Python worker, opt-in, with the historical `@vision-lens/core` and `@vision-lens/sdk` exports unchanged and no paid API fallback by default. |
| Benchmark split | CONFLICT | `packages/core/src/benchmark/splits.ts`, `scripts/benchmarks/make-splits.ts`, `benchmarks/splits/visa-subset.gold.json` | The committed manifest holds 700 of 700 assignments in `train`, with `val` and `test` empty. The baseline forbids publishing that number as model performance and makes a leakage-resistant split a gate. See section 9. |
| Benchmark baseline and gate | AMEND | `packages/core/src/benchmark/gate.ts`, `benchmarks/baselines/visa-subset.json` | The gate compares macro F1 against a baseline keyed by suite, model and model version, with a tolerance of 0.02. It does not check that the candidate and the baseline used the same split fingerprint, and the recorded fingerprint is the all-train one. |
| Evaluation report | AMEND | `packages/core/src/benchmark/runner.ts`, `metrics.ts`, `calibration.ts` | The runner already carries a reproduction tuple with the snapshot, the split fingerprint and the config fingerprint, and refuses a report whose items are not in the manifest. The baseline adds a protocol version, per-class support rules and an explicit non-holdout flag. |
| Dataset registry and license | AMEND | `datasets/registry.json`, `packages/core/src/benchmark/registry.ts` | The license is recorded, not enforced by a gate. The baseline lists `license_provenance` as a release gate. |
| Store migrations | KEEP | `packages/core/src/store/migrations/` | Migrations are immutable and each has a rollback. The baseline requires forward-only migration with a tested restoration procedure, which is the same rule. |
| Dataset manifests | AMEND | `benchmarks/splits/*.gold.json`, `benchmarks/predictions/*.json` | The tracked manifest, predictions and baseline stay as the historical regression artifact. A new suite id carries the new split, so the all-train number is never overwritten. |
| Model artifacts | DEFER | absent | No model registry, no MLflow, no checkpoint. VLN-009. |
| Studio | DEFER | `apps/studio/src/index.ts` (a placeholder) | The baseline proposes a Next.js Studio with 12 routes and a 10k-item virtual list. VLN-011, blocked by VLN-008 and VLN-010. |
| API service | DEFER | `apps/api/src/index.ts` (a placeholder) | VLN-004 and VLN-010. |
| MCP server | DEFER | absent, `@modelcontextprotocol/sdk` installed but unused | `packages/mcp` does not exist. VLN-012. |
| Security scanning | AMEND | `.github/hooks/secrets-scanner/`, `pnpm audit` in `ci.yml` | The audit is advisory with 68 documented findings, and the secret scanner is a Copilot session hook that no workflow runs. The baseline requires a static, dependency and secret scan in CI. |
| Observability | DEFER | absent | VLN-012 and the runtime work. |
| Agent surface for coding agents | KEEP | `.agents/skills/`, `scripts/check-agent-surface.mjs`, `docs/adr/019-provider-agnostic-agent-surface.md` | The baseline is silent on this surface, and its guidance is written as if it did not exist. The repository's gate is stronger than anything the baseline proposes. See section 7. |
| Spec-kit material | KEEP | `specs/`, `.specify/` (untracked, ADR-010) | The baseline requires new tasks to carry `VLN-` ids rather than reuse the old numbers, which is exactly the arrangement in place. |

## 5. Compatibility matrix

The baseline requires an explicit compatibility matrix for CLI flags, SDK exports, store
migrations, dataset manifests, model artifacts and the Python smoke services. Every row states
the delta that could break a user.

| Surface | Today | Proposed | Delta that could break a user | Handling |
| --- | --- | --- | --- | --- |
| CLI flags | 49 flags in `packages/cli/src/help.ts`, including `--dry-run`, `--estimate`, `--webhook`, `--session-gap` | keep, add `--json`, `doctor` | none if additive; a renamed flag breaks a script | Add only. No flag is renamed or removed. The compatibility bin keeps its alias. |
| CLI bins | `vision-lens` (canonical) and `ai-image-labeling` (alias) | unchanged | none | Keep both. The alias gets a sunset policy, not a removal. |
| SDK exports | `@vision-lens/sdk` exports `.` and `./cli`; the root re-exports the cloud adapters | add `./client` (lightweight HTTP) and `./legacy` (deprecated in-process) | a consumer that imports the root keeps working; a browser consumer that imports the root today already pulls the cloud SDKs | Add the entrypoints. The root keeps its exports until a major version. Nothing is replaced silently. |
| SDK package identity | `@vision-lens/sdk`, not published | publishable, name verified against the registry first | a name collision would block publishing | Verify the registry before claiming availability. Nothing published from this repository yet. |
| Contracts | `CONTRACTS_VERSION` 1.0.0, 14 entities, 8 enums | add a job entity and a job lifecycle | adding a required field to an existing entity is breaking and forces a major bump | The guard already refuses a breaking change without a bump. New fields start optional. |
| Store migrations | 2 migrations, each with a rollback; applied bytes never change | a third migration for the jobs table | a local store built on the old migrations must still open | Forward-only, with a rollback file, and the existing store keeps working. |
| Dataset manifests | `visa-subset.gold.json`, 700 assignments, hash `76dee597...85a0b2` | a new manifest under a new suite id | a reader that hardcodes the old suite id keeps working | The old manifest stays byte-identical. The new one is a new file and a new id. |
| Dataset registry | `datasets/registry.json` with sha256, license CC BY 4.0 and a fetch timestamp | unchanged, plus an enforced license gate | none | The registry stays the single place a dataset is recorded. |
| Benchmark baseline | `benchmarks/baselines/visa-subset.json`, macro F1 0.9795 over the all-train manifest | a baseline per suite id and split fingerprint | a run against the all-train split would be compared against the wrong number otherwise | The gate learns to compare split fingerprints before comparing numbers. |
| Model artifacts | none | content-addressed artifacts and an MLflow experiment record | none | Nothing exists to break. |
| Python services | 3 skeletons, one smoke test each, no dependencies | they become adapters over the public `visionlens` package | none today, because no service does real work | The service directories are not renamed or moved in R0. |
| Python package | does not exist | `visionlens` on PyPI with extras | a name collision would block publishing | Registry availability and licence are checked before any publication claim. |
| MCP | does not exist | `packages/mcp` with `@vision-lens/mcp` | none | New package, no existing consumer. |
| Studio | a placeholder that returns a string | a Next.js application | none today | New work behind VLN-008 and VLN-010. |

## 6. Conflicting and affected decisions

| Decision | Status here | Relationship to the baseline | Action |
| --- | --- | --- | --- |
| ADR-005 Vision Lens pivot | Accepted | consistent | none |
| ADR-006 monorepo TS and Python | Accepted | the baseline's ADR-011 inverts it: one Python library plus adapters, instead of three service homes for the ML code | The baseline supersedes it in part, but only once ADR-011 is accepted. Until then ADR-006 stands and is not edited. |
| ADR-007 local-first infrastructure | Accepted | the baseline's ADR-017 makes CPU the reference and MPS the optional path, while ADR-007 makes MPS primary with a CPU fallback | Ordering conflict, not a contradiction. ADR-007 is not edited; the difference is recorded for the ADR-017 acceptance text. |
| ADR-008 evidence policy | Accepted | its rule that the real-data benchmark is the only accuracy source is strengthened by ADR-015, which forbids publishing the all-train number as model performance | The baseline supersedes the framing of the rule that the manifest was a valid split. The accepted text stays until ADR-015 is accepted. |
| ADR-009 agent safety tiers | Accepted | ADR-018 adds an expiry and a scope to approvals, and a deterministic-baseline evaluation, which ADR-009 does not have | Extended by ADR-018. The scoping of the prohibition on shell and filesystem tools must be pinned: it governs the product's MCP surface, not the repository's own coding-agent surface. |
| ADR-010 spec-kit untracked | Accepted | the baseline agrees and adds the `VLN-` id rule | none |
| ADR-019 provider-agnostic agent surface | Accepted, committed at `ec70169` | the baseline does not mention the skills, the symlinks, the review contract or the gate | none. See section 7. |
| The baseline's ADR-011 to ADR-018 | Proposed, at `docs/vnext/adrs/` | not accepted | The repository keeps its own ADR numbering. When ADR-011 is accepted it lands at `docs/adr/011-python-first-ml-runtime.md`, and the numbering 011 to 018 is free because the agent-surface decision took 019. |

## 7. The agent surface, and what the baseline does not know about it

The baseline's document 26 is an agent implementation protocol titled for two specific
runtimes, and it treats the repository's agent surface as something that does not exist yet: it
never mentions the canonical skills, the provider symlinks, the review contract or the gate. It
does name `AGENTS.md`, but only as a file the package must not overwrite. The repository has an
agent surface of its own, committed at `ec70169`:

- ten canonical skills under `.agents/skills/<name>/SKILL.md`, each with the frontmatter the
  Agent Skills spec requires;
- a relative symlink per skill in `.claude/skills/` and in `.github/skills/`, tracked in git as
  mode `120000`, so the runtime a developer uses reaches the same file;
- `AGENTS.md` as the canonical instruction file;
- `REVIEW.md`, the contract that says what a review reports and what blocks a merge;
- `scripts/check-agent-surface.mjs`, a gate that fails closed when a skill loses its
  frontmatter, when a provider entry stops being a symlink, when a symlink points at the wrong
  target or does not resolve, when a canonical skill has no provider entry, or when a skill body
  names a vendor path;
- `packages/core/tests/agent-surface.test.ts`, which proves that gate fails on the broken state
  and not only on the good one.

The baseline's guidance does not contradict any of this. Its mandatory first action, a
read-only inventory before editing, is already the repository's rule. Its preference for one
self-contained pull request per change matches the review contract. Its refusal to reset or
rebase other work matches the adoption protocol.

What the baseline would change is the naming: it calls its own guidance an agent protocol and
points at a root-level `README.md`. The protocol additionally lists `README.md`, `AGENTS.md`,
`ROADMAP.md` and `docs/adr/006-monorepo-ts-python.md` as files the package must not replace, so
the baseline itself already agrees with the arrangement used here: those files stay canonical
in this repository, and the baseline lands under `docs/vnext/` beside them, never over them.
The baseline's document 26 is therefore read as guidance for adopting the baseline, not as a
replacement for `AGENTS.md`.

## 8. Unpushed local work the baseline could not see

The baseline was produced from a public snapshot, so it could not see work that exists only on
this machine. Two local branches carry commits that are not in `feat/visual-lens`. One carries real work that
would otherwise be lost; the other is a backup of history that has already been superseded:

| Branch | Commit | Content | Status |
| --- | --- | --- | --- |
| `fix/anthropic-5x-retry-cost` | `0aea4af` | Anthropic workspace id (config field, `anthropic-workspace-id` header, CLI flag, environment variable), a retry count parsed from user input, per-provider cost computation, a retry policy that treats 400, 401, 403, 404 and 422 as non-retryable and always runs at least one attempt, and the handling of a model that rejects a forced tool choice, with the reminder prompt that replaces it. 478 insertions, including tests for every one of those. None of the six features exists anywhere in the current tree. | KEEP and port, in its own pull request. The branch predates the monorepo, so the paths are the old `src/` ones and the work is a manual port, not a cherry-pick. It is not part of VLN-007. |
| `backup-003-precommitlint` | `15b193f`, with `3065cd2`, `0877afc`, `0d9d7a9` beneath it | the pre-rename benchmark history (`laib benchmark CLI`) | Superseded. The renamed and improved equivalent, and a superset of the benchmark artifacts, are in `feat/visual-lens`. Nothing to recover. |

Neither branch is pushed. Neither is lost: both refs exist locally, and the work is recorded
here with the exact commit that carries it.

## 9. The one next implementation pull request

**VLN-007, the leakage-resistant split.** Two tickets in the backlog are blocked by VLN-001,
which is this document: VLN-002, the Python-first ADR, and VLN-007. VLN-002 is an architecture
decision and needs the maintainer's approval before it can change anything; VLN-007 is the one
implementation ticket that is unblocked, and it touches no Python, no contract and no SDK. It
unblocks every scientific claim in the baseline.

The decision that VLN-007 makes possible is the one the whole programme rests on: the recorded
macro F1 of 0.9795 is a regression baseline over the scored images and not a measurement of
generalization, and every downstream milestone that claims quality depends on that split being
defensible.

Why it is first, in one sentence: the committed split holds 700 of 700 assignments in `train`,
so the recorded macro F1 of 0.9795 is a regression baseline over the scored images and not a
measurement of generalization, and every downstream milestone that claims quality depends on
that split being defensible.

The cause is structural, and it is two code sites. The committed manifest was produced with
`--target-images 700`, which selects the subset the normaliser selects, and in that path
`scripts/benchmarks/make-splits.ts:564` sets the capture group to the item's object class
unconditionally: `groupsOverride.get(relative) ?? entry.part`. The other path, which reads the
annotation CSV row by row, falls back to the object class when the file carries no session
column (`scripts/benchmarks/make-splits.ts:407-408`); the upstream release carries none, which
`docs/datasets/visa.md:280` records and the code treats as optional
(`scripts/benchmarks/make-splits.ts:360`). Either way the capture group of an item is its class.

The stratum is the class and anomaly cell, so each stratum contains exactly one group, that
group is larger than any quota, and the overflow branch of
`packages/core/src/benchmark/splits.ts:467-479` puts it in the split with the most remaining
quota, seeding the comparison at `train`, so a tie always lands in `train`. The algorithm
already supports items with no group (`packages/core/src/benchmark/splits.ts:380` skips a group
that is undefined or empty); the generator never exercises that path, because the group is
always set.

Scope of that pull request:

- `packages/core/src/benchmark/splits.ts`: a second, per-image strategy; the manifest fields
  `strategy`, `partitionIds`, `classCounts`, `groupBasis`, `leakageAudit` and `limitations`; a
  real near-duplicate guard built on the sha256 every item already carries; and a post-condition
  that reports `blocked` or `inconclusive` instead of silently returning an all-train manifest;
- `scripts/benchmarks/make-splits.ts`: a strategy-aware capture group, a `--strategy` flag, and
  a non-zero exit when the split is degenerate, before anything is written;
- `packages/core/tests/benchmark/splits-v2.test.ts`: the degenerate group, the rare class, the
  duplicate asset, two-seed reproducibility and dataset hash drift;
- `benchmarks/splits/visa-subset.v2.gold.json`: a new file under a new suite id, with
  `visa-subset.gold.json` left byte-identical;
- `packages/core/src/benchmark/gate.ts`: compare the split fingerprint before comparing numbers,
  so the all-train number can never gate the new run.

Its acceptance checks: three nonempty, mutually exclusive partitions; every eligible class
documented with its support; a duplicate leakage count of zero or an explicit warning; a
`limitations` string stating that acquisition-level independence cannot be proven for this
dataset; byte-identical regeneration with the same seed; and the existing split tests still
pass.

What this pull request deliberately does not do: it does not retrain anything, it does not
change the store, it does not touch the Python surface, and it does not delete the historical
all-train artifact.

## 10. Open decisions for the maintainer

These are recorded, not decided. Each one is a decision only the maintainer can take.

1. The tier vocabulary. The repository implements five tiers and the baseline's tables introduce
   two more names. One vocabulary has to win, and the implemented one is the harder to change.
2. The cancel spelling. The repository writes `cancelled` in both the Zod enum and the SQLite
   CHECK constraint; the proposed schema writes `canceled`. The CHECK is authoritative at
   runtime, so this is not cosmetic.
3. The approval contract. Adding the expiry and the scope ADR-018 asks for as required fields
   is a breaking change that forces a major `CONTRACTS_VERSION` bump. Optional fields avoid the
   bump and weaken the guarantee.
4. The identity space of the worker protocol. The repository uses UUIDv7 everywhere; the
   proposed worker schemas use free-form strings.
5. The names on the registries. The PyPI name `visionlens` and the npm scope `@vision-lens` are
   unverified against their registries.
6. The acceptance of ADR-011 and the seven ADRs after it. Decided 2026-11-12: ADR-011 is
   accepted (the maintainer delegated the decision; the record lives in the ADR header and
   its open-decisions table); ADR-006 stands byte-unchanged with its supersession recorded.
   The seven ADRs after it remain design targets accepted per milestone as their vNext
   specs land, so no unbuilt surface is claimed.
7. The port of `fix/anthropic-5x-retry-cost`. It is real work that is not on the branch, and
   the port is a manual one. It is its own pull request, separate from VLN-007, and it adds a
   public CLI flag and an environment variable, so it is the maintainer's to order.

## 11. Rollback, and what this report does not claim

This report is a document on a branch. Rolling it back is deleting this file and the `docs/vnext/`
directory; there is no runtime effect, no migration and no data to restore. The package is copied
byte-identically, so removing `docs/vnext/` removes it entirely and leaves the repository as it was
at `6c3d95f`.

The repository's `ROADMAP.md` is **not** updated by this report. It tracks the F0 to F5 phases of
the spec-kit programme, and the baseline tracks R0 to R9 with its own numbering. Reconciling the
two is a decision about which numbering the roadmap keeps, and it belongs with the acceptance
of ADR-011 rather than with a document that changes no code. Until that decision, both
numberings are recorded side by side and the roadmap is left alone.

## 12. What this report does not claim

- It does not claim that the baseline is compatible with the repository. It classifies each
  module and names where it is not.
- It does not claim the proposed contracts validate. The `jsonschema` check was skipped
  because the package is not installed; that check is unverified.
- It does not claim the `VLN-007` pull request is implemented. It is specified here, with its
  cause identified and its acceptance checks written.
- It does not claim the recorded macro F1 of 0.9795 is a quality result. It is a regression
  baseline over the 700 scored images, and the split that produced it holds no held-out set.
- It does not claim any package is published. Nothing is published from this repository today.
