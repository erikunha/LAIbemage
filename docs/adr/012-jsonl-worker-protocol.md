# ADR 012 - The JSONL worker protocol is the frozen ML runtime boundary

| Field    | Value                                  |
| -------- | -------------------------------------- |
| Status   | Accepted                               |
| Date     | 2026-11-12                             |
| Deciders | @erikunha (decision delegated to the delivery loop and recorded 2026-11-12) |

## Context

The vnext pack proposed a cross-language, versioned, newline-delimited JSON channel
(`visionlens.worker.v1`) so the TypeScript orchestration can drive a Python ML runtime
without shipping images over JSON (`docs/vnext/adrs/ADR-013-jsonl-worker.md`,
`docs/vnext/adrs/ADR-016-typed-operation-registry.md`, both proposals). ADR-011 already
decided the ownership split: Python owns the ML runtime, TypeScript owns the application,
and the boundary between them is this protocol (`docs/adr/011-python-first-ml-runtime.md`).

The protocol landed code-first across specs 017 and 018: the contract schemas
(`packages/contracts/src/worker/`), the TypeScript host (`packages/core/src/worker/`), the
reference Python worker (`python/visionlens/src/visionlens/worker.py`) and the
cross-language suite all shipped before this tracked decision record existed. This ADR is
the missing record, written as built. It supersedes the pack's proposed ADR-013 and the
transport clause of ADR-016 by ratification, not by overwrite: the pack files stay
proposals (`docs/vnext/00-ADOPTION-NO-OVERWRITE.md:3`), and the field-by-field comparison
that gates every adoption lives in the spec's research file
(`specs/018-jsonl-worker-protocol/research/worker-protocol.md`, section 12).

The number 012 is a deviation recorded in the spec's tasks.md: the spec named
`docs/adr/020-jsonl-worker-protocol.md`, but 020 is taken
(`docs/adr/020-repository-harness-agnostic.md`) and 012 is the lowest free slot that
matches the house numbering.

## Decision

**The frozen `visionlens.worker.v1` JSONL protocol is the only runtime boundary between
TypeScript and Python, and it is versioned independently of the contracts.**

1. Six frame kinds and nothing else: `hello`, `request`, `progress`, `result`, `error`,
   `cancel` (`packages/contracts/src/worker/index.ts`). Every frame is a strict object:
   an unknown field is a malformed frame, never a stripped field.
2. The handshake is a gate, not a greeting. The worker speaks `hello` first (only it
   knows its build, extras, device and frame cap), the host validates the protocol id,
   both majors, the shape and the frame cap before any operation frame is written
   (`packages/core/src/worker/handshake.ts:62`, `:86`).
3. Correlation, seq monotonicity, the at-most-one-result rule and the deadline live in
   the HOST, not in the worker (`packages/core/src/worker/client.ts`).
4. Cancellation is best effort and escalates: cancel frame, grace window, SIGTERM,
   SIGKILL (`packages/core/src/worker/cancel.ts`). The job passes through the
   intermediate `cancel_requested` state to the immutable terminal `cancelled`, and
   every transition lands in the append-only `job_transitions` audit ledger, widened by
   its own numbered migration 0003 with a paired rollback
   (`packages/core/src/store/migrations/0003_job_cancel_requested.sql:67`, `:171`; the
   transition API at `packages/core/src/store/repositories/experiments.ts:119`, `:151`).
   The ledger is append-only by database trigger, not by convention.
5. The launch is hardened at the host: a fixed interpreter allowlist, three host-owned
   pipes and nothing inherited, `shell: false` always, and an asset path travels as an
   argv element, never inside a command string
   (`packages/core/src/worker/host.ts:31`, `:54`, `:87`).
6. Stdout carries frames and nothing else; stderr is captured as structured, timestamped
   log records with secret redaction
   (`packages/core/src/worker/framing.ts:113`, `:142`).
7. Failures carry the frozen ten-code vocabulary with retryable flags. Transient
   failures back off boundedly with full jitter; deterministic invalid input is never
   retried; a failure whose external effects are unknown (a worker death mid-operation)
   is never blind-retried: only an idempotency declaration or a reconciliation that
   proves the failed attempt had no effect unlocks the retry
   (`packages/core/src/worker/client.ts:786`, `:894`).
8. The protocol is a guarded part of the contract package: the frames are manifest
   surface under the breaking-change guard, the JSON Schema for the Python side is
   generated from the same zod schemas (`packages/contracts/contracts/`, refreshed by
   `pnpm --filter @vision-lens/contracts run worker-schema:snapshot`), and the golden
   payloads are seeded from the pack examples
   (`packages/contracts/tests/fixtures/worker/`). The protocol never appears in the
   OpenAPI document: it is a process channel, not an HTTP resource.
