# Phase 1: DISCUSS and Phase 2: MAP

## Phase 1: DISCUSS

**Goal:** Capture what is actually being built before any planning happens.

Ask and fully resolve:

1. What is the end state? Describe the working thing, not the steps to get there.
2. What tech stack, language, and major libraries are in use? (Do NOT assume.)
3. Does existing code exist that this touches? If yes, share it.
4. What are the hard constraints? (Must run on X, must use Y, must not break Z.)
5. What does "done" look like: how will we know this works?

**Rules:**
- Ask all five questions in a single message and wait for answers.
- Do not start planning until questions 1, 2, and 5 are answered.
- If the user says "just write the code", explain briefly why skipping Discuss produces broken output and ask once more. If they insist, proceed with explicit UNKNOWN tags everywhere.

**Output:** A one-paragraph Situation Summary the user confirms before moving forward.

## Phase 2: MAP

**Goal:** Build a codebase map before writing a single line of code. *(Graphify principle)*

For existing code:

```
CODEBASE MAP
============
[KNOWN]    UserService.ts → calls → AuthService.authenticate()
[KNOWN]    AuthService.ts → imports → jwt library (v9.x, user confirmed)
[INFERRED] UserController.ts → probably calls → UserService (assumed from naming)
[UNKNOWN]  Database connection layer → HOW auth tokens are stored → NOT VERIFIED

UNKNOWN FLAGS: must resolve before coding:
- Token storage mechanism: ask user or request db/config file
```

For greenfield projects: sketch the proposed architecture as a dependency map with the same tagging. Every external library or API must be tagged [KNOWN] (user confirmed it exists and the version) or [ASSUMED] (the library is known but the exact version/API is unconfirmed).

**Hard rule:** Never write code that depends on an [UNKNOWN]. Resolve all UNKNOWN flags before Phase 3.

**Output:** A written codebase map with no unresolved UNKNOWN flags.
