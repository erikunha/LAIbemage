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
analyzer imports. The review contract in `REVIEW.md` and the procedures in `docs/procedures/`
cover those edges, which is a real check performed by a reader, not a mechanical one. A rule
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

Assertion quality, fixture completeness and the mocking seam are **held by review** against the
contract in `REVIEW.md` and the test-module checklist in chapter 10. There is no meta-test that
reads the test files and fails when one greps the source. The mutation run is the closest
mechanical proxy: `stryker.config.mjs` scopes it to the pure logic modules, and the mutation
workflow runs Stryker against them, so a surviving mutant is a behavior the suite does not
actually pin down. It covers a slice of the suite, so it is a signal about the hardest part,
not a proof about the rest.

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
CLI's exit codes are a contract with the shell, and a CLI UX review audits them.

The logger rule itself is **held by review**, not by lint: the
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

**How it is held.** Held by a gate, and honestly labelled: the pnpm dependency audit in CI is
currently **advisory**. The workflow records exactly why, with the count and the affected chains,
and states the condition for making it a hard gate. That is the honest state of the gate, and a
reviewer who wants the audit to be blocking says so as a decision rather than a diff. The Python
distribution's own audit is already a hard gate: the release gate's `dependency-scan` step
records every finding with its severity and fails on an unreviewed high severity finding.

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

## 10. Per-module boundary checklists

**Rule.** The boundary table in `AGENTS.md` is the contract; the checklists below are the
working detail behind it, one section per module: the prohibitions and requirements that the
mechanical boundary rule does not enforce. A reviewer walks the checklist of every module a
change touches.

**Rationale.** Only the provider-SDK edge is mechanically enforced (chapter 2). The rest of the
boundary knowledge lives in prose, and prose that lives nowhere is a rule nobody checks. A
compact checklist per module keeps the review actionable without restating the table it
summarizes.

**How it is held.** Held by review: `REVIEW.md` is the contract for what blocks a merge, and
these checklists are what the reviewer, human or agent, actually verifies module by module.
Nothing mechanical reads this chapter; a checklist item violated is a review finding, not a
build failure, and the difference is the same one chapter 2 states.

### `packages/core/src/analyzer/` (analyzer)

- Owns all LLM API calls through the `LLMClient` abstraction in `client.ts`. Only
  `providers/*.ts` may import an LLM SDK, one SDK per file; `client.ts` is a thin routing layer
  that imports from `./providers/` and never an SDK directly.
- Sharp may be imported only in `batch.ts` (resize before the API call), `dedup.ts` (perceptual
  hash) and `async-batch.ts` (image encoding).
- Batch calls use `detail: 'low'`; reclassification passes use `detail: 'high'`. Every LLM call
  is wrapped in `withRetry()` from `../utils/retry.js`; quota or credit exhaustion throws
  immediately, never retries.
- Failed batch slots are filled with `unknown` placeholders; raw API errors never reach the
  user.
- Perceptual dedup: dHash 9x8, `config.dedupeThreshold` Hamming distance 0 to 64 (0 disables,
  default 8), 60-second burst window, injectable `hashFn`. Temporal consensus:
  `config.temporalWindowMinutes` (default 5) and `config.consensusThreshold` (default 0.6);
  `immune` categories are never overridden.
- Increment `CACHE_SCHEMA_VERSION` in `packages/core/src/types.ts` whenever `AnalysisCache`
  fields change; the migration chain `migrateCache()` in `packages/core/src/store/migrate.ts`
  runs on every cache read.
- A new analysis pass: the function lives in `packages/core/src/analyzer/index.ts`, receives
  `client: LLMClient` as a parameter (never creates clients), and its tests in
  `packages/core/tests/analyzer/` mock `LLMClient`, not SDK constructors.

### `packages/core/src/classifier/` (classifier)

- Pure grouping, sorting and rule evaluation: zero I/O, zero external dependencies, zero side
  effects, deterministic and synchronous on the same input.
