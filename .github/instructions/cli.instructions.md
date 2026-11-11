---
applyTo: 'packages/cli/src/**'
---

# CLI module rules
## Purpose

Commander.js wiring only. No business logic, no LLM calls, no image processing.
The CLI parses flags, builds a `RawCliOptions` object, calls `loadConfig()`, then delegates to
`runBatch`, `runReorder`, or `runSingle` from `packages/core/src/index.ts`.

## Module boundary (BLOCK on violation)

- NO imports of `sharp`, any LLM SDK, `fs-extra`, or any analyzer/processor/classifier module
- NO business logic — move any logic that is not pure CLI wiring to `packages/core/src/index.ts` or `packages/core/src/config/`
- Allowed imports: `config/`, `index`, `utils/logger`

## Key files

### `index.ts`

- All flags defined with `.option()` on the root program or a subcommand
- Numeric flags (`--batch-size`, `--max-retries`, `--concurrency`) parsed with `parseInt(value, 10)` before passing to `loadConfig()`
- Boolean flags use Commander's default `false` and are cast with `Boolean(opts['flag'])`
- Error handling: catch → `logger.error(message)` → `process.exit(1)` (validation errors)
- Never override `process.exitCode` set by business logic (e.g., exit code 2 for partial failures)
- Use `REORDER_SENTINEL_KEY` from `packages/core/src/config/index.ts` for the `reorder` subcommand's API key

### `help.ts`

- Custom `printHelp()` printed when `--help` / `-h` is passed
- Mirrors every flag in `index.ts` — keep them in sync
- OPTIONS table columns: flag, arg placeholder, description, default value
- EXAMPLES section must include at least one example per subcommand

## Adding a new flag

1. Add `.option(...)` in `packages/cli/src/index.ts`
2. Parse the value correctly (parseInt for numbers, Boolean for booleans, string as-is)
3. Pass it in the `loadConfig(...)` call within the relevant action handler
4. Add a row to the OPTIONS table in `packages/cli/src/help.ts`
5. Add or update an example in the EXAMPLES section if user-facing

## Do NOT

- Add `console.log` outside of `printHelp()` — use `logger` from `utils/logger.js`
- Duplicate default values here — defaults live in `loadConfig()` and the Commander `.option()` call
- Import `runBatch` / `runReorder` / `runSingle` anywhere except `packages/cli/src/index.ts`
