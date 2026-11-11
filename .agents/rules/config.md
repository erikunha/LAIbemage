---
name: config
paths:
  - packages/core/src/config/**
---
# Config module rules
## Purpose

Single source of truth for all runtime configuration. CLI flags > env vars > `.env` > defaults.
Config is immutable after `loadConfig()` returns — all fields are `readonly`.

## Schema validation (Zod)

`categories.json` is validated at load time via `CategoryConfigSchema` in `packages/core/src/config/index.ts`.
Do NOT bypass this with a raw `JSON.parse(...) as CategoryConfig` cast.

Invariants enforced by `CategoryConfigSchema`:
- `categories[].name` must match `/^[a-z][a-z0-9_]*$/` (lowercase snake_case)
- `pinnedLast`, `immune`, `overridable` entries must be defined category names or `"unknown"`
- `timezone` must be a valid IANA timezone string (validated via `Intl.DateTimeFormat`)
- At least one category must be defined

When adding a new field to `CategoryConfigSchema`, also update the `CategoryConfig` interface to keep them in sync.

## Adding a new CLI flag (checklist)

1. Add field to `RawCliOptions` (optional, `?`)
2. Add `readonly` field to `Config` (required, non-optional)
3. Wire in `loadConfig()`: `cliOptions.foo ?? process.env['FOO'] ?? default`
4. Add `.option(...)` to `packages/cli/src/index.ts`
5. Add to `packages/cli/src/help.ts` options table
6. Add the new field to ALL `makeConfig()` fixtures in `packages/*/tests/` — TypeScript will flag missing fields unless `as Config` is used (don't do that). Current full list of required Config fields that are commonly omitted: `concurrency: 1`, `estimate: false`, `temporalWindowMinutes: 5`, `consensusThreshold: 0.6`, `dedupeThreshold: 0`

## Key validation

- Keys validated in `loadConfig()` before returning — fail fast with billing URL
- `REORDER_SENTINEL_KEY = 'reorder-no-key-needed'` used by the `reorder` subcommand to skip key checks
- Never log API keys, even at verbose/debug level
- `validateStartup()` in `packages/core/src/index.ts` rechecks key presence as a belt-and-suspenders guard

## Categories hash

`computeCategoriesHash()` in `packages/core/src/index.ts` computes SHA-256 (12 hex chars) of sorted category names.
Stored in `AnalysisCache.categoriesHash` and `PartialAnalysisCache.categoriesHash`.
Compared on `--skip-analysis` load — warn and suggest re-run if mismatch.

When adding fields to `AnalysisCache` or `PartialAnalysisCache` that would break cache compatibility,
increment `CACHE_SCHEMA_VERSION` in `packages/core/src/types.ts`.

## Do NOT

- Add business logic to this module — it resolves config, nothing more
- Import `sharp`, any LLM SDK, or `fs-extra` in this module
- Use mutable `Config` fields — all must be `readonly`
- Return `CategoryConfig` objects with mutable arrays — Zod `.default([])` returns mutable arrays;
  treat them as readonly in callers