- Never import an LLM SDK, Sharp, `fs-extra` or `node:fs`; no `console.log`; return data and
  let callers log.
- Sorting: categories not in `pinnedLast` come first alphabetically; `pinnedLast` categories
  come last in array order; `unknown` is config-driven, never special-cased; empty categories
  are omitted.
- Key functions: `groupByCategory()`, `getSortedCategories()`, `isImmune()`,
  `classifyAndSort()`; all pure, tested without mocks.

### `packages/cli/src/` (cli)

- Commander.js wiring only: parse flags into `RawCliOptions`, call `loadConfig()`, delegate to
  `runBatch`, `runReorder` or `runSingle` from `packages/core/src/index.ts`. No business logic,
  no LLM calls, no image processing; logic that is not pure wiring moves to
  `packages/core/src/index.ts` or `packages/core/src/config/`.
- Never import `sharp`, an LLM SDK, `fs-extra` or any analyzer, processor or classifier module.
  Allowed imports: `config/`, `index`, `utils/logger`.
- Numeric flags (`--batch-size`, `--max-retries`, `--concurrency`) parse with
  `parseInt(value, 10)`; booleans cast with `Boolean(...)`; validation errors log via
  `logger.error()` then `process.exit(1)`; never override a `process.exitCode` set by business
  logic (exit code 2 marks partial failures); the `reorder` subcommand uses
  `REORDER_SENTINEL_KEY` from `packages/core/src/config/index.ts`.
- `packages/cli/src/help.ts` mirrors every flag of `index.ts` in its OPTIONS table (flag, arg
  placeholder, description, default) and carries at least one example per subcommand;
  `console.log` appears only inside `printHelp()`; defaults live in `loadConfig()` and the
  `.option()` call, never duplicated here.
- `runBatch` / `runReorder` / `runSingle` are imported only by `packages/cli/src/index.ts`.

### `packages/core/src/config/` (config)

- Single source of truth for runtime configuration: CLI flags over env vars over `.env` over
  defaults; `Config` is immutable after `loadConfig()` returns (every field `readonly`). No
  business logic here, and no `sharp`, LLM SDK or `fs-extra` imports.
- `categories.json` is validated at load time by `CategoryConfigSchema` (Zod); never bypass it
  with `JSON.parse(...) as CategoryConfig`. Schema invariants: names match
  `/^[a-z][a-z0-9_]*$/`; `pinnedLast`, `immune`, `overridable` entries are defined category
  names or `"unknown"`; `timezone` is a valid IANA zone; at least one category exists. Keep the
  `CategoryConfig` interface in sync with the schema.
- New flag checklist: optional field in `RawCliOptions`, `readonly` field in `Config`, wiring in
  `loadConfig()` (`cliOptions.foo ?? process.env['FOO'] ?? default`), `.option(...)` in
  `packages/cli/src/index.ts`, a row in `packages/cli/src/help.ts`, and the field added to every
  `makeConfig()` fixture in `packages/*/tests/` (never `as Config`). Commonly missed:
  `concurrency: 1`, `estimate: false`, `temporalWindowMinutes: 5`, `consensusThreshold: 0.6`,
  `dedupeThreshold: 0`.
- Keys are validated in `loadConfig()` before it returns, failing fast with the billing URL;
  `validateStartup()` in `packages/core/src/index.ts` rechecks presence; API keys are never
  logged, even at verbose level.
- `computeCategoriesHash()` (SHA-256, 12 hex chars, sorted names) is stored in
  `AnalysisCache.categoriesHash` and `PartialAnalysisCache.categoriesHash` and compared on
  `--skip-analysis` loads; a cache-breaking field change increments `CACHE_SCHEMA_VERSION`.
- Zod `.default([])` returns mutable arrays: treat them as readonly in callers.

### `packages/core/src/` (core modules)

