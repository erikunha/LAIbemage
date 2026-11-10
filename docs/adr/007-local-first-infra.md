# ADR 007 — Local-first infrastructure: SQLite, content-hash artifacts, LanceDB, MLflow, MPS

| Field    | Value                   |
| -------- | ----------------------- |
| Status   | Accepted                |
| Date     | 2026-11-10              |
| Deciders | @erikunha |

## Context

The Master platform (ADR-005) runs first on one machine: a MacBook M2 (8–16 GB unified
memory) where the maintainer develops, trains and evaluates. The infrastructure must serve
metadata, binaries, vectors, experiment tracking and training compute without external
services, while leaving a path to a shared deployment later. Existing assets:
`better-sqlite3` is already a runtime optional dependency (ROADMAP.md:555), sharp handles
media, and the reporter/fs ports (H7.6/H7.8) abstract storage.

## Decision

**Local-first defaults, portable seams:**

| Concern | v0 choice | Later/shared mode |
|---|---|---|
| Metadata (entities, jobs, ledger) | SQLite (better-sqlite3, WAL) via spec 002 repos | PostgreSQL behind the same repository interfaces |
| Binaries (images, thumbs, checkpoints) | local filesystem, content-addressed `data/assets/<hash-prefix>/` | S3-compatible storage behind the existing FileRepository port |
| Vectors | LanceDB, one table per (snapshot, encoder) | any ANN engine; index is rebuildable by definition |
| Experiment tracking | MLflow local file store | MLflow server |
| Training compute | PyTorch on MPS, memory-admission backoff, CPU fallback | CUDA only via optional GPU-worker adapters |

Rules:

1. **Every artifact is content-addressed or snapshot-pinned.** Binaries key on sha256;
   derived artifacts (thumbnails, embeddings, metrics reports) record source asset + transform
   + config fingerprint (constitution II/IV). Anything derived is rebuildable; deleting an
   index never loses ground truth.
2. **Memory is a machine limit, not a quota.** Python services check free memory before model
   load and batch admission; batch size and gradient accumulation back off on allocator
   failure (spec 007 FR-004). Nothing reserves GPU/memory "for later".
3. **SAM-family and any CUDA-bound integration is an optional adapter** behind a GPU-worker
   interface — never a hard dependency, never imported by core (spec 014 declarations).
4. **DVC is deliberately deferred**: dataset snapshots (spec 004 manifests + registry) cover
   reproducibility for v0; adding DVC is a later decision with its own ADR if provenance
   needs outgrow content hashes.
5. **Dataset binaries never enter git**; `datasets/registry.json` + manifests record source
   URL, license and checksums (ADR-008).

## Consequences

**Positive:**

- Zero-infrastructure start: `pnpm install && uv sync` yields a working workbench.
- Each seam (repository interfaces, FileRepository port, rebuildable indexes) already points
  at the shared-mode upgrade without a rewrite.
- Content addressing makes caches, dedup and lineage the same mechanism (one hash, three
  jobs).

**Negative:**

- Single writer (SQLite, one API process); acceptable for single-user v0, documented in
  spec 009 edge cases.
- MPS is not bit-deterministic for all ops; spec 007 pins a deterministic-op list, a
  reproducibility tolerance (±0.02 macro-F1) and `--deterministic strict` (CPU) as the escape.
- LanceDB is a younger dependency than SQLite; the rebuildable-by-construction rule is the
  containment.
