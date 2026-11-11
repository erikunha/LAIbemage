# GitHub Copilot instructions

The canonical instructions for this repository are `AGENTS.md` at the repository root. Read it
first: it holds the build and test commands, the module boundary table, the ESM rule, the key types,
the fixture patterns, the feature checklist, the skill dispatch table and the gates a change must
pass. This file holds only the Copilot-specific facts.

## Where the Copilot surface lives

- Copilot reaches the canonical skills through the relative symlinks in `.github/skills/<name>`,
  which point at `../../.agents/skills/<name>`.
- Copilot's agent adapters live in `.github/agents/<role>.agent.md`, generated from the canonical
  roles in `.agents/agents/<role>.md`. Copilot only reads files named `*.agent.md` in that folder.
- Copilot's path-scoped instruction adapters live in `.github/instructions/<name>.instructions.md`,
  generated from the canonical rules in `.agents/rules/<name>.md`. A Copilot adapter carries one
  `applyTo:` glob string where the Claude Code adapter carries a `paths:` list, so the same rule
  reaches both runtimes from one canonical body.

## Invoking a Copilot agent

In the IDE, a custom agent is picked from the chat agents dropdown or referenced with an `@mention`.
In the Copilot CLI, `/agent` selects one and `--agent <id>` names it. The id is the adapter file
name without its `.agent.md` suffix, for example `code-reviewer` for
`.github/agents/code-reviewer.agent.md`. The `name` in the frontmatter is the display label. The
description is what Copilot reads to decide whether to delegate on its own.

## Regenerating the adapters

- `pnpm run agents:rules` rewrites the instruction adapters, and `pnpm run agents:rules:check` fails
  when one is out of date.
- `pnpm run agents:surface` rewrites the agent adapters, and `pnpm run agents:surface:check` fails
  when one is out of date, when a canonical skill has no Copilot symlink, or when a canonical role
  has no Copilot adapter.
- A hand edit of a generated adapter fails the check. Edit the canonical source and regenerate.

## Gates

The gates a change must pass are named in `AGENTS.md` under "Done means verified":
`pnpm run lint`, `pnpm run typecheck`, `pnpm test`, `pnpm run check:boundaries`, and, for a change to
the agent surface, `pnpm run agents:rules:check` and `pnpm run agents:surface:check`.
