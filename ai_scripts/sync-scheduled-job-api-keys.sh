#!/bin/bash
# Sync SCHEDULED_JOB_API_KEY from AllAboard365-Backend to all scheduled-job function apps.
# Usage: ./ai_scripts/sync-scheduled-job-api-keys.sh
# Requires: az cli logged into AllAboard365 subscription

set -euo pipefail

RESOURCE_GROUP="${RESOURCE_GROUP:-AllAboard365}"
BACKEND_APP="${BACKEND_APP:-AllAboard365-Backend}"

FUNCTION_APPS=(
  allaboard365-billing-nightly-job
  allaboard365-ledger-reconcile-job
  allaboard365-enrollment-jobs
  allaboard-product-api-jobs
  allaboard-vendor-jobs
  allaboard-sftp-import-job
)

az account set --subscription "AllAboard365" >/dev/null

KEY=$(az webapp config appsettings list -g "$RESOURCE_GROUP" -n "$BACKEND_APP" \
  --query "[?name=='SCHEDULED_JOB_API_KEY'].value | [0]" -o tsv)

if [[ -z "${KEY:-}" ]]; then
  echo "ERROR: SCHEDULED_JOB_API_KEY not set on $BACKEND_APP" >&2
  exit 1
fi

echo "Syncing key (len=${#KEY}) to ${#FUNCTION_APPS[@]} function apps..."
for app in "${FUNCTION_APPS[@]}"; do
  if ! az functionapp show -g "$RESOURCE_GROUP" -n "$app" &>/dev/null; then
    echo "  ⚠ SKIP $app (not deployed — run sftp-import-job/create-and-deploy.sh first)" >&2
    continue
  fi
  echo "  → $app"
  az functionapp config appsettings set -g "$RESOURCE_GROUP" -n "$app" \
    --settings "SCHEDULED_JOB_API_KEY=$KEY" -o none
done

echo "Done. Verify with:"
for app in "${FUNCTION_APPS[@]}"; do
  if ! az functionapp show -g "$RESOURCE_GROUP" -n "$app" &>/dev/null; then
    echo "  $app: (not found)"
    continue
  fi
  v=$(az functionapp config appsettings list -g "$RESOURCE_GROUP" -n "$app" \
    --query "[?name=='SCHEDULED_JOB_API_KEY'].value | [0]" -o tsv)
  echo "  $app: len=${#v}"
done
