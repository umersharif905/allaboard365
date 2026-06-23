#!/usr/bin/env bash
# Create Azure Function App (consumption, Node) and deploy ledger-reconcile-job timer.
# For an existing app, use ./deploy.sh only.
# Requires: az CLI, zip (for packaging).
#
# Environment (optional):
#   RESOURCE_GROUP                          default: AllAboard365
#   LOCATION                               default: centralus
#   LEDGER_RECONCILE_JOB_STORAGE_NAME       must be globally unique (3–24 lowercase alphanumeric)
#   LEDGER_RECONCILE_JOB_FUNC_APP_NAME      default: allaboard365-ledger-reconcile-job
#   LEDGER_RECONCILE_ENDPOINT_URL           POST …/ledger-reconcile (optional if derived)
#   ALLABOARD365_BACKEND_BASE_URL           or BACKEND_BASE_URL — derives unset endpoint
#   SKIP_BACKEND_PROMPT=1 CI=1             skip interactive prompt
#   SCHEDULED_JOB_API_KEY                   same as backend when set

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

RESOURCE_GROUP="${RESOURCE_GROUP:-AllAboard365}"
LOCATION="${LOCATION:-centralus}"
FUNC_APP_NAME="${LEDGER_RECONCILE_JOB_FUNC_APP_NAME:-allaboard365-ledger-reconcile-job}"

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
  if [[ -z "${LEDGER_RECONCILE_JOB_STORAGE_NAME:-}" ]]; then
    SUF="$(openssl rand -hex 4)"
    LEDGER_RECONCILE_JOB_STORAGE_NAME="allaboardlrj${SUF}"
  fi
  echo "Storage account:    $LEDGER_RECONCILE_JOB_STORAGE_NAME"
  if ! az storage account show --name "$LEDGER_RECONCILE_JOB_STORAGE_NAME" --resource-group "$RESOURCE_GROUP" &>/dev/null; then
    echo "Creating storage account $LEDGER_RECONCILE_JOB_STORAGE_NAME..."
    az storage account create \
      --name "$LEDGER_RECONCILE_JOB_STORAGE_NAME" \
      --resource-group "$RESOURCE_GROUP" \
      --location "$LOCATION" \
      --sku Standard_LRS
  else
    echo "Storage account $LEDGER_RECONCILE_JOB_STORAGE_NAME already exists."
  fi
  echo "Creating Function App $FUNC_APP_NAME..."
  az functionapp create \
    --name "$FUNC_APP_NAME" \
    --storage-account "$LEDGER_RECONCILE_JOB_STORAGE_NAME" \
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
  echo "Derive ledger-reconcile POST URL (Enter = prod ${DEFAULT_ALLABOARD365_BACKEND_ORIGIN})."
  read -r -p "AllAboard365 API HTTPS origin [staging override, or Enter for prod]: " _reply || true
  BACKEND_ORIGIN="$(_backend_origin_trim "${_reply:-}")"
fi

if [[ -z "${BACKEND_ORIGIN}" ]]; then
  BACKEND_ORIGIN="${DEFAULT_ALLABOARD365_BACKEND_ORIGIN}"
  echo "Using default AllAboard365 API origin: ${BACKEND_ORIGIN}"
fi

if [[ -n "${BACKEND_ORIGIN}" ]] && [[ -z "${LEDGER_RECONCILE_ENDPOINT_URL:-}" ]]; then
  LEDGER_RECONCILE_ENDPOINT_URL="${BACKEND_ORIGIN%/}/api/scheduled-jobs/ledger-reconcile"
  echo "→ Derived LEDGER_RECONCILE_ENDPOINT_URL"
fi

SETTINGS=()
if [[ -n "${LEDGER_RECONCILE_ENDPOINT_URL:-}" ]]; then
  SETTINGS+=("LEDGER_RECONCILE_ENDPOINT_URL=$LEDGER_RECONCILE_ENDPOINT_URL")
fi
if [[ -n "${LEDGER_RECONCILE_BODY:-}" ]]; then
  SETTINGS+=("LEDGER_RECONCILE_BODY=$LEDGER_RECONCILE_BODY")
fi
# Must match AllAboard365-Backend SCHEDULED_JOB_API_KEY or POSTs return 401.
# After backend key rotation: ./ai_scripts/sync-scheduled-job-api-keys.sh
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
  echo "    --settings LEDGER_RECONCILE_ENDPOINT_URL='https://YOUR-HOST/api/scheduled-jobs/ledger-reconcile' \\"
  echo "               SCHEDULED_JOB_API_KEY='...'"
fi

echo ""
echo "Deploying (see deploy.sh)..."
"$SCRIPT_DIR/deploy.sh"
