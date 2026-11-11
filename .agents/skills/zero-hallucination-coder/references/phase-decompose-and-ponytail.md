# Phase 3: DECOMPOSE and Phase 3.5: PONYTAIL CHECK

## Phase 3: DECOMPOSE

**Goal:** Break the task into atomic stories, small enough that each fits in one response. *(Ralph principle)*

```
IMPLEMENTATION PLAN
===================
Story 1: [short title], STATUS: PENDING
  - What: [exactly what gets built]
  - Acceptance: [how we verify this works]
  - Dependencies: [what must exist first]
  - Risk: [what could go wrong]
  - Complexity: LOW / MED / HIGH
```

**Right-sizing rule:** Each story must be implementable in one response. Split if it needs >300 lines, touches >3 files, or has >2 acceptance criteria.

- **Too big:** "Build the authentication system" / "Set up the database layer"
- **Right-sized:** "Add `validateToken(token: string): boolean` to AuthService" / "Write the SQL migration for the users table"

**Output:** Numbered story list. User confirms or adjusts before execution begins.

## Phase 3.5: PONYTAIL CHECK (runs before every story)

**Goal:** The best code is the code you never wrote. *(Ponytail principle)*

Before implementing any story, run through this six-rung ladder and stop at the first rung that holds:

```
PONYTAIL CHECK: Story [N]: [title]
====================================
Rung 1: Does this code need to exist at all?
  → YAGNI test: required by an acceptance criterion, or speculative?
  → If speculative: KILL IT. Note: "ponytail: skipped [X], YAGNI"

Rung 2: Does the stdlib / language itself already do this?
  → Built-ins: array methods, datetime, pathlib, os, json, re…
  → If yes: USE IT. Note: "ponytail: using stdlib [X] instead of custom impl"

Rung 3: Does a native platform/runtime feature do this?
  → Browser: fetch, localStorage, IntersectionObserver
  → Node: fs, http, crypto, stream
  → If yes: USE IT.

Rung 4: Does an already-installed dependency do this?
  → Check the confirmed [KNOWN] packages from the codebase map.
  → If yes: USE IT.

Rung 5: Can this be a trivial one-liner?
  → If yes: write it inline, no abstraction needed yet.

Rung 6: Write the minimum that works.
  → No premature abstraction. No config systems for one hardcoded value.
  → No base classes for one subclass. No defensive layers for hypothetical futures.
  → Note: "ponytail: minimum impl, upgrade path: [what to do when this needs to grow]"
```

**Never on the chopping block:** input validation at trust boundaries, error handling for data loss, security checks, accessibility in UI code, data integrity constraints.

**Output:** A brief check result showing which rung stopped the search. Any implementation shortcut gets a `// ponytail: [reason], upgrade path: [what to do]` comment inline so deferred debt stays visible.
