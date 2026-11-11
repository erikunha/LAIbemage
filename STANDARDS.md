# Engineering Standards: Vision Lens

> The canonical engineering bar for this repository. Every standard below names how it is
> enforced: a CI gate, a local script, a review checklist, or culture. A rule with no enforcement
> is marked as such, deliberately.

The chapters below are organized by domain. Each states the **rule**, the **rationale**, and
**how it is held**: the concrete mechanism that keeps the rule true on every change. Where a rule
is held by culture rather than by a gate, the chapter says so plainly. An aspirational rule with
no enforcement is a lie, and this document does not tell them.

One discriminator governs every word written here: does a gate already state this? If yes, the
rule points at the enforcing file instead of copying it. Prose that restates a gate is a second
copy that drifts, and a second copy of a threshold is a threshold that will be wrong one day
without anyone noticing.

---

## 1. TypeScript and the ESM rule

**Rule.** The workspace is strict TypeScript compiled for NodeNext ESM. Every relative import
carries the explicit `.js` extension even though the source file is `.ts`. Types that cross a
module boundary are declared, not inferred into existence: no `any` without a stated reason, and
no `as` cast used to silence a missing field.

**Rationale.** NodeNext is the resolution mode that matches what Node actually does at runtime,
so the compiler is the only thing standing between a relative import that resolves at build time
and one that throws at first call. The extension looks redundant to anyone who has only written
CommonJS or a bundler-resolved project, which is precisely why it has to be a rule: the failure
it prevents is a runtime crash, not a compile error, and it surfaces far from the file that
caused it. The same argument applies to the casts. A cast does not make a type true, it only
moves the lie to the place where nobody looks.

**How it is held.** Held by a gate: the compiler, through `pnpm run typecheck`, which covers
every workspace package plus the root `scripts/` project. The `.js` extension rule is stated as a
decision in ADR-001 (`docs/adr/001-esm-nodenext.md`) and its violation is a runtime error the
test suite surfaces. The `any` discipline is held by `eslint.config.js`, which downgrades
`no-explicit-any` to a warning rather than an error, so an unexplained `any` reaches the review
as a warning rather than a build failure. That half is held by **culture and PR review**: nothing
mechanically forces the reason to be stated.

The version constants that tell a consumer whether a shape changed are declared once, in
`packages/core/src/types.ts`: `CACHE_SCHEMA_VERSION` (currently `1`) for the on-disk cache shape
and `PLUGIN_API_VERSION` (currently `1`) for the plugin interface. They are the contract between
a writer and a reader of that shape, so a change to the shape and a change to its version belong
in the same commit.

---

## 2. Module boundaries

**Rule.** Each directory in the workspace has one job and one set of permitted dependencies. The
table in `AGENTS.md` is the contract: what a directory may import, what it may not, and where the
documented exceptions live. A provider SDK is imported only where the table says it may be, and
every other module talks to a provider through the adapter interface. A new import that crosses a
forbidden edge is a defect even when the code works.

**Rationale.** Boundaries are what keep a pipeline testable without a network. When every module
can reach every other, the only way to test a rule is to run the whole system against a live
provider, and the moment that happens the test suite stops being a gate and becomes a
demonstration. The table makes the constraint legible in one place instead of distributed across
dozens of import statements, so a reader can check the design without reading the code.

**How it is held.** Held by a gate, but only in part, and the difference matters. The
provider-SDK edge is mechanically enforced: `eslint.config.js` carries the restricted-import
rule, with the provider directory as the carve-out, and the boundary table in `AGENTS.md` names
the one documented exception. That rule is proven, not assumed: `scripts/check-boundaries.mjs`
lints a deliberately violating fixture and a clean fixture and asserts the exit codes, and
`packages/core/tests/boundaries.test.ts` runs that proof as part of the normal test suite, so a
boundary rule that stops firing fails the build.

Every other edge in the table is **held by PR review only**. No lint rule reads the table, and no
script walks the workspace to prove that, say, `packages/core/src/processor/` stayed free of
analyzer imports. The review checklist in `.claude/agents/code-reviewer.md` and `.claude/commands/review.md`
covers those edges, which is a real check performed by a reader, not a mechanical one. A rule
the table states and only review holds is a real rule with a real enforcement, but it is not the
same kind of enforcement, and the difference is stated here so no one mistakes one for the other.

