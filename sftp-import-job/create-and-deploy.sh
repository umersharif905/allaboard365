#!/usr/bin/env bash
# Create Azure Function App (consumption, Node) and deploy sftp-import-job timer.
# For an existing app, use ./deploy.sh only.
# Requires: az CLI, zip (for packaging).
#
# Environment (optional):
#   RESOURCE_GROUP                default: AllAboard365
#   LOCATION                      default: centralus
#   SFTP_IMPORT_STORAGE_NAME      must be globally unique (3–24 lowercase alphanumeric)
#   SFTP_IMPORT_FUNC_APP_NAME     default: allaboard-sftp-import-job
#   SFTP_IMPORT_ENDPOINT_URL      full POST URL (set on Function App after create)
#   SCHEDULED_JOB_API_KEY         same as backend SCHEDULED_JOB_API_KEY
#
# Example:
#   SFTP_IMPORT_ENDPOINT_URL='https://api.allaboard365.com/api/scheduled-jobs/sftp-import' \
#   SCHEDULED_JOB_API_KEY='your-key' \
#   ./create-and-deploy.sh

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

RESOURCE_GROUP="${RESOURCE_GROUP:-AllAboard365}"
LOCATION="${LOCATION:-centralus}"
FUNC_APP_NAME="${SFTP_IMPORT_FUNC_APP_NAME:-allaboard-sftp-import-job}"

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
  if [[ -z "${SFTP_IMPORT_STORAGE_NAME:-}" ]]; then
    SUF="$(openssl rand -hex 4)"
    SFTP_IMPORT_STORAGE_NAME="allaboardsftp${SUF}"
  fi
  echo "Storage account:    $SFTP_IMPORT_STORAGE_NAME"
  if ! az storage account show --name "$SFTP_IMPORT_STORAGE_NAME" --resource-group "$RESOURCE_GROUP" &>/dev/null; then
    echo "Creating storage account $SFTP_IMPORT_STORAGE_NAME..."
    az storage account create \
      --name "$SFTP_IMPORT_STORAGE_NAME" \
      --resource-group "$RESOURCE_GROUP" \
      --location "$LOCATION" \
      --sku Standard_LRS
  else
    echo "Storage account $SFTP_IMPORT_STORAGE_NAME already exists."
  fi
  echo "Creating Function App $FUNC_APP_NAME..."
  az functionapp create \
    --name "$FUNC_APP_NAME" \
    --storage-account "$SFTP_IMPORT_STORAGE_NAME" \
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
if [[ -n "${SFTP_IMPORT_ENDPOINT_URL:-}" ]]; then
  SETTINGS+=("SFTP_IMPORT_ENDPOINT_URL=$SFTP_IMPORT_ENDPOINT_URL")
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
  echo "No SFTP_IMPORT_ENDPOINT_URL / SCHEDULED_JOB_API_KEY in env — set app settings manually:"
  echo "  az functionapp config appsettings set --name $FUNC_APP_NAME --resource-group $RESOURCE_GROUP \\"
  echo "    --settings SFTP_IMPORT_ENDPOINT_URL='https://YOUR-HOST/api/scheduled-jobs/sftp-import' SCHEDULED_JOB_API_KEY='...'"
fi

echo ""
echo "Deploying (see deploy.sh)..."
"$SCRIPT_DIR/deploy.sh"
