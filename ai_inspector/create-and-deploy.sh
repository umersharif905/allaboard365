#!/usr/bin/env bash
# Create Azure Function App (consumption, Node) and deploy ai_inspector timer.
# For an existing app, use ./deploy.sh only.
# Requires: az CLI, zip (for packaging).
#
# Environment (optional):
#   RESOURCE_GROUP                  default: AllAboard365
#   LOCATION                        default: centralus
#   AI_INSPECTOR_STORAGE_NAME       must be globally unique (3–24 lowercase alphanumeric)
#   AI_INSPECTOR_FUNC_APP_NAME      default: allaboard-ai-inspector
#
# Required app settings (set via env or manually after provisioning):
#   OPENAI_API_KEY, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_TENANT_ID,
#   AZURE_SUBSCRIPTION_ID, DB_SERVER, DB_NAME, DB_USER, DB_PASSWORD,
#   SENDGRID_API_KEY, DEFAULT_FROM_EMAIL, ALERT_EMAIL
#
# Example:
#   OPENAI_API_KEY='sk-...' \
#   AZURE_CLIENT_ID='...' AZURE_CLIENT_SECRET='...' AZURE_TENANT_ID='...' AZURE_SUBSCRIPTION_ID='...' \
#   DB_SERVER='...' DB_NAME='...' DB_USER='...' DB_PASSWORD='...' \
#   SENDGRID_API_KEY='SG...' ALERT_EMAIL='jeremy@mightywell.us' \
#   ./create-and-deploy.sh

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

RESOURCE_GROUP="${RESOURCE_GROUP:-AllAboard365}"
LOCATION="${LOCATION:-centralus}"
FUNC_APP_NAME="${AI_INSPECTOR_FUNC_APP_NAME:-allaboard-ai-inspector}"

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
  if [[ -z "${AI_INSPECTOR_STORAGE_NAME:-}" ]]; then
    SUF="$(openssl rand -hex 4)"
    AI_INSPECTOR_STORAGE_NAME="allaboardai${SUF}"
  fi
  echo "Storage account:    $AI_INSPECTOR_STORAGE_NAME"
  if ! az storage account show --name "$AI_INSPECTOR_STORAGE_NAME" --resource-group "$RESOURCE_GROUP" &>/dev/null; then
    echo "Creating storage account $AI_INSPECTOR_STORAGE_NAME..."
    az storage account create \
      --name "$AI_INSPECTOR_STORAGE_NAME" \
      --resource-group "$RESOURCE_GROUP" \
      --location "$LOCATION" \
      --sku Standard_LRS
  else
    echo "Storage account $AI_INSPECTOR_STORAGE_NAME already exists."
  fi
  echo "Creating Function App $FUNC_APP_NAME..."
  az functionapp create \
    --name "$FUNC_APP_NAME" \
    --storage-account "$AI_INSPECTOR_STORAGE_NAME" \
    --consumption-plan-location "$LOCATION" \
    --resource-group "$RESOURCE_GROUP" \
    --runtime node \
    --runtime-version 24 \
    --functions-version 4
  echo "Created."
else
  echo "Function App $FUNC_APP_NAME already exists — skipping storage / new app provisioning."
fi

# ── Apply app settings ──────────────────────────────────────────────────────

SETTINGS=()

# OpenAI
[[ -n "${OPENAI_API_KEY:-}" ]] && SETTINGS+=("OPENAI_API_KEY=$OPENAI_API_KEY")

# Azure Service Principal
[[ -n "${AZURE_CLIENT_ID:-}" ]] && SETTINGS+=("AZURE_CLIENT_ID=$AZURE_CLIENT_ID")
[[ -n "${AZURE_CLIENT_SECRET:-}" ]] && SETTINGS+=("AZURE_CLIENT_SECRET=$AZURE_CLIENT_SECRET")
[[ -n "${AZURE_TENANT_ID:-}" ]] && SETTINGS+=("AZURE_TENANT_ID=$AZURE_TENANT_ID")
[[ -n "${AZURE_SUBSCRIPTION_ID:-}" ]] && SETTINGS+=("AZURE_SUBSCRIPTION_ID=$AZURE_SUBSCRIPTION_ID")
[[ -n "${RESOURCE_GROUP_NAME:-}" ]] && SETTINGS+=("RESOURCE_GROUP_NAME=$RESOURCE_GROUP_NAME")

# Database
[[ -n "${DB_SERVER:-}" ]] && SETTINGS+=("DB_SERVER=$DB_SERVER")
[[ -n "${DB_NAME:-}" ]] && SETTINGS+=("DB_NAME=$DB_NAME")
[[ -n "${DB_USER:-}" ]] && SETTINGS+=("DB_USER=$DB_USER")
[[ -n "${DB_PASSWORD:-}" ]] && SETTINGS+=("DB_PASSWORD=$DB_PASSWORD")

# Email
[[ -n "${SENDGRID_API_KEY:-}" ]] && SETTINGS+=("SENDGRID_API_KEY=$SENDGRID_API_KEY")
[[ -n "${DEFAULT_FROM_EMAIL:-}" ]] && SETTINGS+=("DEFAULT_FROM_EMAIL=$DEFAULT_FROM_EMAIL")
[[ -n "${ALERT_EMAIL:-}" ]] && SETTINGS+=("ALERT_EMAIL=$ALERT_EMAIL")

if [[ ${#SETTINGS[@]} -gt 0 ]]; then
  echo "Applying ${#SETTINGS[@]} app setting(s)..."
  az functionapp config appsettings set \
    --name "$FUNC_APP_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --settings "${SETTINGS[@]}"
else
  echo "No app settings in env — set them manually:"
  echo "  az functionapp config appsettings set --name $FUNC_APP_NAME --resource-group $RESOURCE_GROUP \\"
  echo "    --settings OPENAI_API_KEY='...' AZURE_CLIENT_ID='...' AZURE_CLIENT_SECRET='...' \\"
  echo "               AZURE_TENANT_ID='...' AZURE_SUBSCRIPTION_ID='...' \\"
  echo "               DB_SERVER='...' DB_NAME='...' DB_USER='...' DB_PASSWORD='...' \\"
  echo "               SENDGRID_API_KEY='...' ALERT_EMAIL='jeremy@mightywell.us'"
fi

echo ""
echo "Deploying (see deploy.sh)..."
"$SCRIPT_DIR/deploy.sh"
