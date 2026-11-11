# Click-path audit

For a UI feature where every function works on its own but a button still "does nothing"
or leaves the screen in the wrong state. Static checks (the handler exists, nothing throws,
types line up) all pass; the bug is in the order of state changes. Run it in DIAGNOSE when
the feature has interactive controls and shared state (a store, a context, a reducer).

## 1. Map what each state action writes

Before tracing any control, list every action or setter of the stores the feature uses,
with the fields it sets and the fields it resets as a side effect:

```text
STORE mailStore
  openCompose(on)      sets {composeOpen}
  selectThread(t)      sets {threadId, messages, draft}  RESETS {composeOpen: false}
RESETS OUTSIDE OWNERSHIP
  selectThread resets composeOpen (owned by openCompose)
```

The reset column is the point: most of these bugs are an action clearing a field another
action owns.

## 2. Trace each control

For every button, toggle, form submit and menu item in scope: open the handler, list its
calls in execution order, and for each call what it reads, writes and resets. Then ask two
questions: does a later call undo an earlier one, and does the final state match what the
control's label promises?

```text
CONTROL "New message" (ThreadList.tsx:88)
  1 openCompose(true)    composeOpen = true
  2 selectThread(null)   composeOpen = false   <- undoes call 1
  label promises: compose pane opens
  final state:    compose pane closed
```

## 3. Patterns to check on every control

| Pattern | Sign |
|---|---|
| Sequential undo | a later call, or its side effect, resets what an earlier call set |
| Async race | two promises write the same field; the final value depends on which resolves last |
| Stale closure | the handler reads a value captured at render time (two `set(count + 1)` add one) |
| Missing transition | the label says save, send or delete, but no call performs it (only a flag is set, or the endpoint is gone) |
| Dead branch | the real work sits behind a condition that is always false at that moment |
| Effect interference | an effect watching the field resets it right after the handler sets it |

## 4. Record each finding

```text
CLICK-PATH-001 HIGH  "New message" in ThreadList.tsx:88
  pattern: sequential undo
  trace:   openCompose(true) sets composeOpen; selectThread(null) resets it
  expected: compose pane opens    actual: nothing visible happens
  fix:     call selectThread(null) first, or stop selectThread resetting composeOpen
```

Each finding becomes a FIX entry and gets a test that clicks the control and asserts the
final state, not the individual calls.

## Scope

The store map (step 1) is shared input: build it once, then trace pages in parallel if
the feature is large. Not for API contract bugs, layout problems or slowness.