---

## 3. Testing

**Rule.** A test asserts observable behavior: call the function and inspect the result, run the
command and inspect its output and its exit code. It does not read the source file and assert that
a string is present. New logic arrives with the test that would have failed without it. Fixtures
are complete: a config fixture carries every field the type requires, so a new required field
breaks the build instead of silently defaulting. A provider SDK is never mocked at the
constructor; the adapter interface is the seam.

**Rationale.** A source-reading test passes when the expected token appears anywhere in the
file, including in a comment or a dead branch, and fails on a harmless rename while the behavior
is unchanged. It measures the shape of the text, not the correctness of the program, and it
gives a false sense of coverage. The fixture rule is the same failure in a different place: an
incomplete fixture makes the test assert against a configuration the product never runs, so the
test passes about a world that does not exist.

**How it is held.** Held by a gate: Vitest is the test runner, the coverage scope and the
threshold it enforces are configured in `vitest.config.ts`, and `pnpm run test:coverage` is the
command CI runs, so a drop below the threshold fails the job. The `packages/core/tests/` tree
mirrors `packages/core/src/`, and the coverage configuration in the same file names the paths it
excludes and why.

Assertion quality, fixture completeness and the mocking seam are **held by review** and by the
`test-author` agent. There is no meta-test that reads the test files and fails when one greps
the source. The mutation run is the closest mechanical proxy: `stryker.config.mjs` scopes it to
the pure logic modules, and the mutation workflow runs Stryker against them, so a surviving
mutant is a behavior the suite does not actually pin down. It covers a slice of the suite, so it
is a signal about the hardest part, not a proof about the rest.

---

## 4. Reproducibility and the evidence policy

**Rule.** The real-data benchmark is the only source of an accuracy claim. Every metric artifact
carries its reproduction record: the dataset snapshot, the split seed, the config fingerprint,
the model version and the environment. A run whose record is incomplete is not written at all.
Synthetic fixtures are test inputs, never a product accuracy claim. A missing dataset is a skip
with an explicit marker, never a fabricated number and never a failure of the job. A baseline is
a reviewed artifact: moving one is a decision.

**Rationale.** A claim without its reproduction record is a hypothesis. Once a number appears in
a README, a PR body or a benchmark artifact without the tuple that produced it, it cannot be
re-derived, and every downstream comparison inherits the uncertainty without inheriting the
means to check. The synthetic-fixture case is the concrete failure this rule exists to prevent:
the harness computes real metrics over meaningless ground truth, and the metrics look perfect.

**How it is held.** Held by a gate and by a decision record. The policy is ADR-008
(`docs/adr/008-evidence-policy.md`). The benchmark runner refuses to emit an unattributed
report, and the gate compares a run against the stored baseline and fails with the regressed
classes named, so a failure is actionable rather than a bare exit code. The dataset itself is
never fetched by CI: the license, the source and the checksum are recorded in
`datasets/registry.json` before first use, and the tracked splits, predictions and baselines live
under `benchmarks/`.

The benchmark gate workflow (`.github/workflows/benchmark-gate.yml`) proves the gate still
protects anything: it runs the pipeline end to end on the synthetic fixture, plants a regression,
and requires the gate to fail AND to name the regressed classes. A gate that crashed for an
unrelated reason also exits non-zero, so the workflow asserts on the output, not only on the exit
code.

That a human reviews every baseline move is **held by culture and PR review**, not by a gate: the
baseline writer requires an explicit force above its own review threshold, but no workflow
approves the change for you.

---

## 5. Errors, logging and observability

**Rule.** `packages/core/src/utils/logger.ts` is the only log sink. `console.*` appears nowhere
else except the progress renderer, so `--quiet`, `--verbose` and `--json` keep working for every
line the product emits. Errors are typed and named at the layer where they are meaningful: a
failure the operator can act on and a failure only a developer can act on are different classes,
and the class is visible in the type. A failure message says what broke and what to do next, not
only what the stack says.

