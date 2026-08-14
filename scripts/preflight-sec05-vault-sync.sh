#!/usr/bin/env bash
set -euo pipefail

# SEC-05 Hardened Preflight & Vault Sync Script
# Defaults to dry-run mode (RUN_SEC05=0) unless explicitly set to 1

RUN_SEC05="${RUN_SEC05:-0}"
SYNC_LEGACY_ALIAS="${SYNC_LEGACY_ALIAS:-1}"
REQUIRE_LEGACY_ALIAS="${REQUIRE_LEGACY_ALIAS:-auto}"
GH_REPO="${GH_REPO:-palmtr3man/thispagedoesnotexist12345}"
NETLIFY_SITE="${NETLIFY_SITE:-thispagedoesnotexist12345-production}"
INFISICAL_PROJECT_ID="${INFISICAL_PROJECT_ID:-6c7646e9-04dd-484a-a5d1-612b9582da15}"
INFISICAL_ENV="${INFISICAL_ENV:-prod}"
INFISICAL_DOMAIN="${INFISICAL_DOMAIN:-https://app.infisical.com}"
CANONICAL_ACTION_SHA="bfe3dacda023af78349e300914a168e1fb766dbe"
WORKFLOW_FILE=".github/workflows/sec05-vault-sync.yml"

# Cleanup trap to unset sensitive variables on exit
cleanup() {
  unset INFISICAL_TOKEN || true
  unset GH_TOKEN || true
  unset GITHUB_TOKEN || true
}
trap cleanup EXIT INT TERM

echo "=== Starting preflight-sec05-vault-sync.sh ==="
echo "Mode: $([ "$RUN_SEC05" -eq 1 ] && echo 'LIVE DISPATCH' || echo 'DRY RUN (read-only)')"

# 1. GitHub CLI Auth Check
echo "Checking GitHub CLI authentication..."
if command -v gh >/dev/null 2>&1; then
  gh auth status >/dev/null 2>&1 && echo "GitHub CLI: Authenticated" || { echo "ERROR: gh not authenticated"; exit 1; }
else
  echo "WARNING: gh CLI not installed, skipping gh auth check"
fi

# 2. Netlify CLI Auth Check
echo "Checking Netlify CLI authentication..."
if command -v netlify >/dev/null 2>&1; then
  netlify status >/dev/null 2>&1 && echo "Netlify CLI: Authenticated" || echo "WARNING: Netlify CLI not logged in or no site linked"
else
  echo "WARNING: netlify CLI not installed, skipping netlify auth check"
fi

# 3. Infisical Token Verification
if [ -n "${INFISICAL_TOKEN:-}" ]; then
  echo "Using pre-existing INFISICAL_TOKEN from the environment"
else
  echo "ERROR: INFISICAL_TOKEN is not set in environment"
  exit 1
fi

# 4. GitHub Secrets Verification (Presence only)
if command -v gh >/dev/null 2>&1; then
  echo "Inspecting GitHub repository secrets..."
  SECRETS_LIST=$(gh secret list -R "$GH_REPO" 2>/dev/null | awk '{print $1}' || true)
  for secret in INFISICAL_CLIENT_ID INFISICAL_CLIENT_SECRET INFISICAL_MACHINE_IDENTITY_ID; do
    if echo "$SECRETS_LIST" | grep -qx "$secret"; then
      echo "Found GitHub secret name: $secret"
    else
      echo "WARNING: GitHub secret name missing: $secret"
    fi
  done
fi

