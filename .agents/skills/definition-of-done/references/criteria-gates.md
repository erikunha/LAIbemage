# Criteria gates

Three checks every list passes before it is handed over: each criterion earns its place
with evidence, each criterion shared between two components is pinned by a concrete form,
and each kind of work gets the measure that actually shows it is done.

## 1. Evidence to include a criterion

A criterion stays only if it cites one of these:

1. The user asked for it (their words, the ticket, the spec).
2. Another criterion on the list cannot hold without it, and that one has evidence.
3. Existing code, a caller or an external consumer breaks without it (name the path).
4. A rule that applies to this project today (name it and how it touches the change).
5. Something that actually happened: an incident, an alert that fired, a customer report,
   a measured number.

No evidence: move it to `deferred` with the trigger that would bring it back. These
phrases mark a criterion as a deferral candidate until evidence is cited: "might need",
"for future flexibility", "at scale", "best practice", "for completeness", "we have
create so we need delete".

Then ask whether a strictly smaller criterion satisfies the same evidence (one end-to-end
check instead of four unit ones, a literal instead of a setting). If yes, the smaller one
replaces it.

```
deferred:
  AC-007 export to CSV
    why: no evidence; nobody asked, no consumer reads it
    reopen when: a user or a downstream job asks for a file export
```

Never drop a deferral silently: it stays visible so the user can overrule it.

## 2. A shared form is pinned by a worked example

When two components must agree on a form (a file or wire format, a log line, a payload, a
schema, a CLI signature, exit codes, a naming rule another component parses), the
criterion is closed only when it carries one of:

- a literal example (an actual line, payload or row);
- a grammar line with its variable parts named;
- a field layout (name, type, order or key for each field);
- a link to an artifact that exists today at a path that resolves.

Field names alone, a prose description, or "defined during implementation", "TBD at
build", "authored later" do not close it. An unpinned shared form is an `unknown`, asked or
assumed in writing like any other.

```
AC-004 Each audit line has the form
       2026-09-30T10:00:00Z <actor> <action> <target-id>
       e.g. 2026-09-30T10:00:00Z erik delete draft-812
```

## 3. The measure depends on the kind of work

| Work | Done is shown by |
|---|---|
| Bug | the failure reproduced first, then the same reproduction passing; a test that failed before the fix and passes after |
| Tests | the exact command and the pass condition (count, zero failures, named suite) |
| Performance | the metric, the threshold, how it is measured, and how many runs |
| Quality or refactor | an observable bar: lint, typecheck and tests pass, named examples reviewed, or an artifact the user approves |
| Research | the decision it must enable, the sources in scope, and the evidence standard |
| Operations | the healthy state, the watch window, the failure threshold, the rollback or escalation trigger |

If no metric can be named, propose the most honest yes-or-no check available and mark it
as an assumption.
