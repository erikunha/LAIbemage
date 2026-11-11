# AGENTS.md

Instructions for any coding agent working in this repository, on any runtime. Read it first.

`STANDARDS.md` holds the engineering bar by chapter, `REVIEW.md` what a review reports and what blocks
a merge, `docs/architecture/monorepo-map.md` the workspace map, `docs/adr/` the accepted decisions and
`ROADMAP.md` the phase and spec status. Follow all of them.

Everything a person reads in this repository is written in English: code, comments, commit messages,
pull request bodies and documentation.

## Project

Vision Lens is a TypeScript ESM monorepo that uses LLM Vision APIs to classify, timestamp and
organize images. It is domain-agnostic: the category taxonomy is supplied at runtime through a
`categories.json` file, and the LLM provider is selected at runtime.

`packages/` holds the TypeScript code (`core`, `cli`, `sdk`, `contracts`), `apps/` the user-facing
apps and `services/` the Python services. The workspace map is
`docs/architecture/monorepo-map.md`.

## Build & test commands

Workspace layout, which package owns what, lives in `docs/architecture/monorepo-map.md`.

```bash
pnpm run build          # turbo build: compile workspace packages → packages/*/dist
pnpm run typecheck      # type-check without emitting
pnpm run lint           # ESLint
pnpm run lint:fix       # ESLint with auto-fix
pnpm run format         # Prettier
pnpm test               # Vitest unit tests (fixtures auto-generated via pretest hook)
pnpm run test:coverage  # with V8 coverage report
pnpm run check          # lint + typecheck + coverage (full pre-PR suite)
```

Other gates in this repository:

```bash
pnpm run check:boundaries      # proves the LLM-SDK boundary rule fires
pnpm run test:py               # pytest for services/
pnpm run agents:rules:check    # the path-scoped rule adapters match .agents/rules/
pnpm run agents:surface:check  # the agent surface is consistent
pnpm run readme:check          # the README flag table matches the CLI
```

pnpm is pinned: the `packageManager` field in `package.json` names `pnpm@11.0.8`. Use that version.
The lockfile is the source of truth and CI installs with the frozen lockfile.

**Before any PR:** run `pnpm run lint && pnpm run typecheck && pnpm test` (all must pass), plus
`pnpm run check:boundaries` and, when the agent surface changed, `pnpm run agents:rules:check` and
`pnpm run agents:surface:check`.

## Done means verified

- A claim of done cites the output of the gate that proves it. "Should pass" is not evidence.
- Before a pull request, `pnpm run lint && pnpm run typecheck && pnpm test` must pass. `pnpm run
  check` is the superset (lint, typecheck, coverage). `pnpm run check:boundaries` proves the
  provider-SDK boundary rule still fires. The Python services are covered by `pnpm run test:py`.
- A change to the agent surface regenerates its adapters and then passes the checks: `pnpm run
  agents:rules` and `pnpm run agents:surface`, then `pnpm run agents:rules:check` and `pnpm run
  agents:surface:check`.
- The README flag table has its own generator and check (`pnpm run readme:check`). The check
  currently fails, because the README dropped the generator markers, and CI does not run it.
  `STANDARDS.md` chapter 8 states that gap. Until the markers come back, update the README flag
  table by hand.
- After fixing a finding, re-run the checks that cover the affected files.
- A gate measures a real property. Fix the property, never the gate: no lowered threshold, no
  ignore-list entry, no audit set to `"off"`, no code reshaped to hide it from the checker. A gate
  that cannot be fixed in scope is escalated with the root cause, not merged suppressed.
- A fix needs the regression test that fails before it and passes after it. While fixing a defect,
  never edit an existing test to make it pass: add a new test for the regression and change the
  source. If an existing test is wrong, say why in the change that edits it.
- CI stays the authoritative gate. A local green run does not override a red job.

## Module boundaries

