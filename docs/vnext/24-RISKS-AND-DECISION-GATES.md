# Risk register and decision gates

| Risk | Likelihood | Impact | Early signal | Required response |
|---|---|---|---|---|
| Rewriting tested TS core as Python | High | High | large diff/legacy test failures | incremental adapter parity, rollback |
| Python package imports massive GPU deps by default | High | Medium | cold start/install > reasonable | extras and lazy imports |
| VisA benchmark falsely called generalization | High | Critical for credibility | all items train/no holdout | reject claim; fix split |
| npm scope/PyPI name conflict | Unknown | High | registry verification fails | choose compliant package identity |
| Untrusted image/model executes code | Medium | Critical | arbitrary model/file loads | image guards, safe model sources |
| Contract divergence TS/Python | High | High | schema parity mismatches | generated validators, golden tests |
| MPS memory exhaustion | Medium | Medium | OOM, slow fallback | admission, batch tuning, CPU fallback |
| Agent acts beyond scope | Medium | Critical | policy bypass/tool injection | tool allowlist + approvals outside LLM |
| Dataset license invalid for distribution | Medium | High | missing/prohibited license | registry license gate |
| Scope grows without demo | High | High | many half-shipped modules | milestone gate, stop/defer |
| Public API costs uncontrollable | Medium | High | unreconciled model calls | rate/cost caps, BYOK only if safe |
| Versioning/migrations destroy local data | Medium | High | destructive migration attempt | backup, rollback rehearsal |
| Inaccurate cost claims | High | Medium | estimated vs billed conflated | distinct actual/estimate fields |

**Architecture review trigger:** any new language/service ownership change, public API-breaking shape, data retention decision, external model source, privileged MCP tool, deployment to public internet, license change, benchmark protocol modification. Issues requiring scientific confidence must be resolved with controlled experiment rather than a speculative framework.