# 5. Workflow Pin & Identity Verification
if [ -f "$WORKFLOW_FILE" ]; then
  echo "Checking $WORKFLOW_FILE..."
  if grep -q "Infisical/auth-action@v1" "$WORKFLOW_FILE"; then
    echo "ERROR: Unresolved Infisical/auth-action@v1 found in $WORKFLOW_FILE! Must be pinned to SHA $CANONICAL_ACTION_SHA."
    exit 1
  elif grep -q "Infisical/auth-action@$CANONICAL_ACTION_SHA" "$WORKFLOW_FILE"; then
    echo "Infisical auth-action reference is resolvable and SHA-pinned ($CANONICAL_ACTION_SHA)."
  else
    echo "WARNING: Infisical auth-action reference is using a custom tag/SHA in $WORKFLOW_FILE."
  fi
  if grep -q "INFISICAL_MACHINE_IDENTITY_ID" "$WORKFLOW_FILE"; then
    echo "Workflow references INFISICAL_MACHINE_IDENTITY_ID."
  else
    echo "WARNING: Workflow missing reference to INFISICAL_MACHINE_IDENTITY_ID."
  fi
else
  echo "NOTICE: $WORKFLOW_FILE not found in current directory tree."
fi

# 6. Infisical Project Check
echo "Checking Infisical project endpoint ($INFISICAL_DOMAIN)..."
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $INFISICAL_TOKEN" \
  "$INFISICAL_DOMAIN/api/v1/workspace/$INFISICAL_PROJECT_ID" || echo "000")
if [ "$HTTP_STATUS" -eq 404 ]; then
  echo "ERROR: Infisical project lookup returned 404 for project $INFISICAL_PROJECT_ID."
  exit 1
elif [ "$HTTP_STATUS" -eq 200 ] || [ "$HTTP_STATUS" -eq 403 ]; then
  echo "Infisical project endpoint reachable (HTTP $HTTP_STATUS)."
else
  echo "Infisical API check status: HTTP $HTTP_STATUS"
fi

# 7. Codebase Key Reference Scan
echo "Scanning codebase for Base44 API key references..."
CANONICAL_REFS=$(grep -rn "BASE44_API_KEY" base44/ netlify/ functions/ 2>/dev/null || true)
LEGACY_REFS=$(grep -rn "BASE44APIKEY" base44/ netlify/ functions/ 2>/dev/null || true)
if [ -n "$CANONICAL_REFS" ]; then
  echo "Canonical BASE44_API_KEY references found:"
  echo "$CANONICAL_REFS" | awk -F: '{print "  - " $1 ":" $2}'
else
  echo "No direct code references to BASE44_API_KEY found."
fi
if [ -n "$LEGACY_REFS" ]; then
  echo "Legacy BASE44APIKEY references detected:"
  echo "$LEGACY_REFS" | awk -F: '{print "  - " $1 ":" $2}'
else
  echo "No legacy BASE44APIKEY references detected."
fi

# 8. Check for Hardcoded Notion Database IDs
echo "Checking for hardcoded Notion DB IDs in functions..."
if grep -rn "86452d899336438eafa7d3f1e89fb126" base44/ netlify/ functions/ 2>/dev/null; then
  echo "ERROR: Compromised hardcoded Notion DB ID detected in code! Must use NOTION_PIPELINE_DATABASE_ID env var."
  exit 1
else
  echo "No compromised hardcoded Notion DB IDs detected."
fi

# 9. Dry Run vs Execution Exit Point
if [ "$RUN_SEC05" -ne 1 ]; then
  echo "=========================================="
  echo "Dry run complete. SEC-05 was NOT dispatched."
  echo "To execute live dispatch, run with RUN_SEC05=1"
  exit 0
fi

# 10. Live Dispatch
echo "=========================================="
echo "RUN_SEC05=1 detected. Triggering SEC-05 workflow dispatch..."
if command -v gh >/dev/null 2>&1; then
  gh workflow run sec05-vault-sync.yml -R "$GH_REPO" \
    -f sync_legacy_alias="$SYNC_LEGACY_ALIAS" \
    -f require_legacy_alias="$REQUIRE_LEGACY_ALIAS"
  echo "SEC-05 workflow dispatched successfully. Monitor via: gh run watch -R $GH_REPO"
else
  echo "ERROR: gh CLI required for live workflow dispatch."
  exit 1
fi