**Rationale.** A log line written outside the sink is a line the product cannot silence, cannot
structure, and cannot route. In a machine-readable mode, one stray line is a corrupt output
stream, which is a different class of bug from a noisy terminal. On the error side, an untyped
error forces every caller to inspect a message string to decide what to do, and a caller that
inspects a string is a caller that breaks when the message changes.

**How it is held.** Held partly by a gate and partly by review. The typed error classes of the
store live in `packages/core/src/store/errors.ts` and are part of the public surface of that
module, and the contract schemas in `packages/contracts/src` are the typed vocabulary shared
across packages, so a payload crossing a package boundary is validated rather than trusted. The
CLI's exit codes are a contract with the shell, and the `dx-engineer` agent audits them.

The logger rule itself is **held by review and by the `dx-engineer` audit**, not by lint: the
ESLint configuration leaves `no-console` off, because the sink itself and the progress renderer
need it. So the rule is real and enforced by a checklist, but it is not a compiler or a lint
failure. This document states the gap so it is not mistaken for coverage.

---

## 6. Data and store integrity

**Rule.** The store is the metadata spine. Migrations are immutable: once a migration is applied,
its bytes never change, and a changed migration is refused rather than re-run. Every migration
has a real rollback script, migrations apply in order, each in its own transaction, and a broken
sequence is an error rather than a silent skip. A migration that drops or rewrites data requires
a MAJOR contracts bump, because the contracts are the versioned description of what the stored
meaning is. Model output and human ground truth are separate entities, every label carries its
provenance, and an original is never mutated in place.

**Rationale.** An edited applied migration is how a database ends up in a state that nobody can
reproduce: the ledger says one thing, the file says another, and the difference is invisible
until it is expensive. The transaction-per-migration rule is what makes a failed apply leave
nothing behind. The Prediction and Annotation split is the same idea one layer up: a model's
guess and a person's approval that live in one table are one fact later, and the day they need
to be told apart is the day the data no longer exists.

**How it is held.** Held by a gate: the migration runner is the enforcement point, and its
protocol is written down in the module that implements it. The invariant tests under
`packages/core/tests/store/` cover the migration history, the rollback path, the links between
entities and the round trip of the sentinel payloads. The contract side is guarded by
`packages/contracts/src/version-guard.ts`, which diffs two manifests and classifies the
difference, with its own test.

The destructive-change rule is **held by review**: the runner cannot know the intent of a
migration, so the MAJOR bump is the discipline the reviewer applies, and it is mirrored by the
contracts version guard. The protocol is described in `docs/architecture/store-schema.md`, which
is the operator-facing reference for the schema, the migration rules and the read-only view.

---

## 7. Dependencies and supply chain

**Rule.** pnpm is the package manager and the lockfile is the source of truth. The package
manager version is pinned in the repository. CI installs from the frozen lockfile, so a clean
machine resolves the same tree as the maintainer's. A new dependency comes with a stated purpose
and lands in the lockfile in the same change. Dataset binaries never enter the repository, and a
dataset that will be used is registered with its license, its source and its checksum before
first use.

**Rationale.** The lockfile is what makes a build reproducible across machines and across time,
which is the property the benchmark evidence depends on: a metric measured against one tree is
not comparable to a metric measured against another. Pinning the package manager matters for
the same reason one step earlier. The dataset rule exists because a license and a checksum are
the only parts of a dataset that can be reviewed before the gigabytes arrive.

**How it is held.** Held by a gate, and honestly labelled: the dependency audit in CI is
currently **advisory**. The workflow records exactly why, with the count and the affected chains,
and states the condition for making it a hard gate. That is the honest state of the gate, and a
reviewer who wants the audit to be blocking says so as a decision rather than a diff.

The install surface is bounded by the workspace configuration, which lists the packages allowed
to run install scripts, so a new transitive build script is a visible change. The dataset
registry is tracked and its checksum is pinned, and the dataset directories themselves are
ignored. `engine-strict` in the npm configuration means an engine mismatch fails the install
instead of warning.

---

## 8. Documentation and the API surface

