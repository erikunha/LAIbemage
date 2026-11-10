# ADR 010 — Spec-kit material stays out of version control

| Field    | Value                   |
| -------- | ----------------------- |
| Status   | Accepted                |
| Date     | 2026-11-10              |
| Deciders | @erikunha |

## Context

The Master plan is specified with github/spec-kit (v0.15.0, initialized 2026-07): feature
specs, implementation plans, task lists and research live under `specs/` and `.specify/`.
The maintainer's machine enforces this globally: `~/.config/git/ignore` ignores `specs` and
`.specify` in every repository, with the stated rationale that spec-kit is a personal dev
flow, "not a property of any repo it runs in", so adopting it costs a collaborating repo
nothing and reveals nothing.

Adding the same entries to this repository's `.gitignore` would duplicate the global rule and
push a personal-tooling decision into a public repository.

## Decision

`specs/` and `.specify/` are **never tracked, never committed, and not added to the repo's
own `.gitignore`** — the maintainer's global ignore already covers them on every machine the
maintainer clones from. The tracked record of the same decisions is:

- `docs/adr/005+` — every decision that constrains future work (the spec plans cite them);
- `ROADMAP.md` — phase status, spec mapping, milestones (the tracked mirror of spec status);
- `docs/architecture/vision-master.md` and `docs/architecture/baseline-audit.md` — the
  distilled vision and the evidence baseline the specs operationalize.

Bootstrap on a fresh clone: `specify init --here` (and `specify extension add bug` if
desired), then receive specs through the maintainer's dispatch channel. Delegated workers
receive spec material through the dispatch clone, not through git.

AGENTS.md carries a short spec-kit workflow section pointing to this arrangement, and
`.specify/memory/constitution.md` (local) binds spec authoring.

## Consequences

**Positive:**

- Public repository carries durable decisions (ADRs, roadmap) without personal planning
  artifacts, duplicated ignore rules or tool-lock-in for collaborators.
- Spec material can be candid (estimates, open questions, priorities) without becoming a
  public commitment.

**Negative:**

- A fresh clone has no specs and no constitution until bootstrapped; the roadmap's spec IDs
  (001–014) are references, not links, for outside readers.
- CI cannot lint spec files; spec quality rests on the local workflow (speckit analyze) —
  accepted, since specs are inputs to code, not shipped artifacts.
