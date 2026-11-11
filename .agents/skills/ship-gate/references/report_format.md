# Ship Gate Report Format

Final output:

```
SHIP GATE REPORT
================
Stack: Next.js + Supabase + Vercel
Scan time: 12s

CRITICAL (3 items, must fix)
  FAIL  [SEC-01] API key found in src/lib/api.ts:14
  FAIL  [DB-07] RLS not enabled on "profiles" table
  FAIL  [SEC-05] No CSRF protection on /api/checkout

HIGH (5 items, should fix)
  FAIL  [CODE-01] 12 console.log statements in production code
  FAIL  [CODE-03] Empty catch block in src/utils/auth.ts:45
  FAIL  [DEP-04] 3 critical npm audit vulnerabilities
  FAIL  [DEPLOY-05] No rollback plan documented
  MANUAL [DEPLOY-06] Staging test not confirmed

ADVISORY (4 items, recommended)
  FAIL  [FE-01] Missing OG meta tags
  FAIL  [FE-03] No custom 404 page
  PASS  [OBS-01] Error monitoring configured
  SKIP  [AI-01] No AI/LLM usage detected

VERDICT: DO NOT SHIP (3 critical issues)
Fix critical items and re-run.
```

If zero critical items remain, verdict is: CLEAR TO SHIP.
If only high items remain, verdict is: SHIP WITH CAUTION (acknowledge risks).
