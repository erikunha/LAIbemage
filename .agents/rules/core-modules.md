---
name: core-modules
paths:
  - packages/core/src/**
---

# Core module rules

## Boundary contract

The module boundary table lives in `AGENTS.md`. It is the contract; this file is the guidance
for working inside it. The enforcement is the `no-restricted-imports` rule in `eslint.config.js`,
and `scripts/check-boundaries.mjs` proves that rule fires: it writes a violating fixture, asserts
the linter rejects it and names the allowed directory, asserts a clean fixture passes, and removes
both. `packages/core/tests/boundaries.test.ts` runs that proof.

Only `packages/core/src/analyzer/providers/` may import an LLM SDK. `packages/core/src/analyzer/client.ts`
is the routing layer and imports from `providers/`, never an SDK directly.

## ESM imports

Every relative import ends with `.js`, even in a `.ts` file. The module resolution is NodeNext,
so `import { logger } from './logger.js'` resolves to `logger.ts` and `import { logger } from './logger'`
does not resolve at runtime. This is ADR-001.

## Logging

`packages/core/src/utils/logger.ts` is the only sanctioned sink. A file in `packages/**` does not
call `console.log`; it calls the logger. The rule is held by review, because the linter leaves
`no-console` off.

## Types

TypeScript strict. No `any` without an explicit `eslint-disable` comment that says why. The
version constants that describe the shape of persisted data live once: `CACHE_SCHEMA_VERSION` and
`PLUGIN_API_VERSION` in `packages/core/src/types.ts`.

## What belongs here

A new module needs its own directory under `packages/core/src/`, a matching test directory under
`packages/core/tests/`, and a row in the boundary table in `AGENTS.md`. A new module that imports
an LLM SDK outside `analyzer/providers/` is a boundary violation, and the proof harness will say so.