- The boundary table in `AGENTS.md` is the contract. The eslint `no-restricted-imports` rule in
  `eslint.config.js` enforces the provider-SDK edge, and `scripts/check-boundaries.mjs` (run by
  `packages/core/tests/boundaries.test.ts`) proves the rule fires by linting a violating fixture
  and a clean one.
- Only `packages/core/src/analyzer/providers/` may import an LLM SDK; a new module importing one
  anywhere else is a boundary violation.
- Every relative import ends in `.js`, even in a `.ts` file (NodeNext resolution; ADR-001).
- `packages/core/src/utils/logger.ts` is the only sanctioned log sink: files under `packages/**`
  call the logger, never `console.log` (held by review; the linter leaves `no-console` off).
- TypeScript strict; no `any` without an `eslint-disable` comment saying why. The version
  constants describing persisted shapes live once in `packages/core/src/types.ts`:
  `CACHE_SCHEMA_VERSION` and `PLUGIN_API_VERSION`.
- A new module needs its own directory under `packages/core/src/`, a matching test directory
  under `packages/core/tests/` and a row in the `AGENTS.md` boundary table.

### `packages/core/src/plugin/` (plugin)

- The lifecycle hook dispatcher and the only module that loads external user-supplied `.mjs`
  files at runtime; purely dispatch and isolation, no business logic, no LLM SDK or Sharp.
- `loadPlugins()` resolves each path against `process.cwd()`, imports via
  `pathToFileURL(resolved).href` (ESM-safe) and validates the default export is an object with a
  `name: string`; a failed load is logged as a warning and skipped, never thrown.
- Every `fire*` call wraps each plugin in try/catch, warns and continues; hooks run
  fire-and-forget sequential in load order, all return `Promise<void>`; a failed hook is never
  retried and never blocks the run.
- Security: never pass `config.apiKey`, `config.anthropicApiKey` or `config.googleApiKey` to
  hooks; validate plugin paths resolve to an absolute path before import; expose only
  `AnalyzedImage`, `ProcessedResult` and `AnalysisCache`, never the internal `Config`; log the
  resolved path at verbose level, never keys.
- New lifecycle hook: optional method on `Plugin` in `packages/core/src/types.ts` (with JSDoc),
  a matching `fire<HookName>()` in `packages/core/src/plugin/index.ts` following the
  try/catch-per-plugin pattern, the call site in `packages/core/src/index.ts`, tests in
  `packages/core/tests/plugin/index.test.ts` (hook called, hook absent, hook throws isolated,
  multiple plugins all called), `PLUGIN_API_VERSION` bump if breaking, and a
  `packages/cli/src/help.ts` update when user-facing.

### `packages/core/src/processor/` (processor)

- Owns all Sharp image processing; never imports an LLM SDK. The module has no knowledge of
  category names: `skipOverlay: true` is a caller decision from `packages/core/src/index.ts`,
  not a hardcoded category list.
- Output JPEG: `quality: 100`, `chromaSubsampling: '4:4:4'`, `mozjpeg: false`, always
  `.withMetadata()` so EXIF survives.
- Timestamp overlay: red, bold Arial, centered horizontally, 3% gap from bottom; font size via
  `calculateFontSize(height)` with base ratio 3.5%, XL boost x1.4, Large boost x1.25, clamped
  56 to 320 px.
- `calculateFontSize`, `formatTimestamp`, `buildTimestampSvg` and `calculateOverlayPosition`
  are pure (no I/O); keep them that way.
- Output filename `NNN. Photo of category name dated DD-MM-YYYY.jpeg`: numbers zero-padded to 3
  digits, category underscores become spaces. Dry-run mode logs via `logger.verbose()` and
  writes nothing to disk.

### `packages/core/src/reporter/` (reporter)

- Pure output module over `ProcessedResult[]` (HTML, CSV, XLSX): reads data and writes files,
  never calls an LLM, never modifies the cache.
