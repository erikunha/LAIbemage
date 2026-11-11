---
name: definition-of-done
description: Compile observable acceptance criteria before non-trivial implementation, separating stated requirements from inferred ones. Use when a task is about to be built and "done" has not been defined. Do not use for a trivial edit, or when the user already stated the acceptance criteria.
---

# Definition of done

Work with no observable acceptance criteria cannot be verified, cannot be
reviewed, and gets declared finished by whoever gets tired first.

The output is a short list somebody who did not write the code could check.

## Sources, in order

1. What the user said. Verbatim, not paraphrased.
2. Contracts already in play: an open task contract, an ADR, a schema.
3. Repository conventions the change has to keep.
4. Tests that already assert on the touched behaviour.

Anything not from those four is **inferred**, and inferred is where invented
requirements enter. Mark it.

## Structure

```
behavior       what becomes true that was not
preserved      what must not change
edge cases     the inputs that break naive implementations
validation     how each of the above is checked
not required   explicitly out of scope
deferred       proposed without evidence, each with the trigger that reopens it
unknown        material questions, each either asked or assumed in writing
```

Every criterion gets an id: `AC-001`, `AC-002`, in the order they are written.
The id is what the implementation, the review and the final report all point at,
so three documents can disagree about the wording and still mean the same thing.

A criterion that turns out to be wrong mid-implementation keeps its id, is marked
`[revised]`, its `revision` goes up by one, and `revised_because` says what made
the original wrong. Rewriting the sentence in place is how a missed criterion
becomes a met one between two readings of the same list.

```
AC-003 [revised, r2] A deleted draft stays retrievable for 30 days
       was: A deleted draft is removed immediately
       because: the retention policy the user pointed at says 30 days
```

Where the project already measures test coverage, 80% line coverage is one of
the criteria, written as `AC-NNN` like any other. Where nothing measures it, it
is not a criterion at all: `coverage-gate.py` reports not-run, and not-run is
never reported as passed.

## Observable means observable

Every criterion needs the act that shows it holds.

| Not a criterion | A criterion |
|---|---|
| Login is secure | An expired token returns 401 with the same body shape as 403 |
| The UI feels responsive | First contentful paint under 1.5s on a throttled 4G profile |
| Errors are handled | A 500 from the upstream renders the retry panel, not a blank page |

If you cannot name the act, the criterion is a feeling and it will be argued
about at review time instead of tested.

## Do not invent product requirements

The most common failure of this skill is producing a tidy list containing three
things nobody asked for, which then get built.

For a missing requirement that materially changes the work: **ask one question**.
For one that does not: **write a visible assumption** and continue.

```
unknown:  Should an expired refresh token log the user out, or silently renew?
handling: assumed
assumption: silently renew, matching the existing web client. Wrong if mobile
            relies on the logout to clear local state.
```

An assumption written like that is falsifiable in one read. "Assumed standard
behaviour" is not.

## Gates before handing over

Read [references/criteria-gates.md](references/criteria-gates.md) and apply it:

- **Evidence.** Each criterion cites the user, a dependent criterion, a caller that breaks, a rule in force, or something that happened. Without one it moves to `deferred`; a smaller criterion that meets the same evidence replaces a larger one.
- **Pinned forms.** A format two components share is closed only by a literal example, a grammar line, a field layout or an existing artifact. "TBD at build" never closes it.
- **Measure by kind of work.** Bug, tests, performance, quality, research and operations each have their own "done"; the table is in the reference.

When the list rests on inferred criteria or numbers the user did not give, end with the one-time prompt in [references/discernment-nudge.md](references/discernment-nudge.md).

## Boundary

This skill does not implement, and does not estimate. It produces the list the
implementation will be checked against, then stops.
