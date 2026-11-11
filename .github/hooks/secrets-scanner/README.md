| name        | Secrets Scanner                                                                         |
| ----------- | --------------------------------------------------------------------------------------- |
| description | Scans files modified during a Copilot session for leaked LLM API keys and other secrets |
| tags        | security, api-keys, openai, anthropic, google                                           |

# Secrets Scanner Hook

Scans modified files at the end of a Copilot coding agent session for accidentally leaked API
keys and other credentials. Tuned for Vision Lens's three LLM providers.

## Detected patterns

| Pattern             | Severity | Example                           |
| ------------------- | -------- | --------------------------------- |
| `OPENAI_API_KEY`    | critical | `sk-abc123...`                    |
| `ANTHROPIC_API_KEY` | critical | `sk-ant-abc123...`                |
| `GOOGLE_API_KEY`    | critical | `AIzaXYZ...`                      |
| `GITHUB_PAT`        | critical | `ghp_abc123...`                   |
| `AWS_ACCESS_KEY`    | critical | `AKIAIOSFODNN7...`                |
| `PRIVATE_KEY`       | critical | `-----BEGIN RSA PRIVATE KEY-----` |
| `BEARER_TOKEN`      | high     | `Bearer abc123...`                |
| `GENERIC_SECRET`    | high     | `api_key = "abc123..."`           |

## Installation

1. Make the script executable:

   ```bash
   chmod +x .github/hooks/secrets-scanner/scan-secrets.sh
   ```

2. Create the logs directory and add to `.gitignore`:

   ```bash
   mkdir -p logs/copilot/secrets
   echo "logs/" >> .gitignore
   ```

3. Commit the hook to your repository's default branch.

## Configuration

| Variable            | Values           | Default                | Description                              |
| ------------------- | ---------------- | ---------------------- | ---------------------------------------- |
| `SCAN_MODE`         | `warn`, `block`  | `warn`                 | `block` exits non-zero to prevent commit |
| `SCAN_SCOPE`        | `diff`, `staged` | `diff`                 | `diff`=uncommitted vs HEAD               |
| `SKIP_SECRETS_SCAN` | `true`           | unset                  | Disables the scanner entirely            |
| `SECRETS_ALLOWLIST` | CSV string       | unset                  | Comma-separated patterns to ignore       |
| `SECRETS_LOG_DIR`   | path             | `logs/copilot/secrets` | Log file directory                       |

## Pairing with test-gate

Both hooks fire at `sessionEnd`. Order them so secrets-scanner runs first:

```json
{
  "version": 1,
  "hooks": {
    "sessionEnd": [
      {
        "type": "command",
        "bash": ".github/hooks/secrets-scanner/scan-secrets.sh",
        "cwd": ".",
        "env": { "SCAN_MODE": "block" },
        "timeoutSec": 30
      },
      {
        "type": "command",
        "bash": ".github/hooks/test-gate/run-checks.sh",
        "cwd": ".",
        "env": { "FAIL_MODE": "warn" },
        "timeoutSec": 120
      }
    ]
  }
}
```
