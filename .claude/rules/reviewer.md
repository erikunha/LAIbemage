---
paths:
  - packages/core/src/reviewer/**
---

# Reviewer module rules
## Purpose

`packages/core/src/reviewer/` implements the interactive TTY review loop (Phase 4.4).
It sits **between the analysis pass and the processing pass** in `packages/core/src/index.ts`.
It has zero side-effects on the filesystem — it only mutates in-memory `AnalyzedImage` objects.

## Contract

```typescript
export async function runInteractiveReview(
  images: AnalyzedImage[],
  config: Config,
): Promise<ReviewResult>;

export interface ReviewResult {
  readonly images: AnalyzedImage[]; // may have category overrides applied
  readonly overrides: ReviewOverride[]; // audit trail of user changes
  readonly skipped: string[]; // files the user skipped (excluded from output)
}
```

`ReviewOverride` is defined in `packages/core/src/types.ts`:

```typescript
export interface ReviewOverride {
  readonly file: string;
  readonly originalCategory: string;
  readonly overriddenCategory: string;
}
```

## Key invariants

- **TTY guard** — if `!process.stdin.isTTY`, return immediately with `{ images, overrides: [], skipped: [] }`. Never block a CI/piped run.
- **Non-destructive** — never modify the original `images` array. Return a new array.
- **Ctrl-C** in `@inquirer/select` or `@inquirer/input` throws — catch it and treat as `quit`
- **Actions:** `accept` (keep as-is), `change` (prompt for new category), `skip` (exclude from output), `quit` (stop reviewing, process remaining as accepted)
- Category input in `change` action must be validated against `config.categoryConfig.categories` before accepting

## Allowed imports

- `@inquirer/select` and `@inquirer/input` — ONLY for TTY interaction
- `packages/core/src/types.ts` types
- `packages/core/src/config/index.ts` — Config type only
- `packages/core/src/utils/logger.ts` — for logging overrides at verbose level
- **NEVER** import any LLM SDK, Sharp, or `fs-extra`

## Test patterns

- Mock `@inquirer/select` and `@inquirer/input` via `vi.mock` at the module level
- Always test the TTY guard by setting `Object.defineProperty(process.stdin, 'isTTY', { value: false })`
- Use `vi.fn().mockResolvedValueOnce(...)` chained calls to simulate a multi-image session
- Test Ctrl-C isolation: mock that throws `new Error('User force closed the prompt')` → should resolve, not reject
