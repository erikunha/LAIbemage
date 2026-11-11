---
name: ship-gate
description: "Use when running the pre-production codebase audit: security, database, deployment, quality, AI/LLM, dependency, frontend"
license: MIT
metadata:
  author: Rajaraman Arumugam
  version: 1.0.0
disable-model-invocation: true
---

# Ship Gate

Pre-production audit that scans a codebase and reports pass/fail/manual
across 8 categories before anything ships.

## Intercept Behavior

When the user says "push to production", "deploy", "ship it", "go live",
or similar deploy-intent phrases, do NOT proceed with deployment. Instead:

1. Ask: "Have you run the ship gate? Want me to scan now?"
2. If yes, run the full audit below.
3. If the user says they already ran it, ask when. If more than 24 hours
   ago or if code changed since, recommend re-running.

## How It Works

### Step 1: Detect Stack

Detection rules for framework, database, deploy target, auth and AI/LLM live in [stack detection](references/stack_detection.md). Report the detected stack before proceeding; it determines which checks are relevant.

### Step 2: Run Automated Checks

Run categories in this order: SEC, DB, CODE, DEP, AI, DEPLOY, FE, OBS.
Security and database first because they produce the most critical findings.

For each category, run every auto-scannable check from
`references/checks.md` using the patterns in `references/patterns.md`.

Report progress after each category completes:
```
[1/8] Security: 3 FAIL, 12 PASS, 3 SKIP
[2/8] Database: 1 FAIL, 5 PASS, 6 SKIP
...
```

Report results as:
- PASS: check passed
- FAIL: issue found (with file path and line number)
- SKIP: not applicable to this stack

### Step 3: Manual Confirmation

For checks that cannot be automated (backup restore tested, rollback plan
exists, staging test passed), present them as a checklist and ask the user
to confirm each one.

### Step 4: Verdict

Classify results into three severities:
- CRITICAL: must fix before shipping (secrets exposed, no auth on routes,
  no HTTPS, SQL injection vectors, no RLS on Supabase tables)
- HIGH: should fix before shipping (no error boundaries, no rate limiting,
  console.logs in production, no pagination)
- ADVISORY: recommended but not blocking (no OG tags, no custom 404,
  no analytics, no SBOM)


The full report layout and verdict rules (CLEAR TO SHIP, SHIP WITH CAUTION, DO NOT SHIP) live in [report format](references/report_format.md).

## Reference files

- [Stack detection](references/stack_detection.md) - framework, database, deploy target detection
- [Report format](references/report_format.md) - final output and verdict rules
- [Scope and integration](references/scope_and_integration.md) - categories table, scope, integrations
- [Checks](references/checks.md) - full check details per category
- [Patterns](references/patterns.md) - scan patterns for automated checks