| Directory | Allowed imports | Forbidden imports |
|---|---|---|
| `packages/core/src/utils/` | Node stdlib + chalk, cli-progress, file-type (per current imports) | OpenAI, Sharp, fs-extra |
| `packages/core/src/config/` | utils/, types | any LLM SDK, Sharp |
| `packages/core/src/analyzer/providers/*.ts` | utils/, config/, types, the single provider SDK for that file | processor/, classifier/, other provider SDKs |
| `packages/core/src/analyzer/client.ts` | utils/, config/, types, `packages/core/src/analyzer/providers/` | any LLM SDK directly, processor/, classifier/ |
| `packages/core/src/analyzer/` (client, router, batch, async-batch, dedup, linker, critique, consensus, sessions, embeddings, suggest) | utils/, config/, types, LLMClient; Sharp only in batch.ts, dedup.ts, async-batch.ts, router.ts, suggest.ts, index.ts; embeddings.ts: text-embedding SDKs allowed (openai, @google/generative-ai), pre-existing, routing through providers/ is a queued task (eslint carve-out) | any other LLM SDK directly, processor/, classifier/ |
| `packages/core/src/analyzer/temporal.ts` | config/, types | any LLM SDK, Sharp, I/O |
| `packages/core/src/processor/` | utils/, config/, types, Sharp | any LLM SDK, analyzer/ |
| `packages/core/src/classifier/` | config/, types | any LLM SDK, Sharp, fs-extra |
| `packages/core/src/reviewer/` | utils/, config/, types, @inquirer/* | any LLM SDK, Sharp |
| `packages/core/src/reporter/` | utils/, types, fs-extra, exceljs, drizzle-orm + better-sqlite3 (dynamic import, optional dep) | any LLM SDK, Sharp, analyzer/ |
| `packages/core/src/search/` | utils/, config/, types | any LLM SDK, Sharp |
| `packages/core/src/diff/` | config/, types | any LLM SDK, Sharp, I/O |
| `packages/core/src/store/` | utils/, config/, types, drizzle-orm + better-sqlite3 | any LLM SDK, Sharp |
| `packages/core/src/benchmark/` | utils/, config/, types | any LLM SDK, Sharp |
| `packages/core/src/plugin/` | utils/, types | any LLM SDK, Sharp, fs-extra, analyzer/, processor/ |
| `packages/core/src/fs/` | Node stdlib, cloud SDKs (per adapter) | LLM SDKs, Sharp, analyzer/ |
| `packages/core/src/index.ts` | all `packages/core/src/` modules, plus the utility packages it orchestrates (chokidar, p-limit, @vision-lens/contracts) | any LLM SDK, Sharp |
| `packages/cli/src/` | `@vision-lens/core` subpaths from its exports map (`.`, `/config`, `/utils/logger`, …), commander, chalk | any LLM SDK, core internals not on the exports map, processor/analyzer implementation details |
| `packages/sdk/src/` | `@vision-lens/core` subpaths (re-exports only, semver-stable surface), `@vision-lens/cli` (only for the `./cli` programmatic entry; importing it executes the CLI) | implementation logic, other runtime dependencies |
| `packages/contracts/src/` | zod only | any import from core/, cli/, sdk/, apps/ |
| `apps/*` | `@vision-lens/sdk` (and the API service once it exists, spec 009) | `@vision-lens/core` internals, LLM SDKs |
| `services/*` | Python stdlib + declared pyproject deps (uv) | any TypeScript package import |

`packages/core/src/analyzer/client.ts` is a thin routing layer. It must not import any provider SDK
directly: all SDK imports live in `packages/core/src/analyzer/providers/<provider>.ts`.

`packages/core/src/classifier/` is pure: grouping, sorting and rule evaluation, with zero I/O and no
SDKs. `packages/core/src/reviewer/` needs a TTY and never mutates the cache. `packages/core/src/fs/`
is the `FileRepository` port with its adapters, so all persistent file I/O routes through that
interface.

## ESM import rule

All relative imports must end in `.js` even when the source file is `.ts`:

```typescript
import { logger } from './logger.js'; // correct
import { logger } from './logger';    // WRONG, breaks at runtime
```

## Key types

- `AnalysisResult`: LLM output, `{ category, shortDescription, fullDescription, elements, confidence, extractedText }`
- `FileWithStats` → `AnalyzedImage` → `ProcessedResult`: the progressive enrichment pipeline
- `ProcessedResult`: final per-image record in `analysis_results.json`
- `AnalysisCache` / `PartialAnalysisCache`: on-disk JSON cache
- `AnalysisCache.categoriesHash`: SHA-256 (12 hex) of the sorted category names, detects a
  `categories.json` change on `--skip-analysis`
- `AsyncJobState`: on-disk `analysis_job.json` for `--async` / `--resume`
- `CACHE_SCHEMA_VERSION = 1`: increment when adding or removing `AnalysisCache` fields
- `PLUGIN_API_VERSION = 1`: increment when the `Plugin` interface changes

All fields on `Config`, `CategoryConfig`, `FileWithStats` and `AnalyzedImage` are `readonly`. Do not
mutate them after construction.

## Config fixture pattern (use in every test)

```typescript
function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    inputDir: './input',
    outputDir: './output',
    categoryConfig: {
      categories: [{ name: 'kitchen', description: 'Kitchen area' }],
      pinnedLast: [],
      immune: [],
      overridable: [],
      timezone: 'UTC',
    },
    provider: 'openai',
    apiKey: 'test-key',
    anthropicApiKey: '',
    googleApiKey: '',
    azureEndpoint: '',
    azureApiKey: '',
    ollamaUrl: 'http://localhost:11434',
    bedrockRegion: 'us-east-1',
    bedrockAccessKeyId: '',
    bedrockSecretAccessKey: '',
    vertexProjectId: '',
    vertexLocation: 'us-central1',
    model: 'gpt-4o',
    batchSize: 5,
    maxRetries: 2,
    retryDelayMs: 0,
    delayBetweenCallsMs: 0,
    dryRun: false,
    skipAnalysis: false,
    forceSkipAnalysis: false,
    asyncBatch: false,
    resumeBatch: false,
    outputFormat: 'json',
    logFormat: 'pretty',
    verbose: false,
    quiet: false,
    concurrency: 1,
    estimate: false,
    temporalWindowMinutes: 5,
    consensusThreshold: 0.6,
    dedupeThreshold: 0,
    timing: false,
    filenameTemplate: '{n}. {description} dated {date}.{ext}',
    watch: false,
    watchPoll: false,
    interactive: false,
    plugins: [],
    linkImages: false,
    linkWindowDays: 7,
    selfCritique: false,
    learn: false,
    localModel: 'llava',
    cloudProvider: 'openai',
    localConfidenceThreshold: 0.7,
    embed: false,
    sessionGapMinutes: undefined,
    consensusProviders: undefined,
    webhookUrl: undefined,
    outputBucket: undefined,
    activeLearnQueue: false,
    ...overrides,
  };
}
```

A fixture carries every required field. Never use `as Config` to silence a missing field: it hides
the error that a new required field produces.

## AnalysisResult fixture fields

```typescript
// Do NOT include removed fields: condition, defects, severity, locationWithinCategory
const result: AnalysisResult = {
  category: 'kitchen',
  shortDescription: 'Clean kitchen',
  fullDescription: '',   // max 250 chars; use '' as sentinel default in factories
  elements: ['sink', 'tiles'],
  confidence: 0,         // sentinel default in factories
  extractedText: null,
};
```

## Adding a new feature checklist

1. Update types in `packages/core/src/types.ts` first; increment `CACHE_SCHEMA_VERSION` if cache fields change
2. Add `readonly` CLI flag to `Config` + `RawCliOptions` in `packages/core/src/config/index.ts`, wire `loadConfig()`
3. Add to `packages/cli/src/index.ts` (Commander) and `packages/cli/src/help.ts`
4. Implement logic in the correct `packages/core/src/` module; respect the boundaries above
5. Add tests in `packages/core/tests/` mirroring `packages/core/src/`; update all Config fixtures with new fields
6. Update `README.md` CLI reference table
7. Run `pnpm run check`; all must pass

Two routes have a skill and a prompt that already know the steps: a new LLM provider uses the
`add-provider` skill and a new category uses the `add-category` skill. A cache shape change follows
`.github/prompts/schema-migration.prompt.md`.

## Do NOT

- Import any LLM SDK outside `packages/core/src/analyzer/providers/*.ts` (enforced by eslint `no-restricted-imports`; proven by `pnpm run check:boundaries`; sole documented exception: `embeddings.ts` text-embedding SDKs)
- Import Sharp in `packages/core/src/analyzer/` except in `batch.ts`, `dedup.ts`, `async-batch.ts`
- Hardcode category names outside `examples/*.json` and test fixtures
- Use `any` type without an `// eslint-disable-next-line @typescript-eslint/no-explicit-any` comment
- Add `console.log` outside `src/utils/logger.ts` and `src/utils/progress.ts`
- Embed LLM output in HTML without HTML-escaping (XSS risk)
- Write directly to `analysis_results.json`; always write-temp + rename

## Supported LLM providers

`LLMProvider` is the union in `packages/core/src/config/index.ts`. The defaults below are the
`DEFAULT_MODEL` map in the same file.

| Provider | Default model | Credential |
|---|---|---|
| `openai` | `gpt-4o` | `OPENAI_API_KEY` |
| `anthropic` | `claude-opus-4-7` | `ANTHROPIC_API_KEY` |
| `google` | `gemini-2.0-flash` | `GOOGLE_API_KEY` |
| `azure` | `gpt-4o`, or the model named by `--azure-deployment` | `AZURE_API_KEY` and `--azure-endpoint` |
| `ollama` | `llava` | none; `--ollama-url` defaults to `http://localhost:11434` |
| `hybrid` | `llava` for tier 1 | none of its own; the cloud provider is `--cloud-provider` (default `openai`) |
| `bedrock` | `anthropic.claude-opus-4-7-20250514-v1:0` | AWS IAM: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `--bedrock-region` |
| `vertex` | `gemini-2.0-flash` | GCP ADC: `--vertex-project`, `--vertex-location` |

`hybrid` runs tier 1 on the local Ollama model (`--local-model`) and escalates low-confidence images
to the cloud provider. `ollama`, `hybrid`, `bedrock` and `vertex` are keyless providers, so no API
key check runs for them. `BILLING_URL` in the same file is the billing page each provider's missing
key error points at.

## LLM client patterns

- All LLM calls go through the `LLMClient` interface in `packages/core/src/analyzer/client.ts`
- Wrap every LLM call in `withRetry()` from `packages/core/src/utils/retry.ts`
- Use `detail: 'low'` for batch analysis and `detail: 'high'` for reclassification passes
- Quota and credit errors must not be retried (handled in `packages/core/src/utils/retry.ts`)
- Always validate the LLM JSON response shape with Zod before accessing fields
  (`BatchEnvelopeSchema` in `packages/core/src/analyzer/batch.ts`)

## Category system

- Default config: `examples/categories.json`; validated via `CategoryConfigSchema` at load time
- `immune`: never overridden by temporal consensus
- `overridable`: can be overridden by temporal consensus (threshold set via `--consensus-threshold`, default 0.6)
- `pinnedLast`: sorted to the end of the output
- Category names must be `lowercase_snake_case`, enforced by the Zod schema

## Plugin system

- External plugins are `.mjs` files loaded via `--plugin <path>`
- Interface: `{ name: string, onImageAnalysed?, onImageProcessed?, onRunComplete? }`
- All hooks are optional and async; failures are caught and logged, never aborting the run
- `PLUGIN_API_VERSION = 1`; a plugin should assert this at load time
- Never pass API keys or the full `Config` object to a plugin hook

## Async batch workflow

- `--async`: submit the images to the provider's Batch API, write `analysis_job.json`, exit
- `--resume`: read `analysis_job.json`, poll until complete, collect the results, then process normally
- Supported for async: `openai` (Batch API) and `anthropic` (Message Batches)
- On `status: 'failed'`: delete `analysis_job.json` and re-run without `--async`

## Security rules

- Never hardcode API keys in source files; use env vars or the provider-specific CLI flag
- Validate the API key presence at startup with an error pointing at the provider's billing page
- Do not log API keys, not even at verbose level
- The HTML reporter escapes every LLM-sourced field before embedding it (XSS risk)
- A plugin path is resolved to an absolute path before the dynamic import
- Validate a `category` against the known category list before using it as a filesystem path

## Testing conventions

- Tests live next to the code: `packages/core/tests/`, `packages/cli/tests/`,
  `packages/contracts/tests/`, `apps/api/tests/` and `apps/studio/tests/`. `packages/core/tests/`
  mirrors `packages/core/src/`
- Mock the `LLMClient` interface, not individual SDK constructors (`vi.mock('openai')` and friends)
- Pure functions (classifier, overlay math, retry logic) need no mocks
- Processor tests that need real JPEG files use `FIXTURES_DIR` from
  `packages/core/tests/fixtures/index.ts`; run `pnpm run fixtures` first if the directory is absent
- Coverage is measured over `packages/core/src/` only. The excluded files (top-level orchestration,
  the LLM integration boundary, the reporter and fs adapters, the terminal UI helper and the
  type-only file) are listed in `vitest.config.ts`
- Coverage thresholds: lines 75%, functions 85%, branches 75%

## The agent surface

The repository owns one canonical agent surface. Every runtime reaches it through a thin adapter, so
the rules exist once and a second copy cannot drift.

- **Canonical skills** live in `.agents/skills/<name>/SKILL.md`, one directory per skill, with
  frontmatter carrying `name` (equal to the directory name) and `description` (the routing signal).
  Every runtime reaches a skill through a relative symlink in its own directory:
  `.claude/skills/<name>` and `.github/skills/<name>` both point at `../../.agents/skills/<name>`,
  and git tracks each link as mode `120000`
- **Canonical path-scoped rules** live in `.agents/rules/<name>.md`. Each runtime gets a generated
  adapter, because the two read different frontmatter keys: Claude Code reads a `paths:` list and
  GitHub Copilot reads a single `applyTo:` glob string. Regenerate with `pnpm run agents:rules` and
  verify with `pnpm run agents:rules:check`
- **Canonical agent roles** live in `.agents/agents/<role>.md`, with a provider-neutral `tools:` list.
  The adapters in `.claude/agents/` and `.github/agents/` are generated from them, because the
  runtimes name their tools differently. Regenerate with `pnpm run agents:surface` and verify with
  `pnpm run agents:surface:check`

The guards that keep the surface honest are `scripts/check-agent-surface.mjs` (run by
`pnpm run agents:surface:check`) and the rule adapters check (`pnpm run agents:rules:check`), with
their tests in `packages/core/tests/agent-surface.test.ts` and
`packages/core/tests/agent-rules.test.ts`. They fail closed: a hand edit of a generated adapter does
not match its canonical source and the check fails, a canonical skill with no provider symlink
fails, a canonical role with no adapter fails, and a rule whose `paths:` glob matches no file fails,
because a glob that matches nothing is a silent hole.

The rules themselves are readable per surface: `.agents/rules/core-modules.md`, `analyzer.md`,
`config.md`, `cli.md`, `plugin.md`, `processor.md`, `reporter.md`, `reviewer.md`, `scripts.md`,
`tests.md`, `utils.md`, `classifier.md` and `agent-surface.md`.

The runtime-specific pointers sit next to this file and carry nothing but the facts of their own
runtime: `CLAUDE.md` for Claude Code and `.github/copilot-instructions.md` for GitHub Copilot.

## Skill tiers

- **PROJECT skills** are tracked in this repository under `.agents/skills/` and are specific to this
  codebase: the provider, category, prompt, benchmark, search and plugin procedures, plus the
  procedure for writing a new skill
- **VENDORED METHOD skills** are tracked in this repository under `.agents/skills/` as well, but
  they are generic engineering methods rather than project-specific knowledge. There are
  twelve: `adversarial-reviewer` (hostile-persona review), `definition-of-done` (compile
  observable acceptance criteria), `env-secrets-manager` (audit `.env` files and environment
  hygiene), `error-handling` (typed errors, retries, circuit breakers), `focused-fix`
  (systematic repair of one feature end to end), `monorepo-navigator` (cross-package impact
  analysis), `performance-profiler` (CPU, memory and I/O profiling), `self-review-before-push`
  (the orchestrated review before a push), `senior-architect` (architecture patterns and
  decision frameworks), `ship-gate` (the pre-production audit), `tech-debt-tracker` (find and
  score technical debt) and `zero-hallucination-coder` (ground every claim in verified
  structure)
- **PERSONAL skills** are a developer's own machine-level library. They are not tracked here, they
  are optional, and they are never a prerequisite for working in this repository. Nothing in this
  repository assumes they exist, and no tracked file names a path on one developer's machine

A project skill wins over a vendored method on the same surface, and a personal skill never becomes
a second source of truth about this codebase.

## Skill dispatch

A skill supplies the method for one surface. Read its `description` before running it, and a skill
that does not apply is not run. The table is a routing aid, not an index: `.agents/skills/` holds
the complete registry, and a skill that is not listed here is still available.

| Trigger | Skill |
| ------- | ----- |
| A new LLM vision provider is added: SDK dependency, provider factory, CLI key flag, quota detection, tests | `add-provider` |
| A category is added to a `categories.json` taxonomy, or the `immune`, `overridable` or `pinnedLast` behaviour changes | `add-category` |
| The unknown rate is high, two categories confuse each other, or a new image domain needs prompt guidance | `tune-prompt` |
| Images land in the wrong category, results differ between runs or providers, or consensus overrides a correct label | `debug-classification` |
| Hundreds or thousands of images go to a provider batch API, or a submitted batch is collected later | `async-batch` |
| A run was interrupted (Ctrl-C, OOM kill, network failure, power loss) and must resume without losing or re-paying for images | `recover-partial-run` |
| A benchmark has run and the report must be read: accuracy against the baseline, precision, recall, unknown rate, cost, latency | `interpret-benchmark` |
| The classified collection is searched by description or concept, or the embedding index is built or misbehaving | `search` |
| An external `.mjs` lifecycle plugin is written: hooks, secrets, I/O isolation, unit tests, dry run | `write-plugin` |
| Domain knowledge is packaged as a reusable skill, or a skill is registered so the runtimes can discover it | `create-skill` |
| A push or publish is imminent and the change must be reviewed against the gates and the running product | `self-review-before-push` |
| A diff needs a hostile-persona review pass, with two independent reviewers in the dual-pass mode | `adversarial-reviewer` |

## Agent roster

The canonical role definitions live in `.agents/agents/<role>.md`, one file per role. Each runtime
gets a generated adapter, so the roster is the same set of roles everywhere.

| Role | When to invoke |
|---|---|
| `contributor` | Default for all coding work |
| `code-reviewer` | Code audit before merge |
| `security-auditor` | Threat model audit |
| `dx-engineer` | CLI UX audit |
| `dependency-auditor` | Supply chain audit |
| `refactoring-guardian` | Structural refactor |
| `migration-engineer` | Breaking changes |
| `test-author` | Unit test coverage |
| `data-integrity` | Cache write safety |
| `analyzer-tuner` | LLM prompt quality and cost |
| `performance-profiler` | Sharp and batch profiling |
| `plugin-author` | External plugin scaffolding |
| `incident-responder` | Production crash recovery |
| `category-architect` | Domain taxonomy design |
| `docs-writer` | README and CLI reference |
| `release-engineer` | Versioning and publish |
| `explore` | Read-only codebase questions |

## Git and pull requests

- Commits follow Conventional Commits (`type(scope): subject`). The scope names the feature area
  (`analyzer`, `cli`, `reporter`, `config`, `docs`, `ci`). Commitlint enforces the type and the
  subject form through the `commit-msg` hook; the scope is the convention, not a gate
- One logical unit per commit. A commit that changes two things is two commits
- Stage selectively: `git add <file>` or `git add -u`. Never `git add -A`, `git add .` or
  `git add --all`
- The git hooks come from `simple-git-hooks` in `package.json`: `pre-commit` runs lint-staged (ESLint
  and Prettier on the staged TypeScript), `pre-push` runs `pnpm run typecheck && pnpm test`, and
  `commit-msg` runs commitlint
- A pull request fills every section of the template, cites the gate output that proves the change,
  and names what it does not cover. `REVIEW.md` defines what blocks a merge and what never does
- Never push straight to the protected branch, and never merge your own pull request
- No em dash (U+2014), en dash (U+2013) or figure dash (U+2012) appears in anything a person reads:
  a commit subject, a commit body, a pull request title, a pull request body, a comment, a document
  or a log line a user sees. A comma, a colon, a full stop or parentheses do the same job
- The tracked mirrors of the planning work are `docs/adr/` (the decisions) and `ROADMAP.md` (the
  phase and spec status). Update every document that describes what changed in the same commit

## Evidence and accuracy claims

The real-data benchmark is the only source of an accuracy number (`STANDARDS.md` chapter 4, ADR-008).
Its artifacts are `benchmarks/results/<runId>/` (JSON and Markdown), `benchmarks/baselines/<suite>.json`,
`benchmarks/splits/*.gold.json` and `datasets/registry.json`, produced by
`vision-lens benchmark run|gate|report`.

`scripts/benchmark-legacy.ts` is the legacy synthetic harness: a unit-fixture regression harness over
colour-swatch fixtures. It is not an accuracy source and must never be quoted as one. Its package
script is `benchmark:legacy`, its fixtures are under
`packages/core/tests/fixtures/benchmark/`, its baseline is tracked, and it updates with the
`--update-baseline` flag after an intentional improvement.

Never state an accuracy number in code, in a document or in a pull request body unless it comes from
a `benchmarks/results/<runId>/` artifact.

## Subcommands

- `search`: semantic or keyword search over classified images; semantic mode needs `--embed`
- `diff <before> <after>`: compare two `analysis_results.json` files
- `suggest-categories`: sample images and ask the LLM to propose a `categories.json` taxonomy

## Spec-kit workflow

The Vision Lens evolution (ADR-005+) is planned with spec-kit. Specs, plans, tasks and research
live under `specs/` and `.specify/` and are **never tracked in git** (ADR-010; the maintainer's
global git ignore enforces it). The constitution binding every spec is
`.specify/memory/constitution.md` (local only).

Route a feature needing a written spec through speckit in order: **specify, clarify, plan, tasks,
implement, analyze**; each step reads the previous output. The tracked mirrors of the plan are
`docs/adr/` (decisions, numbering continues at 005) and `ROADMAP.md` (phase and spec status). The
spec index with the phase map (F0 to F5, specs 001 to 014) is `specs/README.md`.

When implementing from a spec: honor the constitution principles (evidence over vibes,
Prediction is not Annotation, full-config fingerprints, calibrated uncertainty, untrusted visual
content, cost as a first-class metric), keep the six quality gates green, and update every document
that describes what changed in the same commit.
