---
name: env-secrets-manager
description: "Use when auditing .env files for committed secrets and managing environment-variable hygiene"
disable-model-invocation: true
---

# Env & Secrets Manager

**Tier:** POWERFUL
**Category:** Engineering
**Domain:** Security / DevOps / Configuration Management

---

## Overview

Manage environment-variable hygiene and secrets safety across local development and production workflows. This skill focuses on practical auditing, drift awareness, and rotation readiness.

## Core Capabilities

- `.env` and `.env.example` lifecycle guidance
- Secret leak detection for repository working trees
- Severity-based findings for likely credentials
- Operational pointers for rotation and containment
- Integration-ready outputs for CI checks

---

## When to Use

- Before pushing commits that touched env/config files
- During security audits and incident triage
- When onboarding contributors who need safe env conventions
- When validating that no obvious secrets are hardcoded

---

## Quick Start

```bash
# Scan a repository for likely secret leaks
python3 scripts/env_auditor.py /path/to/repo

# JSON output for CI pipelines
python3 scripts/env_auditor.py /path/to/repo --json
```

---

## Recommended Workflow

1. Run `scripts/env_auditor.py` on the repository root.
2. Prioritize `critical` and `high` findings first.
3. Rotate real credentials and remove exposed values.
4. Update `.env.example` and `.gitignore` as needed.
5. Add or tighten pre-commit/CI secret scanning gates.

---

## Reference Docs

- `references/validation-detection-rotation.md`
- `references/secret-patterns.md`
- `references/secret-stores-and-rotation.md` - provider comparison, rotation phases, emergency checklist
- `references/cicd-precommit-audit.md` - pipeline injection, gitleaks, detect-secrets, audit trails

---

## Common Pitfalls

- Committing real values in `.env.example`
- Rotating one system but missing downstream consumers
- Logging secrets during debugging or incident response
- Treating suspected leaks as low urgency without validation

## Best Practices

1. Use a secret manager as the production source of truth.
2. Keep dev env files local and gitignored.
3. Enforce detection in CI before merge.
4. Re-test application paths immediately after credential rotation.

---

## Cross-References

This skill covers env hygiene and secret detection. For deeper coverage of related domains, see:

| Skill | Path | Relationship |
|-------|------|-------------|
| **Secrets Vault Manager** | `engineering/secrets-vault-manager` | Production vault infrastructure, HA deployment, DR |
| **Senior SecOps** | `engineering/senior-secops` | Security operations perspective, incident response |
| **CI/CD Pipeline Builder** | `engineering/ci-cd-pipeline-builder` | Pipeline architecture, secret injection patterns |
| **Infrastructure as Code** | `engineering/infrastructure-as-code` | Terraform/Pulumi secret backend configuration |
| **Container Orchestration** | `engineering/container-orchestration` | Kubernetes secret mounting, sealed secrets |
