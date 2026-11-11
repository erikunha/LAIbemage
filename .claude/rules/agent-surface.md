---
paths:
  - .agents/**
  - .claude/**
  - .github/skills/**
  - .github/agents/**
  - .github/instructions/**
---

# Agent surface rules

## One canonical copy

The canonical source of a skill or a rule lives under `.agents/`. A provider directory holds an
adapter, not a second copy:

- `.agents/skills/<name>/SKILL.md` is the skill. `.claude/skills/<name>` and `.github/skills/<name>`
  are relative symlinks to it, tracked in git as mode `120000`.
- `.agents/rules/<name>.md` is the rule. The adapters under `.claude/rules/` and
  `.github/instructions/` are generated from it by `scripts/generate-agent-rules.ts`, because
  the two runtimes read different frontmatter keys.

Two copies drift. One copy with a gate does not.

## What a skill must carry

The frontmatter of a skill holds `name`, equal to the directory name, and `description`, which
is the routing signal and therefore states the trigger. A skill without frontmatter is a
document, not a skill: no runtime loads it.

## What a rule must match

The `paths:` of a rule must match real files. A glob that matches nothing is a silent hole: the
rule looks present and never fires. After changing a path, check that the glob still matches
something.

## Personal material stays out

The spec-kit material (`specs/`, `.specify/`, the `speckit-*` skills) is a personal dev flow and
is not repository content. It is excluded by the maintainer's global git ignore, and the
repository's own `.gitignore` does not list it, so adopting this repository costs a collaborator
nothing and reveals nothing.

A developer's own global skills are optional. The repository works without them, and no tracked
file names a path on one developer's machine.

## The gate

`scripts/check-agent-surface.mjs` holds the layout, and `packages/core/tests/agent-rules.test.ts`
holds the gate. A change to the agent surface that does not regenerate its adapters fails the
check rather than drifting.