9. Versioning: the protocol major lives inside the constant id string, so a major change
   is a different protocol id and a handshake refusal, never a `CONTRACTS_VERSION` bump
   (`packages/contracts/src/worker/protocol.ts:13`). The contracts stay at `1.0.0`; a
   breaking contract change still requires a major bump
   (`packages/contracts/src/version-guard.ts`).

## Deviations from the pack proposal

Every deviation below is also recorded field by field in the spec's research file,
section 12, with the pack line each field came from.

| Pack element | As built | Reason |
|---|---|---|
| Result example carries top-level `status: "succeeded"` | The ratified result envelope omits `status`; the strict schema rejects the pack example with exactly one unrecognized-key issue | DECIDED 2026-11-12, option B: the field is constant, carries zero information, and adopting it would force a MAJOR `CONTRACTS_VERSION` bump (`specs/018-jsonl-worker-protocol/spec.md`, FR-005 note) |
| Operation catalog of eight codes | The wire accepts exactly five (`vision.embed`, `vision.predict`, `dataset.audit`, `eval.run`, `model.train`) | The pack's own request schema allows five; the other three are refused in v1 (FR-016) |
| Error vocabulary of two named codes | Ten frozen codes with retryable flags | The pack names only `UNSUPPORTED_PROTOCOL` and `MISSING_EXTRA`; the rest were authored by the spec and frozen |
| No `hello` or `cancel` schema | Both authored as strict frames; the worker hello speaks first, the host answer carries versions and the frame cap only | The pack gives prose only; the direction follows from what only the worker can know |
| `requestId` as a free string (1 to 128) | Kept, deliberately not a UUIDv7 | The pack's own example is `req_demo_001`; a UUID would be a silent tightening |
| No frame size, nesting or field-count limits | `DEFAULT_MAX_FRAME_BYTES = 1 MiB`, negotiable down in the handshake; the host never buffers an oversized line | The pack requires limits but names no numbers (FR-010) |
| Job lifecycle `CREATED -> QUEUED -> LEASED -> RUNNING -> ... ` with `LOST` and `PARTIAL` | The live seven-state vocabulary plus `cancel_requested`; no `LOST`, no `PARTIAL`, no lease columns | The shipped store and enum were widened additively only where cancellation needs it; heartbeat expiry, leases and partial results belong to the job-queue work |
| ADR number 020 | This file is 012 | 020 was taken by the repository-harness-agnostic decision |

## Unresolved gaps

- No remote HTTP adapter for the worker (ADR-013 marks it optional; not built).
- No typed operation registry owning the five codes (VLN ticket separate; the pack's
  ADR-016 stays a proposal).
- No `LOST`/`PARTIAL` job states, no lease or heartbeat columns: a worker death fails the
  in-flight request as `WORKER_CRASHED`/`worker-died` under the retry policy, and the
  queue layer that needs them does not exist yet.
- No resumability token on the wire, by design: a resumed attempt is a new request with a
  new `requestId` and the same input fingerprint, compared by the job layer (FR-013).
- The generated JSON Schema cannot carry the cross-field `completed <= total` refinement
  of the progress frame; the TypeScript host enforces it on read, and the generated
  schema rejects the structural violations.

## Consequences

**Positive:**

- One frozen wire contract, defined once per language, proven identical by a static
  boundary check (`pnpm run check:owner-boundaries`) and by golden fixtures validated in
  both languages.
- The Python side validates against generated JSON Schema, never a hand-copied second
  implementation, so the two validators cannot drift.
- Cancellation is observable end to end: the protocol ladder stops the process, the store
  records the transition chain, and the audit ledger cannot be edited even by raw SQL.
- The launch surface is closed: a path or shell cannot reach the executable position of
  the worker process.

**Negative:**

- Any frame change is a contract-surface change that must regenerate the committed
  schemas and pass the breaking-change guard, which is deliberate friction.
- The migration-0003 table rebuild touches eight tables whenever it runs, which is the
  price of widening a CHECK in SQLite with foreign keys enforced inside one transaction.

## Evidence

Executed for this change on macOS 25.6 (darwin, arm64), Node v24.22.1, pnpm 11.0.8,
Python 3.x, repository base `9469116c07c4cc552809a96310370ea07284b56f` plus this change's
files; output artifact is the console output of each command, recorded in
`specs/018-jsonl-worker-protocol/research/run-records.md`.

| Gate | Command | Exit |
|---|---|---|
| Contracts plus worker suites | `pnpm exec vitest run packages/contracts packages/core/tests/worker` | 0 (293 tests) |
| Store suites (migration 0003 included) | `pnpm exec vitest run packages/core/tests/store` | 0 (106 tests) |
| Owner boundary check, clean tree and self-proof | `pnpm run check:owner-boundaries` | 0 |
| Type check | `pnpm typecheck` | 0 |
| Lint | `pnpm lint` | 0 |
| Python suite | `pnpm test:py` | 0 (142 tests) |
| Meta guard | `pnpm exec vitest run packages/core/tests/meta/ai-config.test.ts` | 0 (19 tests) |
