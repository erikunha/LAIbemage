
## Features

- **Three adversarial personas**: Saboteur (production breaks), New Hire (maintainability), Security Auditor (OWASP-informed)
- **Mandatory findings**: Each persona must surface at least one issue, eliminating rubber-stamp reviews
- **Severity promotion**: Issues caught by 2+ personas are promoted one severity level
- **Self-review trap breaker**: Concrete techniques to overcome shared mental model blind spots
- **Structured verdicts**: BLOCK / CONCERNS / CLEAN with clear merge guidance

## Usage

```
/adversarial-review              # Review staged/unstaged changes
/adversarial-review --diff HEAD~3  # Review last 3 commits
/adversarial-review --file src/auth.ts  # Review a specific file
```

## Examples

### Example: Reviewing a PR Before Merge

```
/adversarial-review --diff main...HEAD
```

Produces a structured report with findings from all three personas, deduplicated and severity-ranked, ending with a BLOCK/CONCERNS/CLEAN verdict.

## Problem This Solves

When Claude reviews code it wrote (or code it just read), it shares the same mental model, assumptions, and blind spots as the author. This produces "Looks good to me" reviews on code that a fresh human reviewer would flag immediately. Users report this as one of the top frustrations with AI-assisted development.

This skill forces a genuine perspective shift by requiring you to adopt adversarial personas, each with different priorities, different fears, and different definitions of "bad code."

## Table of Contents

1. [Quick Start](#quick-start)
2. [Review Workflow](../SKILL.md#review-workflow)
3. [The Three Personas](personas.md#the-three-personas)
4. [Severity Classification](../SKILL.md#severity-classification)
5. [Output Format](output-and-anti-patterns.md#output-format)
6. [Anti-Patterns](output-and-anti-patterns.md#anti-patterns)
7. [When to Use This](../SKILL.md#when-to-use-this)

## Quick Start

```
/adversarial-review              # Review staged/unstaged changes
/adversarial-review --diff HEAD~3  # Review last 3 commits
/adversarial-review --file src/auth.ts  # Review a specific file
```
