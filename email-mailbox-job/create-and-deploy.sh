#!/usr/bin/env bash
# Create Azure Function App (consumption, Node) and deploy email-mailbox-job timers.
# For an existing app, use ./deploy.sh only.
# Requires: az CLI, zip (for packaging).
#
# Environment (optional):
#   RESOURCE_GROUP                         default: AllAboard365
#   LOCATION                               default: centralus
#   EMAIL_MAILBOX_JOB_STORAGE_NAME         must be globally unique (3–24 lowercase alphanumeric)
#   EMAIL_MAILBOX_JOB_FUNC_APP_NAME        default: allaboard365-email-mailbox-job
#   EMAIL_SUBSCRIPTION_RENEWAL_ENDPOINT_URL  full POST URL (optional if derived)
#   EMAIL_RECONCILE_ENDPOINT_URL             full POST URL (optional if derived)
#   ALLABOARD365_BACKEND_BASE_URL          or BACKEND_BASE_URL — derives unset endpoints
#   OPENENROLL_BACKEND_BASE_URL            deprecated alias
#   SKIP_BACKEND_PROMPT=1 CI=1               skip interactive prompt
#   SCHEDULED_JOB_API_KEY                    same as backend when set
#   BACKEND_APP_NAME                         default: allaboard365-backend (for key sync)

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

RESOURCE_GROUP="${RESOURCE_GROUP:-AllAboard365}"
LOCATION="${LOCATION:-centralus}"
FUNC_APP_NAME="${EMAIL_MAILBOX_JOB_FUNC_APP_NAME:-allaboard365-email-mailbox-job}"
BACKEND_APP_NAME="${BACKEND_APP_NAME:-allaboard365-backend}"

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
  if [[ -z "${EMAIL_MAILBOX_JOB_STORAGE_NAME:-}" ]]; then
    SUF="$(openssl rand -hex 4)"
    EMAIL_MAILBOX_JOB_STORAGE_NAME="allaboardembj${SUF}"
  fi
  echo "Storage account:    $EMAIL_MAILBOX_JOB_STORAGE_NAME"
  if ! az storage account show --name "$EMAIL_MAILBOX_JOB_STORAGE_NAME" --resource-group "$RESOURCE_GROUP" &>/dev/null; then
    echo "Creating storage account $EMAIL_MAILBOX_JOB_STORAGE_NAME..."
    az storage account create \
      --name "$EMAIL_MAILBOX_JOB_STORAGE_NAME" \
      --resource-group "$RESOURCE_GROUP" \
      --location "$LOCATION" \
      --sku Standard_LRS
  else
    echo "Storage account $EMAIL_MAILBOX_JOB_STORAGE_NAME already exists."
  fi
  echo "Creating Function App $FUNC_APP_NAME..."
  az functionapp create \
    --name "$FUNC_APP_NAME" \
    --storage-account "$EMAIL_MAILBOX_JOB_STORAGE_NAME" \
    --consumption-plan-location "$LOCATION" \
    --resource-group "$RESOURCE_GROUP" \
    --runtime node \
    --runtime-version 24 \
    --functions-version 4
  echo "Created."
else
  echo "Function App $FUNC_APP_NAME already exists — skipping storage / new app provisioning."
fi

DEFAULT_ALLABOARD365_BACKEND_ORIGIN="${DEFAULT_ALLABOARD365_BACKEND_ORIGIN:-${DEFAULT_OPENENROLL_BACKEND_ORIGIN:-https://api.allaboard365.com}}"

_backend_origin_trim() {
  local s="${1//$'\r'/}"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

BACKEND_ORIGIN="${ALLABOARD365_BACKEND_BASE_URL:-${OPENENROLL_BACKEND_BASE_URL:-${BACKEND_BASE_URL:-}}}"
BACKEND_ORIGIN="$(_backend_origin_trim "$BACKEND_ORIGIN")"

if [[ -z "${BACKEND_ORIGIN}" ]] && [[ -t 0 ]] && [[ -z "${CI:-}" ]] && [[ -z "${SKIP_BACKEND_PROMPT:-}" ]]; then
  echo ""
  echo "Derive email-mailbox POST URLs (Enter = prod ${DEFAULT_ALLABOARD365_BACKEND_ORIGIN})."
  read -r -p "AllAboard365 API HTTPS origin [staging override, or Enter for prod]: " _reply || true
  BACKEND_ORIGIN="$(_backend_origin_trim "${_reply:-}")"
fi

if [[ -z "${BACKEND_ORIGIN}" ]]; then
  BACKEND_ORIGIN="${DEFAULT_ALLABOARD365_BACKEND_ORIGIN}"
  echo "Using default AllAboard365 API origin: ${BACKEND_ORIGIN}"
fi

if [[ -n "${BACKEND_ORIGIN}" ]]; then
  _B="${BACKEND_ORIGIN%/}"
  if [[ -z "${EMAIL_SUBSCRIPTION_RENEWAL_ENDPOINT_URL:-}" ]]; then
    EMAIL_SUBSCRIPTION_RENEWAL_ENDPOINT_URL="${_B}/api/scheduled-jobs/email-subscription-renewal"
    echo "→ Derived EMAIL_SUBSCRIPTION_RENEWAL_ENDPOINT_URL"
  fi
  if [[ -z "${EMAIL_RECONCILE_ENDPOINT_URL:-}" ]]; then
    EMAIL_RECONCILE_ENDPOINT_URL="${_B}/api/scheduled-jobs/email-reconcile"
    echo "→ Derived EMAIL_RECONCILE_ENDPOINT_URL"
  fi
fi

if [[ -z "${SCHEDULED_JOB_API_KEY:-}" ]]; then
  SCHEDULED_JOB_API_KEY="$(az webapp config appsettings list \
    --name "$BACKEND_APP_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --query "[?name=='SCHEDULED_JOB_API_KEY'].value | [0]" -o tsv 2>/dev/null || true)"
  if [[ -n "${SCHEDULED_JOB_API_KEY}" ]]; then
    echo "→ Synced SCHEDULED_JOB_API_KEY from $BACKEND_APP_NAME"
  fi
fi

SETTINGS=()
if [[ -n "${EMAIL_SUBSCRIPTION_RENEWAL_ENDPOINT_URL:-}" ]]; then
  SETTINGS+=("EMAIL_SUBSCRIPTION_RENEWAL_ENDPOINT_URL=$EMAIL_SUBSCRIPTION_RENEWAL_ENDPOINT_URL")
fi
if [[ -n "${EMAIL_RECONCILE_ENDPOINT_URL:-}" ]]; then
  SETTINGS+=("EMAIL_RECONCILE_ENDPOINT_URL=$EMAIL_RECONCILE_ENDPOINT_URL")
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
  echo "No settings in env — set app settings manually:"
  echo "  az functionapp config appsettings set --name $FUNC_APP_NAME --resource-group $RESOURCE_GROUP \\"
  echo "    --settings EMAIL_SUBSCRIPTION_RENEWAL_ENDPOINT_URL='https://YOUR-HOST/api/scheduled-jobs/email-subscription-renewal' \\"
  echo "               EMAIL_RECONCILE_ENDPOINT_URL='https://YOUR-HOST/api/scheduled-jobs/email-reconcile' \\"
  echo "               SCHEDULED_JOB_API_KEY='...'"
fi

echo ""
echo "Deploying (see deploy.sh)..."
"$SCRIPT_DIR/deploy.sh"