- HTML escaping is mandatory: every embedded field (`category`, `shortDescription`, `elements`,
  `condition`, `originalFile`) goes through a dedicated `escapeHtml()` replacing `&`, `<`, `>`,
  `"`, `'`. No template literals with raw LLM data, no raw `innerHTML` or `document.write`, and
  `originalFile` / `outputFile` paths never become `<a href>` links (path-traversal risk in LLM
  output).
- CSV is RFC 4180: every field double-quoted, internal `"` doubled, fixed header
  `number,file,category,shortDescription,condition,elements,timestamp`, `elements`
  semicolon-joined inside the quoted field.
- Allowed imports: `fs-extra`, `exceljs` (XLSX only, in `xlsx.ts`), `ProcessedResult` from
  `packages/core/src/types.ts`, and the logger. Never an LLM SDK, Sharp, `analyzer/` or
  `classifier/`.
- Tests in `packages/core/tests/reporter/`: XSS tests are mandatory (a result with
  `category: '<script>alert(1)</script>'` must not produce `<script>` in the output); `csv.ts`
  tests as a pure function without mocks.

### `packages/core/src/reviewer/` (reviewer)

- The interactive TTY review loop between the analysis pass and the processing pass in
  `packages/core/src/index.ts`; zero filesystem side effects, mutates only in-memory
  `AnalyzedImage` copies and never the input array.
- TTY guard: when `!process.stdin.isTTY`, return
  `{ images, overrides: [], skipped: [] }` immediately; a CI or piped run never blocks.
- Ctrl-C in `@inquirer/select` or `@inquirer/input` throws; catch it and treat it as `quit`.
  Actions: `accept`, `change` (category validated against `config.categoryConfig.categories`),
  `skip`, `quit`. `ReviewResult` carries the images, the `ReviewOverride[]` audit trail
  (`packages/core/src/types.ts`) and the skipped files.
- Allowed imports: `@inquirer/select` and `@inquirer/input` for TTY interaction, types, the
  `Config` type and the logger; never an LLM SDK, Sharp or `fs-extra`.
- Tests mock the inquirer modules with `vi.mock` at module level, force the TTY guard via
  `Object.defineProperty(process.stdin, 'isTTY', { value: false })`, simulate sessions with
  chained `vi.fn().mockResolvedValueOnce(...)`, and assert a Ctrl-C error resolves rather than
  rejects.

### `scripts/` (scripts)

- Developer-facing TypeScript utilities run with `tsx`; not compiled to `dist/`, never imported
  from `packages/core/src/`, and never importing `packages/cli/src/` (Commander wiring is not
  reusable). Imports from core go only through the public exports of
  `packages/core/src/index.ts`, `packages/core/src/config/index.ts`,
  `packages/core/src/utils/` and `packages/core/src/analyzer/index.ts`.
- All relative imports end in `.js` (NodeNext applies repo-wide); argument parsing stays plain
  `process.argv` (no Commander or yargs as script dependencies).
- Read-only by default: a script that mutates `packages/*/src/` or `packages/*/tests/` prints a
  `[dry-run]` preview first; `process.exit(0)` never appears in a happy path, only
  `process.exit(1)` in error handlers.
- Legacy synthetic benchmark (`scripts/benchmark-legacy.ts`): results in
  `reports/benchmark/<provider>.json` (git-ignored), baseline in
  `packages/core/tests/fixtures/benchmark/baseline.json` (git-tracked, updated with
  `--update-baseline`), regression threshold 5% on precision, recall and unknown rate across
  `openai`, `anthropic`, `google`, `--check-regression` exits 1 on regression. Its numbers are
  synthetic colour swatches and never a product accuracy claim (ADR-008). Real-data artifacts
  live under `benchmarks/` (`benchmarks/results/<runId>/`, `benchmarks/baselines/<suite>.json`,
  `benchmarks/splits/*.gold.json`) behind `vision-lens benchmark run|gate|report`.
