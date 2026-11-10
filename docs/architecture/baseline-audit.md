# Baseline Audit — 2026-11-10

> Evidence base for the Master rebirth (ADR-005). Static + executed analysis; no behavioral
> claims beyond what the suite and source show. Branch: `feat/master-rebirth` (base
> `origin/main` @ 027d1c8).

## Product baseline

Single TypeScript ESM package `ai-image-labeling` v0.0.1 (bin → `dist/cli/index.js`),
~7,890 LOC across 67 files; Node ≥ 18, pnpm@11. Test baseline (executed 2026-11-10):
**361 passed, 3 skipped, 33 files, 4.86s, exit 0** (`pnpm test` = `vitest run`, fixtures via
pretest hook).

## Code map and fate in the target architecture

| Module | Responsibility | Fate (spec) |
|---|---|---|
| `src/analyzer/providers/*` (7: openai, anthropic, google, vertex, bedrock, azure, ollama) | provider SDKs behind schemas | preserve → `packages/core` (ADR-006 rule 3) |
| `src/analyzer/{router,consensus,critique,linker,temporal,sessions,dedup}.ts` | hybrid routing, consensus, critique, linking, sessions, dHash dedup | preserve; consensus v2 replaces declared-confidence rule (006) |
| `src/analyzer/embeddings.ts` + `src/search/*` | text embeddings + keyword/cosine index | preserve for text search; visual embeddings supersede scale plans (005) |
| `src/analyzer/{batch,async-batch}.ts`, `src/index.ts` (runBatch ~800 L) | orchestration | preserve; carve up into domain services (002/004) |
| `src/reporter/{port,adapters/factory}` | reporter port/adapter (H7.6) | preserve as pattern reference |
| `src/fs/{port,node,s3,gcs,azure,memory}` | FileRepository port (H7.8) | preserve; becomes artifact store seam (ADR-007) |
| `src/processor/*` (reorder/overlay/exporter) | output pipeline | preserve; exports corrected (004) |
| `src/classifier/rules.ts`, `src/reviewer/*`, `src/plugin/*`, `src/diff/*` | rules, interactive review, plugins, diff | preserve; reviewer grows into AL queue UI (008/010) |
| `src/utils/{sanitize,cost,exif,retry,logger,webhook,mime,...}` | utils | preserve; cost feeds ledger (013) |

Architecture strengths to keep: ports/adapters discipline, AGENTS.md boundary table, atomic
writes everywhere (H7.10), readonly data (H7.9), contract tests per provider, mutation
testing on pure logic, commitlint + hooks.

## Verified defects (driven into specs)

| # | Defect | Evidence | Fixed by |
|---|---|---|---|
| D1 | Cache fingerprint hashes only category names — description/model/prompt changes leave stale caches | `src/index.ts:77-83` (`computeCategoriesHash`) | fingerprint v2 (002, ADR-008) |
| D2 | Consensus winner = higher self-declared confidence | `src/analyzer/consensus.ts:53-54` | calibration + agreement policy (006, ADR-008) |
| D3 | Benchmark ground truth is synthetic colour swatches | `tests/fixtures/benchmark/labels.json:2` (self-described) | VisA real benchmark (003, ADR-008) |
| D4 | `--learn` is few-shot prompt injection, not learning | `src/cli/index.ts:99`, ROADMAP.md:170-173 | real training (007); `--learn` stays during deprecation window |
| D5 | Planned YOLO export writes artificial full-image boxes for classification | ROADMAP.md:378 (H12.2) | Ultralytics per-class/split directory layout (004) |
| D6 | "No GUI / no HTTP" stance blocks the platform surfaces | ROADMAP.md:566-567 | superseded by ADR-005 |

Also noted: `--active-learn` (`src/cli/index.ts:120`) already writes a low-confidence queue —
the seed 008 grows into the real flywheel. Existing `active_learning_queue.json` and
`analysis_history.json` concepts map to 002 entities (FeedbackEvent, ExperimentRun lineage).

## Gaps vs Master vision

No visual embeddings/encoders (005) · no training/registry (007) · no calibration anywhere
(006) · no data-quality engine (004) · no HTTP API/Studio/MCP (009-011) · no agents (012) ·
no release gates/observability/drift (013) · flat JSON caches instead of the entity store
(002) · single package instead of the monorepo (001).

## Risks

| Risk | Containment |
|---|---|
| Big-bang restructure breaks the working CLI | git-mv migration, 361 tests green at every commit (001 research) |
| MPS memory limits on M2 (8-16 GB) | memory admission + backoff (007 FR-004), encoder size budget (005) |
| Provider cost variance skews arena comparisons | per-run cost ledger keyed by run (006/013), utils/cost.ts preserved |
| Scope explosion | phases F0-F5, each spec ships a slice, frontier declared not built (014) |
| Injection via image text/OCR | ADR-009 untrusted-content policy, no exec surface in MCP (011) |
