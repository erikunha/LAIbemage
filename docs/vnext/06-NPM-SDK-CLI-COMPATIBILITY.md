# npm SDK, CLI and TypeScript package evolution

## Observed baseline

`@vision-lens/sdk` already exists on `feat/visual-lens`; its current `index.ts` re-exports the legacy `@vision-lens/core` APIs. `@vision-lens/cli` exposes both `vision-lens` and `ai-image-labeling` bins; the CLI package currently has `private: true`. Do not advertise them as npm-published until verified.

## Recommended package API

- `@vision-lens/sdk/client`: **lightweight, dependency-minimal** typed HTTP client generated or checked against canonical OpenAPI (browser/Node/edge compatible). No Sharp, Node filesystem, GPU bindings or Python requirement.
- `@vision-lens/sdk/legacy`: explicitly named exports for the existing in-process TypeScript workflow; deprecated slowly with compatibility tests.
- Root `@vision-lens/sdk`: keep current exports until a versioned migration; on a future major version, may point to remote client if migration guide is approved.
- `@vision-lens/react` (optional, not prerequisite): data hooks built on the TS client and TanStack Query; UI components separately versioned.
- `@vision-lens/cli`: canonical user command `vision-lens`; fallback `ai-image-labeling` alias until deprecation decision; no breaking changes to existing flags in F0/F1.
- `@vision-lens/mcp`: tools over same API/domain operation registry, not a second business logic layer.

## Example client (proposed)

```ts
import { VisionLensClient } from '@vision-lens/sdk/client';

const vl = new VisionLensClient({ baseUrl: 'http://127.0.0.1:8787', token });
const dataset = await vl.datasets.create({ name: 'inspection' });
const job = await vl.evaluations.start({
  snapshotId: dataset.snapshotId,
  modelId: 'siglip2-base',
  suiteId: 'classification-v1',
  idempotencyKey: 'demo-check-001'
});
const result = await vl.jobs.wait(job.jobId, { signal: abortController.signal });
```

Design constraints: typed errors (`Unauthorized`, `VersionMismatch`, `BudgetExceeded`, `ResourceUnavailable`, `ValidationError`); `AbortSignal`; bounded exponential retry only on idempotent requests and 429/503; ETag conditional GET; pagination; SSE events with reconnect cursor; response redaction; userland fetch injection for testing.

## CLI examples (proposed future commands)

```bash
vision-lens --input ./photos --output ./sorted  # existing path, preserved
vision-lens datasets import ./dataset --ontology ./ontology.json
vision-lens dataset audit --snapshot snap_123 --format json
vision-lens models list --local
vision-lens eval run --snapshot snap_123 --model siglip2-base --suite class-v1
vision-lens arena compare --runs run-a,run-b
vision-lens agent investigate --snapshot snap_123 --goal 'find hard classes' --dry-run
vision-lens mcp serve --transport stdio
```

CLI commands are proposals; no assertion that they work now. CLI must provide `--json` stable envelopes, `--quiet`, exit-code map (0 success, 2 validation, 3 unavailable, 4 policy, 5 runtime), `--dry-run` for side effects, shell completion and `doctor`. Never leak access keys in debug logs.

## Contract parity

For the same immutable dataset/model/config and deterministic evaluator, compare canonical JSON results across Python SDK, CLI, HTTP, npm SDK and MCP. Allow permitted envelope differences (latency, request ID) but forbid divergent labels, sample IDs, fingerprints and evaluation protocol. Golden fixtures include stale contract, unsupported capability and interrupted jobs.

## Publishing controls

- Build TypeScript packages with ESM + valid `exports`, `.d.ts`, `types`, `files` whitelist and package smoke tests installed in a clean temporary consumer.
- Test Node LTS, browser bundling, no unintended `node:*` import in HTTP client.
- npm provenance and registry credentials via trusted CI identity; no `npm publish` from a contributor branch.
- Maintain package version matrix aligned to schema semver; `@vision-lens/sdk/legacy` deprecates only after documented alternative and usage evidence.
