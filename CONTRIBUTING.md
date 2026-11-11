# Contributing to Vision Lens

Thank you for considering a contribution. This document covers everything you need to go from zero
to a passing pull request.

---

## Table of contents

1. [First-time setup](#first-time-setup)
2. [Running commands](#running-commands)
3. [Where the rules live](#where-the-rules-live)
4. [Adding a new LLM provider](#adding-a-new-llm-provider)
5. [Adding a category example file](#adding-a-category-example-file)
6. [Testing](#testing)
7. [Pull request checklist](#pull-request-checklist)
8. [Review and merge](#review-and-merge)
9. [Commit message format](#commit-message-format)

---

## First-time setup

```bash
# 1. Fork and clone
git clone https://github.com/erikunha/LAIbemage.git
cd LAIbemage

# 2. Install dependencies (includes dev deps)
pnpm install

# 3. Copy the example env file and fill in at least one API key
cp .env.example .env
# edit .env → set OPENAI_API_KEY (or ANTHROPIC_API_KEY / GOOGLE_API_KEY)

# 4. Generate test fixture images (100x100 JPEGs used by the test suite)
pnpm run fixtures

# 5. Verify everything passes
pnpm run check
```

`.nvmrc` contains `22`: if you use `nvm` or `fnm`, run `nvm use` or `fnm use` to switch. pnpm is
pinned to `11.0.8` by the `packageManager` field in `package.json`; use that version, and never npm
or yarn.

Shell: the maintainer works in fish on macOS, so a bash `for/do/done` loop pasted into their
terminal fails. Every command in this guide is a plain single command that runs in any shell.

---

## Running commands

| Command | Purpose |
|---|---|
| `pnpm run build` | Compile TypeScript → `packages/*/dist/` |
| `pnpm run typecheck` | Type-check the workspace packages and `scripts/` without emitting |
| `pnpm exec tsc -p scripts/tsconfig.json --noEmit` | Type-check `scripts/` on its own (already part of `pnpm run typecheck`) |
| `pnpm run lint` | ESLint |
| `pnpm run lint:fix` | ESLint with auto-fix |
| `pnpm run format` | Prettier |
| `pnpm test` | Vitest unit tests (fast, no coverage) |
| `pnpm run test:coverage` | Vitest with V8 coverage report |
| `pnpm run check:boundaries` | Proves the LLM-SDK boundary rule fires (ESLint `no-restricted-imports`) |
| `pnpm run test:py` | pytest for the Python services in `services/` |
| `pnpm --filter @vision-lens/cli test:bins` | Golden bin tests for `vision-lens` and the `ai-image-labeling` compat bin |
| `pnpm run fixtures` | Regenerate test fixture images |
| `pnpm run check` | lint + typecheck + test:coverage (the full gate) |
| `pnpm run agents:rules:check` | The path-scoped rule adapters match `.agents/rules/` |
| `pnpm run agents:surface:check` | The agent surface is consistent |

---

## Where the rules live

`AGENTS.md` is the canonical agent instruction file: the module boundary table, the ESM rule, the
key types, the Config and AnalysisResult fixture patterns, the feature checklist and the gates a
change must pass. Read it before you write code.

`STANDARDS.md` holds the engineering bar by chapter, and each chapter names how it is enforced.
`REVIEW.md` holds the review contract: what blocks a merge and what never does. `REVIEW.md` names
the module boundary table in `AGENTS.md` as the contract for what a directory may import.

The rules that apply to the files you are about to touch are path-scoped and live in
`.agents/rules/`. Each runtime gets a generated adapter of the same rule, so there is one copy of
each rule. Read the one that covers your path.

---

## Adding a new LLM provider

The `add-provider` skill carries the full procedure: the SDK dependency, the `LLMProvider` union and
the `DEFAULT_MODEL` entry in `packages/core/src/config/index.ts`, the provider adapter in
`packages/core/src/analyzer/providers/<provider>.ts`, the branch in the routing layer in
`packages/core/src/analyzer/client.ts`, the CLI flag in `packages/cli/src/index.ts`, the flags table
in `packages/cli/src/help.ts`, the key in `.env.example`, the quota error fingerprint in
`packages/core/src/utils/retry.ts`, and the tests.

Two steps the skill does not carry, so do not forget them:

- Add the provider's billing page to the `BILLING_URL` map in `validateStartup()` in
  `packages/core/src/config/index.ts`. It is what the missing-key error points at.
- Add the provider to the contract test in
  `packages/core/tests/analyzer/client.contract.test.ts`. Contract tests are skipped unless
  `CI_CONTRACT=1` is set, so they do not run in normal CI.

When the provider lands, update the supported providers table in `AGENTS.md` and the
`packages/core/src/analyzer/providers/*.ts` and `packages/core/src/analyzer/client.ts` rows of its
module boundary table.

---

## Adding a category example file

Categories are domain-specific JSON files in `examples/`. The schema:

```jsonc
{
  "description": "Human-readable description of the domain",
  "timezone": "Europe/London",
  "categories": [
    { "name": "category_name", "description": "Short description for the LLM prompt" }
  ],
  "pinnedLast": ["payment_receipt"],
  "immune": ["payment_receipt"],
  "overridable": ["unknown"]
}
```

Category names must be `lowercase_snake_case`, validated by Zod at startup. Add your file as
`examples/categories-<domain>.json` and test it with:

```bash
vision-lens --categories examples/categories-<domain>.json --estimate
```

---

## Testing

- All tests live next to the code: `packages/core/tests/`, `packages/cli/tests/`,
  `packages/contracts/tests/`, `apps/api/tests/` and `apps/studio/tests/`. `packages/core/tests/`
  mirrors `packages/core/src/`
- **Mock the `LLMClient` interface**, not individual SDK constructors (`vi.mock('openai')` and
  friends). The adapter interface is the seam
- **Pure functions** (classifier, overlay math, retry logic) need no mocks
- **Processor tests** that need real JPEG files use `FIXTURES_DIR` from
  `packages/core/tests/fixtures/index.ts`. Run `pnpm run fixtures` first if the directory is absent
- Coverage is measured over `packages/core/src/` only; the excluded files (top-level orchestration,
  the LLM integration boundary, the reporter and fs adapters, the terminal UI helper and the
  type-only file) are listed in `vitest.config.ts`

```bash
# Run all tests
pnpm test

# Run a single file
pnpm exec vitest run packages/core/tests/utils/exif.test.ts

# Run with coverage
pnpm run test:coverage
```

Coverage thresholds (enforced in CI): lines >= 75%, functions >= 85%, branches >= 75%.

The path-scoped rule for tests is `.agents/rules/tests.md`. It holds the mocking rules, the
fixture rules and the framework rules in full.

---

## Pull request checklist

Before opening a PR, ensure all of the following pass locally:

- [ ] `pnpm run lint` → zero ESLint errors
- [ ] `pnpm run typecheck` → zero TypeScript errors
- [ ] `pnpm exec tsc -p scripts/tsconfig.json --noEmit` → zero TypeScript errors in scripts/
- [ ] `pnpm run test:coverage` → all tests pass, coverage thresholds met
- [ ] `pnpm run check:boundaries` → the LLM-SDK boundary rule still fires
- [ ] `pnpm run agents:rules:check` and `pnpm run agents:surface:check` → the agent surface is
      consistent (only when you touched it)
- [ ] No LLM SDK imported outside `packages/core/src/analyzer/providers/*.ts` (sole exception:
      `packages/core/src/analyzer/embeddings.ts`, which may import `openai` and
      `@google/generative-ai`)
- [ ] No `sharp` imported outside `packages/core/src/processor/exporter.ts` and
      `packages/core/src/analyzer/batch.ts`, `dedup.ts`, `async-batch.ts`, `router.ts`, `suggest.ts`,
      `index.ts`
- [ ] All relative imports use the `.js` extension
- [ ] No new `console.log` outside `packages/core/src/utils/logger.ts` and
      `packages/core/src/utils/progress.ts`
- [ ] No API keys hardcoded or logged
- [ ] All `makeConfig()` fixtures include every new Config field
- [ ] Every document that describes what changed was updated in the same commit

---

## Review and merge

- A pull request fills every section of the template and cites the gate output that proves the
  change. State what the change does not cover as well as what it does
- `REVIEW.md` is the review contract. Six categories block a merge: correctness, security, data
  integrity, test validity, spec or plan compliance, and documentation truthfulness. Style, naming
  and taste never block
- A finding without a `file:line` on the head commit and a statement of what breaks, and when, is
  dropped
- CI is the authoritative gate. A local green run does not override a red job, and a gate is never
  disabled to merge: the underlying property is fixed instead
- Every blocking finding must be answered before the change lands

---

## Commit message format

Follow [Conventional Commits](https://www.conventionalcommits.org/) with a scope that names the
feature area:

```
<type>(<scope>): <short description>

[optional body]

[optional footer]
```

Types: `feat`, `fix`, `chore`, `test`, `docs`, `refactor`, `perf`

Examples:

```
feat(cli): add --estimate flag for pre-run cost preview
fix(core): prevent ctime reset on rsync by using EXIF DateTimeOriginal
test(analyzer): add analyzeBatch unit tests with LLMClient mock
docs(readme): update CLI reference for --concurrency flag
refactor(core): extract parseAnalysisResult into analyzer/batch.ts
```

Commitlint enforces the format through the `commit-msg` hook. Stage selectively with
`git add <file>` or `git add -u`, never `git add .`, `-A` or `--all`. One logical unit per commit.
