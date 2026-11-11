# Cloud secret stores and rotation workflow

## Cloud Secret Store Integration

Production applications should never read secrets from `.env` files or environment variables baked into container images. Use a dedicated secret store instead.

### Provider Comparison

| Provider | Best For | Key Feature |
|----------|----------|-------------|
| **HashiCorp Vault** | Multi-cloud / hybrid | Dynamic secrets, policy engine, pluggable backends |
| **AWS Secrets Manager** | AWS-native workloads | Native Lambda/ECS/EKS integration, automatic RDS rotation |
| **Azure Key Vault** | Azure-native workloads | Managed HSM, Azure AD RBAC, certificate management |
| **GCP Secret Manager** | GCP-native workloads | IAM-based access, automatic replication, versioning |

### Selection Guidance

- **Single cloud provider**: use the cloud-native secret manager. It integrates tightly with IAM, reduces operational overhead, and costs less than self-hosting.
- **Multi-cloud or hybrid**: use HashiCorp Vault. It provides a uniform API across environments and supports dynamic secret generation (database credentials, cloud IAM keys) that expire automatically.
- **Kubernetes-heavy**: combine External Secrets Operator with any backend above to sync secrets into K8s `Secret` objects without hardcoding.

### Application Access Patterns

1. **SDK/API pull**: application fetches secret at startup or on-demand via provider SDK.
2. **Sidecar injection**: a sidecar container (e.g., Vault Agent) writes secrets to a shared volume or injects them as environment variables.
3. **Init container**: a Kubernetes init container fetches secrets before the main container starts.
4. **CSI driver**: secrets mount as a filesystem volume via the Secrets Store CSI Driver.

> **Cross-reference:** See `engineering/secrets-vault-manager` for production vault infrastructure patterns, HA deployment, and disaster recovery procedures.

## Secret Rotation Workflow

Stale secrets are a liability. Rotation ensures that even if a credential leaks, its useful lifetime is bounded.

### Phase 1: Detection

- Track secret creation and expiry dates in your secret store metadata.
- Set alerts at 30, 14, and 7 days before expiry.
- Use `scripts/env_auditor.py` to flag secrets with no recorded rotation date.

### Phase 2: Rotation

1. **Generate** a new credential (API key, database password, certificate).
2. **Deploy** the new credential to all consumers (apps, services, pipelines) in parallel.
3. **Verify** each consumer can authenticate using the new credential.
4. **Revoke** the old credential only after all consumers are confirmed healthy.
5. **Update** metadata with the new rotation timestamp and next rotation date.

### Phase 3: Automation

- **AWS Secrets Manager**: use built-in Lambda-based rotation for RDS, Redshift, and DocumentDB.
- **HashiCorp Vault**: configure dynamic secrets with TTLs; credentials are generated on-demand and auto-expire.
- **Azure Key Vault**: use Event Grid notifications to trigger rotation functions.
- **GCP Secret Manager**: use Pub/Sub notifications tied to Cloud Functions for rotation logic.

### Emergency Rotation Checklist

When a secret is confirmed leaked:

1. **Immediately revoke** the compromised credential at the provider level.
2. Generate and deploy a replacement credential to all consumers.
3. Audit access logs for unauthorized usage during the exposure window.
4. Scan git history, CI logs, and artifact registries for the leaked value.
5. File an incident report documenting scope, timeline, and remediation steps.
6. Review and tighten detection controls to prevent recurrence.

