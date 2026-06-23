#!/usr/bin/env bash
# Create Azure Function App (consumption, Node) and deploy product-api-jobs timer.
# For an existing app, use ./deploy.sh only.
# Requires: az CLI, zip (for packaging).
#
# Environment (optional):
#   RESOURCE_GROUP                    default: AllAboard365
#   LOCATION                          default: centralus
#   PRODUCT_API_JOBS_STORAGE_NAME     must be globally unique (3–24 lowercase alphanumeric)
#   PRODUCT_API_JOBS_FUNC_APP_NAME    default: allaboard-product-api-jobs
#   PRODUCT_API_DAILY_ENDPOINT_URL    full POST URL (set on Function App after create)
#   SCHEDULED_JOB_API_KEY             same as backend SCHEDULED_JOB_API_KEY (optional if backend unset)
#
# Example:
#   PRODUCT_API_DAILY_ENDPOINT_URL='https://YOUR-BACKEND.azurewebsites.net/api/scheduled-jobs/product-api-daily' \
#   SCHEDULED_JOB_API_KEY='your-key' \
#   ./create-and-deploy.sh

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

RESOURCE_GROUP="${RESOURCE_GROUP:-AllAboard365}"
LOCATION="${LOCATION:-centralus}"
FUNC_APP_NAME="${PRODUCT_API_JOBS_FUNC_APP_NAME:-allaboard-product-api-jobs}"

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
  if [[ -z "${PRODUCT_API_JOBS_STORAGE_NAME:-}" ]]; then
    SUF="$(openssl rand -hex 4)"
    PRODUCT_API_JOBS_STORAGE_NAME="allaboardpaj${SUF}"
  fi
  echo "Storage account:    $PRODUCT_API_JOBS_STORAGE_NAME"
  if ! az storage account show --name "$PRODUCT_API_JOBS_STORAGE_NAME" --resource-group "$RESOURCE_GROUP" &>/dev/null; then
    echo "Creating storage account $PRODUCT_API_JOBS_STORAGE_NAME..."
    az storage account create \
      --name "$PRODUCT_API_JOBS_STORAGE_NAME" \
      --resource-group "$RESOURCE_GROUP" \
      --location "$LOCATION" \
      --sku Standard_LRS
  else
    echo "Storage account $PRODUCT_API_JOBS_STORAGE_NAME already exists."
  fi
  echo "Creating Function App $FUNC_APP_NAME..."
  az functionapp create \
    --name "$FUNC_APP_NAME" \
    --storage-account "$PRODUCT_API_JOBS_STORAGE_NAME" \
    --consumption-plan-location "$LOCATION" \
    --resource-group "$RESOURCE_GROUP" \
    --runtime node \
    --runtime-version 24 \
    --functions-version 4
  echo "Created."
else
  echo "Function App $FUNC_APP_NAME already exists — skipping storage / new app provisioning."
fi

SETTINGS=()
if [[ -n "${PRODUCT_API_DAILY_ENDPOINT_URL:-}" ]]; then
  SETTINGS+=("PRODUCT_API_DAILY_ENDPOINT_URL=$PRODUCT_API_DAILY_ENDPOINT_URL")
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
  echo "No PRODUCT_API_DAILY_ENDPOINT_URL / SCHEDULED_JOB_API_KEY in env — set app settings manually:"
  echo "  az functionapp config appsettings set --name $FUNC_APP_NAME --resource-group $RESOURCE_GROUP \\"
  echo "    --settings PRODUCT_API_DAILY_ENDPOINT_URL='https://YOUR-HOST/api/scheduled-jobs/product-api-daily' SCHEDULED_JOB_API_KEY='...'"
fi

echo ""
echo "Deploying (see deploy.sh)..."
"$SCRIPT_DIR/deploy.sh"
