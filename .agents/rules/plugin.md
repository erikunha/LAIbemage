---
name: plugin
paths:
  - packages/core/src/plugin/**
---
# Plugin module rules
## Purpose

`packages/core/src/plugin/` is the lifecycle hook dispatcher for the plugin API introduced in Phase 5.3.
It is the **only** module that loads external user-supplied `.mjs` files at runtime.

## Architecture invariants

- `loadPlugins(paths)` — resolves each path relative to `process.cwd()`, imports via `pathToFileURL(resolved).href` (ESM-safe), validates that the default export is an object with a `name: string` field
- Failed plugin loads are **logged as warnings and skipped** — they never throw or abort the run
- Each `fire*` function iterates all plugins, wraps each call in `try/catch`, and continues even if a hook throws
- Plugin hooks are **fire-and-forget sequential** — they run in load order, one at a time
- `PLUGIN_API_VERSION` from `packages/core/src/types.ts` is logged at load time so plugin authors can detect mismatches

## The Plugin interface (from `packages/core/src/types.ts`)

```typescript
export interface Plugin {
  readonly name: string;
  onImageAnalysed?(result: AnalyzedImage): Promise<void>;
  onImageProcessed?(result: ProcessedResult): Promise<void>;
  onRunComplete?(cache: AnalysisCache): Promise<void>;
}
```

All hooks are optional. A plugin may implement any subset of them.

## Adding a new lifecycle hook

1. Add the optional method to the `Plugin` interface in `packages/core/src/types.ts` with a JSDoc comment
2. Add a corresponding `fire<HookName>(plugins, ...args)` function in `packages/core/src/plugin/index.ts` — follow the existing pattern exactly (try/catch per plugin, warn on error, never throw)
3. Add the call site in `packages/core/src/index.ts` at the correct point in the pipeline
4. Add tests in `packages/core/tests/plugin/index.test.ts` covering: hook called, no hook skipped gracefully, hook throws → error isolated, multiple plugins → all called
5. Increment `PLUGIN_API_VERSION` in `packages/core/src/types.ts` if the interface is breaking
6. Update `packages/cli/src/help.ts` if the new hook changes user-facing behaviour
7. Update `packages/core/tests/fixtures/benchmark/labels.json` — no change needed (plugin is infrastructure)

## Security rules for this module

- **Never** pass `config.apiKey`, `config.anthropicApiKey`, or `config.googleApiKey` to plugin hooks
- Plugin paths come from user CLI input — validate they resolve to an absolute path before importing
- Do not expose internal `Config` to plugins — only pass `AnalyzedImage`, `ProcessedResult`, `AnalysisCache`
- Log the resolved plugin path at `verbose` level but never log API keys

## What NOT to do

- Do not add business logic inside this module — it is purely dispatch/isolation
- Do not make hooks synchronous — all hooks must return `Promise<void>`
- Do not retry failed hooks — one failure → warn + skip, never block
- Do not import any LLM SDK or Sharp here
