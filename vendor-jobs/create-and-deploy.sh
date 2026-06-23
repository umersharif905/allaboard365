#!/usr/bin/env bash
# Create Azure Function App (consumption, Node) and deploy vendor-jobs timer.
# For an existing app, use ./deploy.sh only.
# Requires: az CLI, zip (for packaging).
#
# Environment (optional):
#   RESOURCE_GROUP              default: AllAboard365
#   LOCATION                    default: centralus
#   VENDOR_JOBS_STORAGE_NAME    must be globally unique (3–24 lowercase alphanumeric)
#   VENDOR_JOBS_FUNC_APP_NAME   default: allaboard-vendor-jobs
#   VENDOR_EXPORT_ENDPOINT_URL  full POST URL (set on Function App after create)
#   SCHEDULED_JOB_API_KEY       same as backend SCHEDULED_JOB_API_KEY (optional if backend unset)
#
# Example:
#   VENDOR_EXPORT_ENDPOINT_URL='https://allaboard365-backend-ctehcsb5cbedauc0.centralus-01.azurewebsites.net/api/scheduled-jobs/vendor-exports' \
#   SCHEDULED_JOB_API_KEY='your-key' \
#   ./create-and-deploy.sh

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

RESOURCE_GROUP="${RESOURCE_GROUP:-AllAboard365}"
LOCATION="${LOCATION:-centralus}"
FUNC_APP_NAME="${VENDOR_JOBS_FUNC_APP_NAME:-allaboard-vendor-jobs}"

echo "Subscription (current):"
az account show --query '{name:name, id:id}' -o table 2>/dev/null || { echo "Run: az login"; exit 1; }
echo ""
echo "Resource group:     $RESOURCE_GROUP"
echo "Location:           $LOCATION"
echo "Function app:       $FUNC_APP_NAME"
echo ""

if ! az group show --name "$RESOURCE_GROUP" &>/dev/null; then
  echo "Creating resource group $RESOURCE_GROUP..."
  az group create --name "$RESOURCE_GROUP" --location "$LOCATION"
fi

if ! az functionapp show --name "$FUNC_APP_NAME" --resource-group "$RESOURCE_GROUP" &>/dev/null; then
  if [[ -z "${VENDOR_JOBS_STORAGE_NAME:-}" ]]; then
    SUF="$(openssl rand -hex 4)"
    VENDOR_JOBS_STORAGE_NAME="allaboardvj${SUF}"
  fi
  echo "Storage account:    $VENDOR_JOBS_STORAGE_NAME"
  if ! az storage account show --name "$VENDOR_JOBS_STORAGE_NAME" --resource-group "$RESOURCE_GROUP" &>/dev/null; then
    echo "Creating storage account $VENDOR_JOBS_STORAGE_NAME..."
    az storage account create \
      --name "$VENDOR_JOBS_STORAGE_NAME" \
      --resource-group "$RESOURCE_GROUP" \
      --location "$LOCATION" \
      --sku Standard_LRS
  else
    echo "Storage account $VENDOR_JOBS_STORAGE_NAME already exists."
  fi
  echo "Creating Function App $FUNC_APP_NAME..."
  az functionapp create \
    --name "$FUNC_APP_NAME" \
    --storage-account "$VENDOR_JOBS_STORAGE_NAME" \
    --consumption-plan-location "$LOCATION" \
    --resource-group "$RESOURCE_GROUP" \
    --runtime node \
    --runtime-version 24 \
    --functions-version 4
  echo "Created."
else
  echo "Function App $FUNC_APP_NAME already exists — skipping storage / new app provisioning."
fi

# App settings for the timer (backend URL + optional API key)
SETTINGS=()
if [[ -n "${VENDOR_EXPORT_ENDPOINT_URL:-}" ]]; then
  SETTINGS+=("VENDOR_EXPORT_ENDPOINT_URL=$VENDOR_EXPORT_ENDPOINT_URL")
fi
# Must match backend SCHEDULED_JOB_API_KEY — see ai_scripts/sync-scheduled-job-api-keys.sh
if [[ -n "${SCHEDULED_JOB_API_KEY:-}" ]]; then
  SETTINGS+=("SCHEDULED_JOB_API_KEY=$SCHEDULED_JOB_API_KEY")
fi

if [[ ${#SETTINGS[@]} -gt 0 ]]; then
  echo "Applying app settings..."
  az functionapp config appsettings set \
    --name "$FUNC_APP_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --settings "${SETTINGS[@]}"
else
  echo "No VENDOR_EXPORT_ENDPOINT_URL / SCHEDULED_JOB_API_KEY in env — set app settings manually:"
  echo "  az functionapp config appsettings set --name $FUNC_APP_NAME --resource-group $RESOURCE_GROUP \\"
  echo "    --settings VENDOR_EXPORT_ENDPOINT_URL='https://YOUR-HOST/api/scheduled-jobs/vendor-exports' SCHEDULED_JOB_API_KEY='...'"
fi

echo ""
echo "Deploying (see deploy.sh)..."
"$SCRIPT_DIR/deploy.sh"
