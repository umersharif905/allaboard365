#!/usr/bin/env bash
# Create Azure Function App (consumption, Node) and deploy the website-form-digest timer.
# For an existing app, use ./deploy.sh only.
# Requires: az CLI, zip.
#
# Environment (optional):
#   RESOURCE_GROUP                          default: AllAboard365
#   LOCATION                                default: centralus
#   WEBSITE_FORM_DIGEST_JOB_STORAGE_NAME    must be globally unique (3–24 lowercase alphanumeric)
#   WEBSITE_FORM_DIGEST_JOB_FUNC_APP_NAME   default: allaboard365-website-form-digest
#   WEBSITE_FORM_DIGEST_ENDPOINT_URL        full POST URL (optional if derived from BACKEND_BASE_URL)
#   ALLABOARD365_BACKEND_BASE_URL           or BACKEND_BASE_URL — derives unset endpoint
#   SCHEDULED_JOB_API_KEY                   must match backend env var of the same name
#   SKIP_BACKEND_PROMPT=1 CI=1              skip interactive prompt

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

RESOURCE_GROUP="${RESOURCE_GROUP:-AllAboard365}"
LOCATION="${LOCATION:-centralus}"
FUNC_APP_NAME="${WEBSITE_FORM_DIGEST_JOB_FUNC_APP_NAME:-allaboard365-website-form-digest}"

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
  if [[ -z "${WEBSITE_FORM_DIGEST_JOB_STORAGE_NAME:-}" ]]; then
    SUF="$(openssl rand -hex 4)"
    WEBSITE_FORM_DIGEST_JOB_STORAGE_NAME="allaboardwfd${SUF}"
  fi
  echo "Storage account:    $WEBSITE_FORM_DIGEST_JOB_STORAGE_NAME"
  if ! az storage account show --name "$WEBSITE_FORM_DIGEST_JOB_STORAGE_NAME" --resource-group "$RESOURCE_GROUP" &>/dev/null; then
    echo "Creating storage account $WEBSITE_FORM_DIGEST_JOB_STORAGE_NAME..."
    az storage account create \
      --name "$WEBSITE_FORM_DIGEST_JOB_STORAGE_NAME" \
      --resource-group "$RESOURCE_GROUP" \
      --location "$LOCATION" \
      --sku Standard_LRS
  else
    echo "Storage account $WEBSITE_FORM_DIGEST_JOB_STORAGE_NAME already exists."
  fi
  echo "Creating Function App $FUNC_APP_NAME..."
  az functionapp create \
    --name "$FUNC_APP_NAME" \
    --storage-account "$WEBSITE_FORM_DIGEST_JOB_STORAGE_NAME" \
    --consumption-plan-location "$LOCATION" \
    --resource-group "$RESOURCE_GROUP" \
    --runtime node \
    --runtime-version 24 \
    --functions-version 4
  echo "Created."
else
  echo "Function App $FUNC_APP_NAME already exists — skipping storage / new app provisioning."
fi

DEFAULT_ALLABOARD365_BACKEND_ORIGIN="${DEFAULT_ALLABOARD365_BACKEND_ORIGIN:-https://api.allaboard365.com}"

_backend_origin_trim() {
  local s="${1//$'\r'/}"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

BACKEND_ORIGIN="${ALLABOARD365_BACKEND_BASE_URL:-${BACKEND_BASE_URL:-}}"
BACKEND_ORIGIN="$(_backend_origin_trim "$BACKEND_ORIGIN")"

if [[ -z "${BACKEND_ORIGIN}" ]] && [[ -t 0 ]] && [[ -z "${CI:-}" ]] && [[ -z "${SKIP_BACKEND_PROMPT:-}" ]]; then
  echo ""
  echo "Derive website-form-digest POST URL (Enter = prod ${DEFAULT_ALLABOARD365_BACKEND_ORIGIN})."
  read -r -p "AllAboard365 API HTTPS origin [staging override, or Enter for prod]: " _reply || true
  BACKEND_ORIGIN="$(_backend_origin_trim "${_reply:-}")"
fi

if [[ -z "${BACKEND_ORIGIN}" ]]; then
  BACKEND_ORIGIN="${DEFAULT_ALLABOARD365_BACKEND_ORIGIN}"
  echo "Using default AllAboard365 API origin: ${BACKEND_ORIGIN}"
fi

if [[ -n "${BACKEND_ORIGIN}" ]]; then
  _B="${BACKEND_ORIGIN%/}"
  if [[ -z "${WEBSITE_FORM_DIGEST_ENDPOINT_URL:-}" ]]; then
    WEBSITE_FORM_DIGEST_ENDPOINT_URL="${_B}/api/cron/website-form-digest"
    echo "→ Derived WEBSITE_FORM_DIGEST_ENDPOINT_URL"
  fi
fi

SETTINGS=()
if [[ -n "${WEBSITE_FORM_DIGEST_ENDPOINT_URL:-}" ]]; then
  SETTINGS+=("WEBSITE_FORM_DIGEST_ENDPOINT_URL=$WEBSITE_FORM_DIGEST_ENDPOINT_URL")
fi
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
  echo "No URL in env — set app settings manually:"
  echo "  az functionapp config appsettings set --name $FUNC_APP_NAME --resource-group $RESOURCE_GROUP \\"
  echo "    --settings WEBSITE_FORM_DIGEST_ENDPOINT_URL='https://YOUR-HOST/api/cron/website-form-digest' \\"
  echo "               SCHEDULED_JOB_API_KEY='...'"
fi

echo ""
echo "Deploying (see deploy.sh)..."
"$SCRIPT_DIR/deploy.sh"
