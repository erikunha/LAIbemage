---
name: reporter
paths:
  - packages/core/src/reporter/**
---
# Reporter module rules
## Purpose

`packages/core/src/reporter/` generates HTML, CSV, and XLSX reports from `ProcessedResult[]`.
It is a **pure output module** — it reads data and writes files, never calls any LLM or modifies cache.

## Exports

```typescript
// packages/core/src/reporter/index.ts
export async function generateHtmlReport(
  results: ProcessedResult[],
  outputDir: string,
): Promise<string>;
export function buildCsvContent(results: ProcessedResult[]): string;
export async function writeXlsx(results: ProcessedResult[], outputPath: string): Promise<void>;
```

## Module structure

| File       | Responsibility                                                          |
| ---------- | ----------------------------------------------------------------------- |
| `html.ts`  | Builds the HTML string. All user data must be HTML-escaped before embed |
| `csv.ts`   | Builds RFC 4180-compliant CSV string. Escape commas and newlines.       |
| `xlsx.ts`  | Writes XLSX using `exceljs`. Uses streaming writer for large datasets.  |
| `index.ts` | Re-exports all three. No logic of its own.                              |

## Security rules — CRITICAL

- **HTML escaping is mandatory.** Every `ProcessedResult` field embedded in HTML (`category`, `shortDescription`, `elements`, `condition`, `originalFile`) must be escaped via a dedicated `escapeHtml()` helper that replaces `&`, `<`, `>`, `"`, `'`. Do NOT use template literals with raw LLM data.
- **CSV field quoting.** Every field must be wrapped in double quotes and internal `"` doubled per RFC 4180. Never assume a field is safe.
- `originalFile` and `outputFile` paths must never become clickable `<a href>` links in HTML — they may contain path-traversal sequences returned by a malicious LLM.
- Never pass raw `ProcessedResult` data to `innerHTML` or `document.write`.

## Allowed imports

- `fs-extra` — for file I/O
- `exceljs` — XLSX only, in `xlsx.ts`
- `packages/core/src/types.ts` — `ProcessedResult` only
- `packages/core/src/utils/logger.ts`
- **NEVER** import any LLM SDK, Sharp, `packages/core/src/analyzer/`, or `packages/core/src/classifier/`

## Testing patterns

- `csv.ts` is a pure function — test without mocks (no I/O)
- `html.ts` can be tested as a pure string builder if you extract `buildHtmlReport(results)` → `string`
- XSS tests are mandatory: pass `results` with `category: '<script>alert(1)</script>'` and assert the output does NOT contain `<script>`
- Tests live in `packages/core/tests/reporter/`

## Output format contract

CSV header row (fixed order):

```
number,file,category,shortDescription,condition,elements,timestamp
```

`elements` is serialised as a semicolon-separated list within the quoted field.
