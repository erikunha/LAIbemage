# Contributing to Vision Lens

Thank you for considering a contribution. This document covers everything you need to go from zero to a passing pull request.

---

## Table of contents

1. [First-time setup](#first-time-setup)
2. [Running commands](#running-commands)
3. [Module boundary rules](#module-boundary-rules)
4. [Adding a new LLM provider](#adding-a-new-llm-provider)
5. [Adding a category example file](#adding-a-category-example-file)
6. [Adding a CLI flag](#adding-a-cli-flag)
7. [Testing](#testing)
8. [Pull request checklist](#pull-request-checklist)
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

`.nvmrc` contains `22` — if you use `nvm` or `fnm`, run `nvm use` / `fnm use` to switch.

---

## Running commands

| Command | Purpose |
|---|---|
| `pnpm run build` | Compile TypeScript → `dist/` |
| `pnpm run typecheck` | Type-check `src/` without emitting |
| `pnpm exec tsc -p scripts/tsconfig.json --noEmit` | Type-check `scripts/` without emitting |
| `pnpm run lint` | ESLint |
| `pnpm run lint:fix` | ESLint with auto-fix |
| `pnpm run format` | Prettier |
| `pnpm test` | Vitest unit tests (fast, no coverage) |
| `pnpm run test:coverage` | Vitest with V8 coverage report |
| `pnpm run fixtures` | Regenerate test fixture images |
| `pnpm run check` | lint + typecheck + test:coverage (the full gate) |

---

## Module boundary rules

Imports between modules are strictly controlled:

| Directory | Allowed imports | Forbidden |
|---|---|---|
| `src/utils/` | Node stdlib only | OpenAI, Sharp, fs-extra |
| `src/analyzer/providers/*.ts` | utils/, config/, types, the single provider SDK for that file | processor/, classifier/, other provider SDKs |
| `src/analyzer/client.ts` | utils/, config/, types, `src/analyzer/providers/` | any LLM SDK directly, processor/, classifier/ |
| `src/analyzer/` (other files) | utils/, config/, types, LLMClient, Sharp (resize only) | processor/, classifier/, any SDK |
| `src/processor/` | utils/, config/, types, Sharp | any LLM SDK, analyzer/ |
| `src/classifier/` | config/, types | any LLM SDK, Sharp, fs-extra |
| `src/cli/` | config/, index, utils/logger | analyzer/, processor/, classifier/ |
| `src/index.ts` | All src/ modules | external packages directly |

`src/analyzer/client.ts` is a thin routing layer — it imports from `src/analyzer/providers/` but must not import any LLM SDK directly. All SDK imports are confined to the per-provider files.

Violations are caught by ESLint and the `code-reviewer` agent.

---

## Adding a new LLM provider

### Step 1: Add the provider name to the union type

In `src/types.ts`, add `'your-provider'` to the `LLMProvider` union:

```typescript
export type LLMProvider =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'azure'
  | 'ollama'
  | 'bedrock'
  | 'vertex'
  | 'hybrid'
  | 'your-provider';  // add here
```

### Step 2: Implement the adapter

Create `src/analyzer/providers/your-provider.ts`. This is the **only** file that may import the provider's SDK:

```typescript
// src/analyzer/providers/your-provider.ts
import YourProviderSDK from 'your-provider-sdk';
import type { Config } from '../../config/index.js';
import type { LLMClient } from '../client.js';

export function createYourProviderClient(config: Config): LLMClient {
  const sdk = new YourProviderSDK({ apiKey: config.yourProviderApiKey });

  return {
    async complete(prompt, images, opts) {
      // Build the request payload using `prompt` and `images`.
      // Return { text: string, tokensUsed: number }.
    },
  };
}
```

### Step 3: Wire the adapter into the routing layer

In `src/analyzer/client.ts`, import the factory and add a branch in the `createClient` switch:

```typescript
import { createYourProviderClient } from './providers/your-provider.js';

// Inside createClient(config):
case 'your-provider':
  return createYourProviderClient(config);
```

### Step 4: Add the API key config

In `src/config/index.ts`:

- Add `readonly yourProviderApiKey: string` to the `Config` interface.
- Read `YOUR_PROVIDER_API_KEY` from the environment in `loadConfig()` and apply CLI flag precedence.
- Add a default model entry in the `DEFAULT_MODEL` map.
- Add the billing URL to the `BILLING_URL` map in `validateStartup()`.

### Step 5: Add CLI flags

In `src/cli/index.ts`:

```typescript
program.option('--your-provider-api-key <key>', 'Your Provider API key');
```

In `src/cli/help.ts`, add an entry to the provider flags table.

### Step 6: Add a contract test

Add the provider to `tests/analyzer/client.contract.test.ts`. Contract tests are skipped unless `CI_CONTRACT=1` is set, so they do not run in normal CI.

### Step 7: Update .env.example and README.md

Add `YOUR_PROVIDER_API_KEY=` to `.env.example` and add the provider to the Quick Start section and provider feature matrix in `README.md`.

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

Category names must be `lowercase_snake_case` — validated by Zod at startup.

Add your file as `examples/categories-<domain>.json` and test it with:

```bash
vision-lens --categories examples/categories-<domain>.json --estimate
```

---

## Adding a CLI flag

1. Add the `readonly` field to the `Config` interface and `RawCliOptions` in `src/config/index.ts`.
2. Parse the env var and provide a default in `loadConfig()`.
3. Add `program.option('--your-flag <value>', 'Description', defaultValue)` in `src/cli/index.ts`.
4. Add an entry to the flags table in `src/cli/help.ts`.
5. Update the CLI reference table in `README.md`.
6. Add the field to all `makeConfig()` fixtures in `tests/` — the fixture pattern requires every Config field to be present.

---

## Testing

- All tests live in `tests/` mirroring `src/`.
- **Mock the `LLMClient` interface** — do not mock individual SDK constructors (`vi.mock('openai')` etc.).
- **Pure functions** (classifier, overlay math, retry logic) need no mocks.
- **Processor tests** that need real JPEG files: use `FIXTURES_DIR` from `tests/fixtures/index.ts`. Run `pnpm run fixtures` first if the directory is absent.
- `src/cli/`, `src/index.ts`, and `src/analyzer/client.ts` are intentionally excluded from coverage (integration territory).

```bash
# Run all tests
pnpm test

# Run a single file
pnpm exec vitest run tests/utils/exif.test.ts

# Run with coverage
pnpm run test:coverage
```

Coverage thresholds (enforced in CI): lines >= 75%, functions >= 85%, branches >= 75%.

---

## Pull request checklist

Before opening a PR, ensure all of the following pass locally:

- [ ] `pnpm run lint` — zero ESLint errors
- [ ] `pnpm run typecheck` — zero TypeScript errors
- [ ] `pnpm exec tsc -p scripts/tsconfig.json --noEmit` — zero TypeScript errors in scripts/
- [ ] `pnpm run test:coverage` — all tests pass, coverage thresholds met
- [ ] No LLM SDK imported outside `src/analyzer/providers/*.ts`
- [ ] No `sharp` imported outside `src/processor/` and `src/analyzer/batch.ts`, `dedup.ts`, `async-batch.ts`
- [ ] All relative imports use `.js` extension
- [ ] No new `console.log` outside `src/utils/logger.ts` and `src/utils/progress.ts`
- [ ] No API keys hardcoded or logged
- [ ] All `makeConfig()` fixtures include every new Config field

---

## Commit message format

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>: <short description>

[optional body]

[optional footer]
```

Types: `feat`, `fix`, `chore`, `test`, `docs`, `refactor`, `perf`

Examples:

```
feat: add --estimate flag for pre-run cost preview
fix: prevent ctime reset on rsync by using EXIF DateTimeOriginal
test: add analyzeBatch unit tests with LLMClient mock
docs: update CLI reference for --concurrency flag
refactor: extract parseAnalysisResult into analyzer/batch.ts
```
