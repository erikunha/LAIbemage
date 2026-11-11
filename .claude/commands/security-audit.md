# Security Audit

Run a targeted security audit of the codebase or a specific change.

**Scope:** $ARGUMENTS (leave blank for full audit, or specify a file/change description)

## Threat model

This tool processes untrusted LLM text responses and writes them to the filesystem.
Primary attack surfaces:

1. **LLM output → filesystem path** — `category` field used in output filenames
2. **Path traversal via `--categories`** — user-supplied JSON path
3. **Prompt injection in cached data** — cached `shortDescription` rendered in HTML/logs
4. **XSS in HTML output** — if `shortDescription`/`elements` written to HTML report

## Audit checklist

### CRITICAL — check these first

- [ ] `packages/core/src/processor/exporter.ts`: Is `category` sanitised before interpolation into filename?
  - Must strip `/`, `\`, null bytes; cap at 100 chars
  - Check: `grep -n "category" packages/core/src/processor/exporter.ts`

- [ ] `packages/core/src/analyzer/batch.ts`: Is parsed `category` validated against the known category list?
  - A raw LLM string should NEVER reach the filesystem without allowlist check
  - Check: `grep -n "category" packages/core/src/analyzer/batch.ts`

- [ ] `packages/core/src/config/index.ts`: Is `--categories` path resolved and validated?
  - Must use `path.resolve()` and optionally check it stays within a trusted base
  - Check: `grep -n "categories" packages/core/src/config/index.ts`

### HIGH

- [ ] `packages/core/src/analyzer/batch.ts`: Is `BatchEnvelopeSchema.safeParse()` used (not bare `JSON.parse as`)?
- [ ] `packages/core/src/analyzer/index.ts`: Is `ReclassifyResponseSchema.safeParse()` used?
- [ ] Any HTML output: Are `shortDescription`, `fullDescription`, `elements` HTML-escaped?
- [ ] `packages/core/src/index.ts` `--skip-analysis` path: Is `cache.images[].originalFile` sanitised before it is used to build a `fullPath` via `path.join(config.inputDir, r.originalFile)`?
  - A crafted cache JSON with `"../../../etc/passwd"` as `originalFile` could escape `inputDir`
  - Fix: validate `originalFile` is a bare filename (no slashes) before use

### MEDIUM

- [ ] `packages/core/src/utils/logger.ts`: Does it ever interpolate LLM data into log messages without truncation?
- [ ] `.env` and `.env.*` (except `.env.example`) listed in `.gitignore`?

### LOW

- [ ] `packages/cli/src/index.ts`: Are all numeric flag values parsed with `parseInt`/`parseFloat`, not coerced?
- [ ] `--output` directory: Is it prevented from pointing to `--input` (would overwrite originals)?

## Output format

List findings as:
- **CRITICAL**: must fix before any production use
- **HIGH**: fix before next release
- **MEDIUM**: fix in next sprint
- **LOW**: track in backlog

For each finding: file:line, description, fix.
