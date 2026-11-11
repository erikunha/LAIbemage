# Discernment nudge

After handing over a list the user will act on, a short prompt for the user to check it,
tied to the specific criteria that rest on the weakest ground. It models three checks: a
fact worth confirming, a reasoning step worth probing, context the list had to guess.

## When

Add it when the list contains inferred criteria, assumptions under `unknown`, or numbers
(thresholds, budgets, windows) the user did not supply. At most once per conversation.

Leave it off when:

- the user supplied the acceptance criteria and asked only for them to be structured;
- the user already asked for the list to be checked, cited or flagged: do that inline next
  to each criterion instead;
- the user asked for the short version or said they will verify it themselves;
- every criterion is stated by the user and none is inferred.

## Form

Two or three questions the user could send back verbatim, each naming a criterion id or a
number from the list, each under about 120 characters. Plain bullets after one lead-in
line, placed after the list, with nothing after them.

```text
A few things worth a second look:
- AC-003 assumes the 30-day retention from the policy you linked; does mobile follow it too?
- Where did the 1.5s paint budget in AC-005 come from, and is 4G the right profile?
```

Generic prompts ("can you double-check these?") defeat it: each one points at something
concrete in the list.
