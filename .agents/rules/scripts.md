---
name: scripts
paths:
  - scripts/**
---
# Scripts rules
## Purpose

`scripts/` contains developer-facing TypeScript utilities run with `tsx` (not compiled to `dist/`).
They are NOT part of the production bundle. Never import them from `packages/core/src/`.

## Existing scripts

| Script                           | Purpose                                                            | pnpm alias                    |
| -------------------------------- | ------------------------------------------------------------------ | ----------------------------- |
| `generate-fixtures.ts`           | Creates synthetic JPEG test fixtures in `packages/core/tests/fixtures/images/`   | `pnpm run fixtures`           |
| `generate-benchmark-fixtures.ts` | Creates 24 labelled SYNTHETIC unit-fixture JPEGs in `packages/core/tests/fixtures/benchmark/` | `pnpm benchmark:generate` |
| `benchmark-legacy.ts`            | Legacy SYNTHETIC unit-fixture harness — regression check only, NOT an accuracy source | `pnpm benchmark:legacy`   |
| `gen-readme-flags.ts`            | Auto-generates the CLI flags table in `README.md`                  | `pnpm run readme:generate`    |

## Rules for new scripts

1. **Always use `tsx`** — scripts are `.ts` files run directly; do not compile them
2. **All relative imports must end in `.js`** (NodeNext ESM rule applies everywhere in this repo)
3. **Read-only by default** — scripts that mutate `packages/*/src/` or `packages/*/tests/` must print a `[dry-run]` mode output first
4. **No `process.exit(0)` in happy path** — only `process.exit(1)` in error handlers
5. **Import from `src/`** is allowed (scripts are tools that use the library), but only through public exports in `packages/core/src/index.ts`, `packages/core/src/config/index.ts`, `packages/core/src/utils/`, and `packages/core/src/analyzer/index.ts`
6. **Never import from `packages/cli/src/`** — CLI wiring is Commander-specific and not intended for script reuse
7. **Minimal arg parsing** — use plain `process.argv` parsing; do not add Commander or yargs as deps for scripts

## Legacy synthetic benchmark conventions (`benchmark-legacy.ts`)

These apply to the LEGACY unit-fixture harness only. They are NOT the conventions for the
real-data benchmark (spec 003), whose artifacts live in `benchmarks/results/<runId>/`,
`benchmarks/baselines/<suite>.json` and `benchmarks/splits/*.gold.json` and are produced by
`vision-lens benchmark run|gate|report`.

- Results written to `reports/benchmark/<provider>.json` (git-ignored)
- Baseline stored in `packages/core/tests/fixtures/benchmark/baseline.json` (git-tracked; update via `--update-baseline`)
- Regression threshold: 5% on precision, recall, and unknown-rate
- All three providers compared: `openai`, `anthropic`, `google`
- The `--check-regression` flag must exit with code 1 if any metric regresses
- Its numbers describe the harness over synthetic colour swatches — never quote them as a
  product accuracy claim (ADR-008)

## Fixture generator conventions

- Check `access()` before writing — never overwrite an existing fixture
- Log a summary line: `[fixtures] N images ready in <path>`
- Use Sharp for image creation — JPEG quality 80–85, raw pixel buffer input
- EXIF timestamps via Sharp `withMetadata()` — use `Copyright` field in `IFD0` as a timestamp carrier (limitation of Sharp API)
