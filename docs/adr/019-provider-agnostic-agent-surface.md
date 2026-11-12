# ADR 019 - The agent surface is provider-agnostic, and the repository owns its own skills

| Field    | Value                   |
| -------- | ----------------------- |
| Status   | Superseded by ADR-020   |
| Date     | 2026-11-11              |
| Deciders | @erikunha |

## Context

Vision Lens is used by humans and by coding agents. Until now the repository carried one agent
surface per vendor, and the copies disagreed:

- the project skills lived in `.github/skills/`, a GitHub Copilot convention that neither Claude
  Code nor Codex reads, and none of the ten files had the YAML frontmatter (`name`, `description`)
  the Agent Skills spec requires, so no runtime could load them;
- the Copilot agents in `.github/agents/` and the Claude agents in `.claude/agents/` were two
  generations of the same sixteen roles, both written against the pre-monorepo `src/` layout that
  no longer exists, and both live at the same time;
- the path-scoped instructions in `.github/instructions/` declared `applyTo` globs such as
  `src/analyzer/**`, so ten of the eleven rule sets matched zero files in the repository and were
  silently inert;
- `AGENTS.md`, `CLAUDE.md` and `CONTRIBUTING.md` each restated the same commands, module-boundary
  table, ESM rule and coverage thresholds, and had already drifted apart.

The maintainer's personal skill libraries (`~/Desktop/Projects/claude-skills`, installed at
`~/.minimax/skills`) are a rich set of generic engineering methods, but they are personal: they
bind the maintainer's home directory, credentials and runtime scripts, and they are not part of
this repository.

The sibling repository `portfolio` is the maintainer's current engineering standard. It already
solves the layout problem: canonical skills in `.agents/skills/`, a relative symlink per skill in
`.claude/skills/`, a canonical `AGENTS.md` with `CLAUDE.md` reduced to a pointer, path-scoped
rules, and a guard test that holds the whole surface in place.

## Decision

**The repository owns one canonical agent surface; every runtime reaches it through a thin
adapter; personal tooling stays personal.**

1. **Canonical skills live in `.agents/skills/<name>/SKILL.md`**, with frontmatter limited to the
   Agent Skills spec: `name` (equal to the directory name) and `description` (the routing signal).
   Each provider directory holds a **relative symlink** to the canonical skill, tracked in git as
   mode `120000`: `.claude/skills/<name>` and `.github/skills/<name>` both point at
   `../../.agents/skills/<name>`.
2. **Spec-kit stays personal and local.** `specs/`, `.specify/` and the `speckit-*` skills are a
   personal dev flow, not a property of any repository it runs in (ADR-010). The repository's own
   `.gitignore` does not list them, and the maintainer's global ignore already covers them.
3. **The maintainer's global skill libraries are optional.** The repository must work on a machine
   that has none of them. No tracked file may reference the maintainer's home directory or a
   personal runtime path. Those libraries may be used during development; they are never a
   prerequisite.
4. **`AGENTS.md` is the canonical agent instruction file.** `CLAUDE.md` becomes a thin provider
   adapter pointing at it, so the rules exist once. The same applies to the agent roles and to
   the path-scoped rules: one canonical body per role or rule, adapters per provider.
5. **A gate holds the surface.** A script plus its test prove the contract mechanically: every
   canonical skill has spec-compliant frontmatter, every provider entry is a symlink that resolves
   to the canonical skill, every name referenced by an instruction file exists, and no tracked file
   leaks a provider-specific or personal path. A gate that measures a real property is preferred
   to prose that restates it.

Product-provider references are not affected: the LLM SDKs (OpenAI, Anthropic, Google, Azure,
Ollama, Bedrock, Vertex) are the product's feature set and stay exactly as they are.

The number is 019 because ADR-011 is reserved for the Python-first ML runtime decision
(`docs/vnext/`), so the two never collide.

## Consequences

**Positive:**

- The repository works with Claude Code, with Codex, with Copilot and with any agent that reads
  `AGENTS.md`, because the rules live in one place and the adapters are mechanical.
- A clone no longer depends on the maintainer's machine to be reviewable or to have working
  skills.
- The ten project skills become real, loadable skills instead of documents in a directory no
  runtime reads.
- The Copilot and Claude agent rosters stop being two divergent generations: one role definition
  per role, adapted per provider.
- The personal libraries keep their value during development, without becoming repository policy.

**Negative:**

- Symlinks in git need `core.symlinks` on Windows checkouts. The cost is accepted and the
  canonical content stays in git regardless, so a checkout that does not materialise the link
  loses an adapter, not the skill.
- The agent surface gains a generation step, so a role or rule is edited in one place and the
  adapters are regenerated. The gate makes a forgotten regeneration a failure instead of a drift.
- The rules that used to be repeated in prose now live in one place, so a reader of a single file
  may have to follow a pointer. That is the trade the reference repository made and the reason its
  rules stopped drifting.
