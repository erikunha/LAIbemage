## Categories

Eight categories, each with a code prefix. Full check details in
`checks.md`.

| Prefix | Category | Auto | Manual | Tool |
|--------|----------|------|--------|------|
| SEC | Security | 15 | 3 | 0 |
| DB | Database | 7 | 5 | 0 |
| DEPLOY | Deployment | 3 | 8 | 0 |
| CODE | Code Quality | 11 | 0 | 1 |
| AI | AI/LLM Security | 5 | 3 | 0 |
| DEP | Dependencies | 5 | 0 | 1 |
| FE | Frontend Quality | 7 | 3 | 0 |
| OBS | Observability | 2 | 5 | 0 |

## Scope

This skill audits. It does not fix. When it finds issues, it reports
them with file locations and remediation guidance. The user or another
skill (systematic-debugging, backend-patterns, shadcn-stack) handles
the fix.

This skill does not:
- Set up CI/CD pipelines
- Provision infrastructure
- Configure monitoring tools
- Run after deployment (it is pre-deploy only)

## Integration Points

- **karpathy-coder**: run ship-gate after karpathy-check passes: simplicity first, then production readiness
- **adversarial-reviewer**: deep security review for items ship-gate flags as critical
- **security-pen-testing**: penetration testing methodology for SEC-category findings
- **code-reviewer**: general code quality review complements ship-gate's automated checks
