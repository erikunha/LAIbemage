# ADR 006 — Monorepo: TypeScript core, Python services, contracts-first

| Field    | Value                   |
| -------- | ----------------------- |
| Status   | Accepted                |
| Date     | 2026-11-10              |
| Deciders | @erikunha |

## Context

The Master pivot (ADR-005) spans two worlds with different toolchains: the existing
TypeScript pipeline (providers, reporters, fs adapters, CLI, SDK — ESM/NodeNext per
ADR-001, 361 tests) and the ML side that only Python serves well (PyTorch with MPS,
scikit-learn, MLflow, LanceDB, LangGraph). Splitting them into separate repositories would
break atomic cross-boundary changes (a contract change would need coordinated releases) and
complicate the "one slice per spec" delivery rule.

Today the repo is a single package: `pnpm-workspace.yaml` exists but carries only
`allowBuilds`; all 67 source files sit under `src/`, and `AGENTS.md` enforces a strict
module-boundary import table.

## Decision

Adopt a **pnpm-workspaces + Turborepo monorepo** with a TypeScript application/domain layer
and Python ML services, glued by versioned contracts:

```
apps/studio          Next.js (spec 010)
apps/api             Fastify HTTP API (spec 009)
packages/core        existing pipeline + data/al/release domain (from src/)
packages/cli         `laib` + `ai-image-labeling` compat bin (spec 001)
packages/sdk         stable re-export surface (from src/sdk.ts)
packages/contracts   Zod schemas, JSON Schemas, OpenAPI — single truth (spec 002)
packages/mcp         MCP server (spec 011)
services/vision      Python: encoders, embeddings, LanceDB (spec 005)
services/training    Python: PyTorch recipes, MLflow, registry (spec 007)
services/agents      Python: LangGraph runtime (spec 012)
```

Rules:

1. **Contracts-first (constitution III).** `packages/contracts` is the only place entities
   and operation schemas are defined. CLI, API, Studio and MCP consume it; none redefines a
   shape. Breaking changes version the contract; generated OpenAPI and JSON Schemas come from
   the same Zod source.
2. **TS↔Python boundary is explicit and versioned.** Python services are invoked through a
   JSON-lines worker protocol (spec 005) whose payloads are declared in contracts; no
   business rule is duplicated across languages. Python-side config schemas are exported as
   JSON Schema from pydantic into contracts (spec 007 FR-002).
3. **Boundaries survive the move.** The `AGENTS.md` module-boundary table is rewritten for
   package paths with the same strictness and enforced by eslint import rules; the ESM
   `.js`-suffix rule (ADR-001) stays.
4. **Python is uv-managed**, one environment per service, MPS-first with CPU fallback; no
   CUDA requirement ever enters the core (ADR-007).
5. **Root stays thin**: root package.json holds tooling (turbo, eslint, commitlint,
   simple-git-hooks); each package owns its tests; CI runs the turbo graph
   (`lint → typecheck → test → build`) with dependent caching and a fast gate under 5 min.

Why Turborepo and not Nx: smaller surface, no generator framework needed for a fixed layout,
first-class pnpm caching. Why keep `packages/core` as one package instead of finer splits:
the existing boundary table already encodes the real seams; premature package-per-module
would multiply config without changing the import graph (constitution IX).

## Consequences

**Positive:**

- Atomic commits across CLI/API/Studio/contracts/services; the parity gate (constitution
  Integration) is testable in one CI run.
- History is preserved via `git mv` (spec 001 research); the 361-test suite keeps running
  throughout the migration, one green commit at a time.
- Python and TS evolve independently behind a stable contract, so MPS/model work never
  destabilizes the CLI.

**Negative:**

- Two toolchains to keep green (vitest + pytest, pnpm + uv); CI cost and local setup grow.
- Turbo adds a caching layer that must be configured honestly (no cache across incompatible
  lockfiles).
- Fine-grained packaging temptation; the boundary table and review discipline are the guard.
