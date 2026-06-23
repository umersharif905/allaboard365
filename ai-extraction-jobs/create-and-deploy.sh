#!/usr/bin/env bash
# Create Azure Function App (consumption, Node) and deploy ai-extraction-jobs.
# For an existing app, use ./deploy.sh only.
# Requires: az CLI, zip (for packaging).
#
# Environment (optional):
#   RESOURCE_GROUP                    default: AllAboard365
#   LOCATION                          default: centralus
#   AI_EXTRACTION_JOBS_STORAGE_NAME   must be globally unique (3–24 lowercase alphanumeric)
#   AI_EXTRACTION_JOBS_FUNC_APP_NAME  default: allaboard-ai-extraction-jobs
#   ANTHROPIC_API_KEY                 Claude API key (set on Function App after create)
#   AZURE_STORAGE_CONNECTION_STRING   Blob storage for document downloads
#   SERVICE_BUS_CONNECTION            Service Bus namespace connection string
#   DB_USER / DB_PASSWORD / DB_SERVER / DB_NAME  SQL connection details
#
# Example:
#   ANTHROPIC_API_KEY='sk-ant-...' \
#   SERVICE_BUS_CONNECTION='Endpoint=sb://...' \
#   AZURE_STORAGE_CONNECTION_STRING='DefaultEndpointsProtocol=https;...' \
#   ./create-and-deploy.sh

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

RESOURCE_GROUP="${RESOURCE_GROUP:-AllAboard365}"
LOCATION="${LOCATION:-centralus}"
FUNC_APP_NAME="${AI_EXTRACTION_JOBS_FUNC_APP_NAME:-allaboard-ai-extraction-jobs}"

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
  if [[ -z "${AI_EXTRACTION_JOBS_STORAGE_NAME:-}" ]]; then
    SUF="$(openssl rand -hex 4)"
    AI_EXTRACTION_JOBS_STORAGE_NAME="allaboardaie${SUF}"
  fi
  echo "Storage account:    $AI_EXTRACTION_JOBS_STORAGE_NAME"
  if ! az storage account show --name "$AI_EXTRACTION_JOBS_STORAGE_NAME" --resource-group "$RESOURCE_GROUP" &>/dev/null; then
    echo "Creating storage account $AI_EXTRACTION_JOBS_STORAGE_NAME..."
    az storage account create \
      --name "$AI_EXTRACTION_JOBS_STORAGE_NAME" \
      --resource-group "$RESOURCE_GROUP" \
      --location "$LOCATION" \
      --sku Standard_LRS
  else
    echo "Storage account $AI_EXTRACTION_JOBS_STORAGE_NAME already exists."
  fi
  echo "Creating Function App $FUNC_APP_NAME..."
  az functionapp create \
    --name "$FUNC_APP_NAME" \
    --storage-account "$AI_EXTRACTION_JOBS_STORAGE_NAME" \
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
if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
  SETTINGS+=("ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY")
fi
if [[ -n "${AZURE_STORAGE_CONNECTION_STRING:-}" ]]; then
  SETTINGS+=("AZURE_STORAGE_CONNECTION_STRING=$AZURE_STORAGE_CONNECTION_STRING")
fi
if [[ -n "${SERVICE_BUS_CONNECTION:-}" ]]; then
  SETTINGS+=("ServiceBusConnection=$SERVICE_BUS_CONNECTION")
fi
if [[ -n "${DB_USER:-}" ]]; then
  SETTINGS+=("DB_USER=$DB_USER")
fi
if [[ -n "${DB_PASSWORD:-}" ]]; then
  SETTINGS+=("DB_PASSWORD=$DB_PASSWORD")
fi
if [[ -n "${DB_SERVER:-}" ]]; then
  SETTINGS+=("DB_SERVER=$DB_SERVER")
fi
if [[ -n "${DB_NAME:-}" ]]; then
  SETTINGS+=("DB_NAME=$DB_NAME")
fi

if [[ ${#SETTINGS[@]} -gt 0 ]]; then
  echo "Applying app settings..."
  az functionapp config appsettings set \
    --name "$FUNC_APP_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --settings "${SETTINGS[@]}"
else
  echo "No env vars provided — set app settings manually:"
  echo "  az functionapp config appsettings set --name $FUNC_APP_NAME --resource-group $RESOURCE_GROUP \\"
  echo "    --settings ANTHROPIC_API_KEY='...' ServiceBusConnection='...' AZURE_STORAGE_CONNECTION_STRING='...'"
  echo "    DB_USER='...' DB_PASSWORD='...' DB_SERVER='...' DB_NAME='...'"
fi

echo ""
echo "Deploying (see deploy.sh)..."
"$SCRIPT_DIR/deploy.sh"
