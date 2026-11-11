#!/usr/bin/env bash
# secrets-scanner/scan-secrets.sh
# Scans modified files for accidentally leaked LLM API keys and other secrets.
# Tuned for Vision Lens: detects OpenAI (sk-), Anthropic (sk-ant-), and Google (AIza) keys.
#
# Environment variables:
#   SCAN_MODE   warn|block   (default: warn)  block exits non-zero to prevent auto-commit
#   SCAN_SCOPE  diff|staged  (default: diff)  diff=uncommitted changes, staged=git-staged only
#   SKIP_SECRETS_SCAN=true   disables the scanner entirely
#   SECRETS_ALLOWLIST        comma-separated patterns to ignore (e.g. "test-key-123,example-key")

set -uo pipefail

# ── Config ─────────────────────────────────────────────────────────────────────
SCAN_MODE="${SCAN_MODE:-warn}"
SCAN_SCOPE="${SCAN_SCOPE:-diff}"
SKIP="${SKIP_SECRETS_SCAN:-}"
ALLOWLIST="${SECRETS_ALLOWLIST:-}"
LOG_DIR="${SECRETS_LOG_DIR:-logs/copilot/secrets}"

if [ -n "$SKIP" ]; then
  echo "ℹ️  Secrets scanner disabled (SKIP_SECRETS_SCAN is set)"
  exit 0
fi

# ── Patterns (name|regex) ───────────────────────────────────────────────────────
declare -A PATTERNS=(
  ["OPENAI_API_KEY"]="sk-[A-Za-z0-9_-]{20,}"
  ["ANTHROPIC_API_KEY"]="sk-ant-[A-Za-z0-9_-]{20,}"
  ["GOOGLE_API_KEY"]="AIza[A-Za-z0-9_-]{35}"
  ["GITHUB_PAT"]="ghp_[A-Za-z0-9]{36}"
  ["GITHUB_FINE_GRAINED_PAT"]="github_pat_[A-Za-z0-9_]{82}"
  ["AWS_ACCESS_KEY"]="AKIA[A-Z0-9]{16}"
  ["PRIVATE_KEY"]="-----BEGIN (RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY"
  ["BEARER_TOKEN"]="[Bb]earer [A-Za-z0-9_-]{20,}"
  ["GENERIC_SECRET"]="(api_key|secret_key|access_token|auth_token)[[:space:]]*=[[:space:]]*['\"][A-Za-z0-9_-]{16,}"
)

declare -A SEVERITY=(
  ["OPENAI_API_KEY"]="critical"
  ["ANTHROPIC_API_KEY"]="critical"
  ["GOOGLE_API_KEY"]="critical"
  ["GITHUB_PAT"]="critical"
  ["GITHUB_FINE_GRAINED_PAT"]="critical"
  ["AWS_ACCESS_KEY"]="critical"
  ["PRIVATE_KEY"]="critical"
  ["BEARER_TOKEN"]="high"
  ["GENERIC_SECRET"]="high"
)

# Placeholder patterns that are safe to ignore
SAFE_PATTERNS="example|changeme|your_|<your|placeholder|test.key|fake|dummy|REPLACE|xxx"

# ── Collect files ──────────────────────────────────────────────────────────────
if [ "$SCAN_SCOPE" = "staged" ]; then
  CHANGED_FILES=$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null || true)
else
  CHANGED_FILES=$(git diff --name-only HEAD 2>/dev/null || git diff --name-only 2>/dev/null || true)
fi

if [ -z "$CHANGED_FILES" ]; then
  echo "✅ No modified files to scan."
  exit 0
fi

FILE_COUNT=$(echo "$CHANGED_FILES" | wc -l | tr -d ' ')
echo ""
echo "🔍 Scanning $FILE_COUNT modified file(s) for secrets..."

# ── Scan ───────────────────────────────────────────────────────────────────────
FINDINGS=()

while IFS= read -r file; do
  # Skip non-existent, binary, and lock files
  [ -f "$file" ] || continue
  file "$file" | grep -q "text" || continue
  [[ "$file" == *.lock ]] || [[ "$file" == package-lock.json ]] && continue

  while IFS= read -r line_content; do
    LINE_NUM=$(echo "$line_content" | cut -d: -f1)
    LINE_TEXT=$(echo "$line_content" | cut -d: -f2-)

    # Skip placeholder/example values
    echo "$LINE_TEXT" | grep -qiE "$SAFE_PATTERNS" && continue

    # Check allowlist
    if [ -n "$ALLOWLIST" ]; then
      SKIP_LINE=false
      IFS=',' read -ra ALLOW_ITEMS <<< "$ALLOWLIST"
      for allow in "${ALLOW_ITEMS[@]}"; do
        echo "$LINE_TEXT" | grep -qF "$allow" && SKIP_LINE=true && break
      done
      $SKIP_LINE && continue
    fi

    for PATTERN_NAME in "${!PATTERNS[@]}"; do
      REGEX="${PATTERNS[$PATTERN_NAME]}"
      if echo "$LINE_TEXT" | grep -qE "$REGEX"; then
        MATCH=$(echo "$LINE_TEXT" | grep -oE "$REGEX" | head -1 | cut -c1-20)
        SEV="${SEVERITY[$PATTERN_NAME]}"
        FINDINGS+=("$file|$LINE_NUM|$PATTERN_NAME|$SEV|${MATCH}...")
      fi
    done
  done < <(grep -n "" "$file" 2>/dev/null || true)

done <<< "$CHANGED_FILES"

# ── Report ─────────────────────────────────────────────────────────────────────
if [ ${#FINDINGS[@]} -eq 0 ]; then
  echo "✅ No secrets detected in $FILE_COUNT scanned file(s)"
  echo ""
  exit 0
fi

echo ""
echo "⚠️  Found ${#FINDINGS[@]} potential secret(s) in modified files:"
echo ""
printf "  %-40s %-6s %-25s %s\n" "FILE" "LINE" "PATTERN" "SEVERITY"
printf "  %-40s %-6s %-25s %s\n" "----" "----" "-------" "--------"

for FINDING in "${FINDINGS[@]}"; do
  IFS='|' read -r F_FILE F_LINE F_PATTERN F_SEV F_MATCH <<< "$FINDING"
  printf "  %-40s %-6s %-25s %s\n" "$F_FILE" "$F_LINE" "$F_PATTERN" "$F_SEV"
done

echo ""

# ── Log ────────────────────────────────────────────────────────────────────────
if [ -n "$LOG_DIR" ]; then
  mkdir -p "$LOG_DIR" 2>/dev/null || true
  TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date +"%Y-%m-%dT%H:%M:%SZ")
  LOG_ENTRY="{\"timestamp\":\"$TIMESTAMP\",\"event\":\"secrets_found\",\"mode\":\"$SCAN_MODE\",\"scope\":\"$SCAN_SCOPE\",\"files_scanned\":$FILE_COUNT,\"finding_count\":${#FINDINGS[@]}}"
  echo "$LOG_ENTRY" >> "$LOG_DIR/scan.log" 2>/dev/null || true
fi

# ── Exit ───────────────────────────────────────────────────────────────────────
if [ "$SCAN_MODE" = "block" ]; then
  echo "🚫 Session blocked: resolve the findings above before committing."
  echo "   Set SCAN_MODE=warn in hooks.json to log without blocking."
  echo "   Or add patterns to SECRETS_ALLOWLIST to suppress false positives."
  exit 1
else
  echo "💡 Review the findings above. Set SCAN_MODE=block to prevent commits with secrets."
  exit 0
fi