- Fixture generators check `access()` before writing (never overwrite an existing fixture), log
  `[fixtures] N images ready in <path>`, and create JPEGs with Sharp at quality 80 to 85 with
  EXIF timestamps carried in the `Copyright` field of `IFD0` (a Sharp API limitation).

### `packages/*/tests/` and `apps/*/tests/` (tests)

- Vitest 4 with globals; tests mirror `src/` as `tests/[module]/[file].test.ts`
  (e.g. `packages/core/tests/analyzer/batch.test.ts` for
  `packages/core/src/analyzer/batch.ts`).
- Mock the `LLMClient` interface from `packages/core/src/analyzer/client.ts` (and
  `AsyncBatchClient` for async batch); never `vi.mock('openai')` or any SDK constructor. Pure
  functions (`classifier/`, `processor/overlay.ts`) need no mocks at all. `packages/cli/src/`
  and `packages/core/src/index.ts` are excluded from coverage and untested by design.
- Every `makeConfig()` and inline Config carries all required fields, never `as Config`: the
  full fixture includes `concurrency: 1`, `estimate: false`, `temporalWindowMinutes: 5`,
  `consensusThreshold: 0.6`, `dedupeThreshold: 0`, `forceSkipAnalysis: false`, `asyncBatch:
  false`, `resumeBatch: false`, `timing: false`, `watch: false`, `watchPoll: false`,
  `interactive: false`, `plugins: []`, `linkImages: false`, `linkWindowDays: 7`. `AnalysisResult`
  fixtures carry `fullDescription: ''`, `confidence: 0`, `extractedText: null`; cache fixtures
  carry `schemaVersion: CACHE_SCHEMA_VERSION` and `categoriesHash`.
- Fake timers only together with `runAllTimersAsync()` or `advanceTimersByTimeAsync()`;
  otherwise pass `delayMs: 0`. Reset mocks with `vi.clearAllMocks()` in `beforeEach` or
  `afterEach`.
- Test the happy path, edge cases (empty input, single image, exact-threshold values), error
  branches (API failure, quota exceeded, malformed JSON, wrong-shape JSON), Zod envelope
  rejection (an object missing the `images` key logs a warning), and pure math exhaustively
  (font clamping, timestamp formatting, SVG dimensions).
- Coverage thresholds in `vitest.config.ts`: lines 75%, functions 85%, branches 75%; the
  exclusion list (CLI wiring, top-level orchestration, the live SDK adapter, integration
  orchestration, config I/O, exporter file I/O, terminal UI) is intentional.

### `packages/core/src/utils/` (utils)

- Pure helpers with no side effects, fully unit-testable without mocks; never import an LLM
  SDK, Sharp or `fs-extra`; no direct `process.exit()` (callers are responsible for exiting).
- `console.log` / `console.error` are allowed only in `logger.ts` and `progress.ts`; everything
  else in the module is side-effect-free.
- `logger.ts`: a single `logger` object (`info`, `success`, `warn`, `error`, `verbose`, `raw`)
  with module-level `_quiet` and `_verbose` set once via `configureLogger()`; no new log levels
  without updating the `LogLevel` type.
- `retry.ts`: `withRetry()` retries with linear back-off; quota errors (OpenAI, Anthropic,
  Google) are never retried; 429 rate-limit errors retry at constant delay; always throw
  `new Error(...)`, never a string; `sleep(ms)` is exported for batch processing.
- `exif.ts`: `getImageTimestamp()` priority EXIF DateTimeOriginal, then birthtime, then ctime;
  dynamic `import('exifr')` keeps the module tree-shakeable; falls through on parse failure,
  never throws.
- `cost.ts`: `PROVIDER_PRICING`, `TOKENS_PER_IMAGE`, `PROMPT_OVERHEAD_TOKENS`,
  `OUTPUT_TOKENS_PER_IMAGE` are module-level `const` exports; `estimateCost()` and
  `formatCostRow()` are pure; `printCostEstimate()` is the only stdout writer here.
