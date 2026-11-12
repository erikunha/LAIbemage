# Contributing a procedure

Covers how to add a new procedure document to `docs/procedures/`: the format, the rules a
procedure must satisfy and how to register it in the index. Use it when a repeatable task in
this codebase deserves a written, step-by-step procedure that any engineer (or agent) can
follow.

Procedures here are plain markdown documents. The procedure itself has no packaging format and
no frontmatter: a file in this directory is the whole procedure. Registering one adds an index
line (step 5) and a thin skill wrapper that only points back at the file (step 6); the wrapper
is a pointer, not packaging of content.

## Steps

### 1. Gather the material

- **Procedure name**: the file slug, `kebab-case` (e.g. `add-provider`, `debug-classification`)
- **What domain does it cover?** One sentence naming the module or workflow
- **When should it be used?** The trigger scenarios, as a reader would recognize them
- **What are the steps?** A rough outline; you structure them
- **A good success example**: optional but preferred, a before/after diff or sample output

### 2. Validate the name

The file name must match `/^[a-z][a-z0-9-]*$/`: hyphens, no underscores, no capitals, no
spaces. One procedure per file; do not split a procedure across files, and do not create a
second file for a task an existing procedure already covers (extend the existing one instead).

### 3. Structure the document

Use this shape:

```markdown
# <Title Case Name>

<One line: what the procedure covers and when to use it. If content from other
guides was folded into this file, say so here.>

## When to use

- <trigger scenario 1>
- <trigger scenario 2>

## Steps

### 1. <Step title>

<Instructions. Be concrete. Reference actual file paths, function names, type names.>

## Example output

<diff, code snippet, or sample output that shows a successful result>
```

### 4. Apply the rules

Every procedure in this directory must:

- Reference actual file paths from `packages/`, `scripts/`, `benchmarks/` and the docs tree,
  not generic placeholders
- Include at least one concrete example (diff, code snippet, or output)
- Be executable by an engineer who has never seen the codebase, without additional context
- Not duplicate what `STANDARDS.md`, `AGENTS.md`, `REVIEW.md` or an ADR already state: link to
  the canonical document instead of restating it
- Stay tool-agnostic: plain engineering prose that does not assume any particular editor,
  agent or harness

### 5. Register the procedure

Add one line to the index table in `docs/procedures/README.md`: the slug and a one-line
description of when to use it.

### 6. Expose the procedure as a skill

Create a thin wrapper at `.agents/skills/<name>/SKILL.md`, modeled on the existing ten: a
frontmatter block (`name` and `description`) and a body that only points at
`docs/procedures/<name>.md`. Add the relative symlink `.claude/skills/<name>` with target
`../../.agents/skills/<name>`. The meta guard (`packages/core/tests/meta/ai-config.test.ts`)
holds this surface 1:1 with `docs/procedures/` in both directions: a procedure without a
wrapper, or a wrapper without a procedure, fails the suite.

### 7. Verify

- Walk the steps as if you were following them cold
- Confirm every file reference exists in the codebase
- Run the checks the procedure itself names (e.g. `pnpm run typecheck && pnpm test`) plus
  `pnpm run docs:check` if the change touched documented configuration, so the new procedure
  does not ship with drift