**Rule.** A doc that states a number, a path or a command that does not hold is a defect, not a
style issue. Every claim a reader can act on must be verifiable against the code: a command in a
README is a command that runs, a path in a document is a path that exists, a number in a document
is a number that was measured. The decisions that constrain future work are recorded as ADRs in
`docs/adr/`, and the public API surface is the SDK package: its exports are semver-stable and
everything else is internal.

**Rationale.** Documentation that drifts from the code is worse than no documentation, because a
reader trusts it. In this repository that is not a stylistic concern: the whole benchmark
apparatus exists so that a number can be traced to the run that produced it, and a document
stating a stale number breaks the same chain from the other end. An ADR series matters for a
separate reason: it records why the current shape is the current shape, which is the only thing
that lets a future change distinguish a decision from an accident.

**How it is held.** Held partly by a gate: the API reference is generated by typedoc through
`pnpm run docs:generate` and published by the docs workflow, so the reference cannot describe an
export that no longer exists. The README flag table has its own generator and a check script
(`pnpm run readme:check`).

Two honest caveats. First, the README check is currently **not** run by CI: the workflow records
that the README moved to curated thematic tables and that the generator markers were dropped, so
the script and the README currently disagree. That is a known gap, not a silent one, and the
reviewer sees it in the workflow file. Second, **no script verifies the numbers, paths and
commands that prose describes**. That part is held by review, and this chapter states the gap so
it is not mistaken for coverage.

---

## 9. Git, commits and review

**Rule.** Commits follow the Conventional Commits format that the commit linter enforces. One
logical unit per commit, and the commit body carries the measured property before and after when
the change moves one. A change never disables a gate to merge: a failing gate means the
underlying property is fixed, not that the gate is removed. The review contract is `REVIEW.md`,
and it is the same contract for a human and for an agent.

**Rationale.** The commit history is the audit trail for a project whose whole argument is
traceability, and a history that mixes unrelated changes cannot be read as evidence. The
"never disable a gate" rule is the load-bearing cultural rule of this document: a gate that can
be switched off under deadline pressure enforces nothing, and a project that measures evidence
cannot afford one that quietly measures nothing.

**How it is held.** Held by a gate and by the git hooks. The commit format is enforced by
`commitlint.config.cjs` through the commit-msg hook; the hooks themselves are declared in
`package.json` under `simple-git-hooks`, so a clone that installs dependencies gets them. The
pre-push hook runs the type check and the test suite, so the common failure is caught before it
reaches the remote.

The rule that a gate is never disabled to merge is **held by culture and PR review**. There is no
meta-gate that can prevent a gate from being deleted, only the standard that says it must not be.
The repository's backstop is the review itself: `REVIEW.md` defines what blocks and what never
does, and the blocking findings must be answered before the change lands.

---

## 10. The agent surface

**Rule.** The repository's own skills are canonical. A skill in the repository's skill directories
supplies the method for a surface, and a skill that does not apply is not run. The maintainer's
personal global skills are optional extras: they may add method, they never override a
repository skill, and they never become a second source of truth about this codebase. An agent
runs the gate before claiming a change is done, and cites what it ran. Spec material is not part
of the repository: the tracked record of the same decisions is the ADR series and the roadmap,
and an agent that receives spec material receives it through the dispatch channel, not through
git.

**Rationale.** Two skills that both claim to describe how to add a provider will disagree, and
the disagreement is discovered at the worst moment: halfway through a change, with the wrong one
already applied. One canonical source per surface removes the ambiguity. The rule about global
skills follows from the same place: a personal library is fine as a library, and a problem the
moment it becomes the authority for a shared repository. The spec rule keeps the same property
here: the durable decisions are tracked, the planning material is not, so a collaborator inherits
the constraints without inheriting a tool lock-in.

**How it is held.** Held by the **structure of the repository** and by review, not by a gate. The
skill directories are the canonical registry, one directory per skill with its own entry file,
and the repository's own skill-creation procedure documents the format. The agent roster is
listed in `AGENTS.md` and mirrored for the other agent runtime, so a reader can see which agent
owns which surface. The ADR series and the roadmap are the tracked mirrors of the planning work,
as ADR-010 records.

That an agent reads a skill's trigger before running it, and that a global skill is used only
when it fits the same surface, is **held by culture and review**. Nothing prevents a wrong skill
from being loaded; the review catches the result.
