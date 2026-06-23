#!/usr/bin/env bash
# Create Azure Function App (consumption, Node) and deploy billing-nightly-job timer.
# For an existing app, use ./deploy.sh only.
# Requires: az CLI, zip (for packaging).
#
# Environment (optional):
#   RESOURCE_GROUP                        default: AllAboard365
#   LOCATION                             default: centralus
#   BILLING_NIGHTLY_JOB_STORAGE_NAME      must be globally unique (3–24 lowercase alphanumeric)
#   BILLING_NIGHTLY_JOB_FUNC_APP_NAME     default: allaboard365-billing-nightly-job
#   BILLING_NIGHTLY_ENDPOINT_URL          unified POST …/billing-nightly (optional if derived; legacy AUDIT unset)
#   BILLING_AUDIT_DAILY_ENDPOINT_URL      legacy branch when BILLING_NIGHTLY_ENDPOINT_URL unset
#   INVOICE_NIGHTLY_ENDPOINT_URL          optional legacy
#   BELOW_MINIMUM_CHECK_ENDPOINT_URL      optional
#   ALLABOARD365_BACKEND_BASE_URL          or BACKEND_BASE_URL — derives unset endpoints
#   OPENENROLL_BACKEND_BASE_URL           deprecated alias
#   SKIP_BACKEND_PROMPT=1 CI=1           skip interactive prompt
#   SCHEDULED_JOB_API_KEY                 same as backend when set

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

RESOURCE_GROUP="${RESOURCE_GROUP:-AllAboard365}"
LOCATION="${LOCATION:-centralus}"
FUNC_APP_NAME="${BILLING_NIGHTLY_JOB_FUNC_APP_NAME:-allaboard365-billing-nightly-job}"

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
  if [[ -z "${BILLING_NIGHTLY_JOB_STORAGE_NAME:-}" ]]; then
    SUF="$(openssl rand -hex 4)"
    BILLING_NIGHTLY_JOB_STORAGE_NAME="allaboardbnj${SUF}"
  fi
  echo "Storage account:    $BILLING_NIGHTLY_JOB_STORAGE_NAME"
  if ! az storage account show --name "$BILLING_NIGHTLY_JOB_STORAGE_NAME" --resource-group "$RESOURCE_GROUP" &>/dev/null; then
    echo "Creating storage account $BILLING_NIGHTLY_JOB_STORAGE_NAME..."
    az storage account create \
      --name "$BILLING_NIGHTLY_JOB_STORAGE_NAME" \
      --resource-group "$RESOURCE_GROUP" \
      --location "$LOCATION" \
      --sku Standard_LRS
  else
    echo "Storage account $BILLING_NIGHTLY_JOB_STORAGE_NAME already exists."
  fi
  echo "Creating Function App $FUNC_APP_NAME..."
  az functionapp create \
    --name "$FUNC_APP_NAME" \
    --storage-account "$BILLING_NIGHTLY_JOB_STORAGE_NAME" \
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
  echo "Derive billing scheduler POST URLs (Enter = prod ${DEFAULT_ALLABOARD365_BACKEND_ORIGIN})."
  read -r -p "AllAboard365 API HTTPS origin [staging override, or Enter for prod]: " _reply || true
  BACKEND_ORIGIN="$(_backend_origin_trim "${_reply:-}")"
fi

if [[ -z "${BACKEND_ORIGIN}" ]]; then
  BACKEND_ORIGIN="${DEFAULT_ALLABOARD365_BACKEND_ORIGIN}"
  echo "Using default AllAboard365 API origin: ${BACKEND_ORIGIN}"
fi

if [[ -n "${BACKEND_ORIGIN}" ]]; then
  _B="${BACKEND_ORIGIN%/}"
  if [[ -z "${BILLING_NIGHTLY_ENDPOINT_URL:-}" && -z "${BILLING_AUDIT_DAILY_ENDPOINT_URL:-}" ]]; then
    BILLING_NIGHTLY_ENDPOINT_URL="${_B}/api/scheduled-jobs/billing-nightly"
    echo "→ Derived BILLING_NIGHTLY_ENDPOINT_URL (unified orchestrator)"
  fi
  if [[ -z "${BELOW_MINIMUM_CHECK_ENDPOINT_URL:-}" ]]; then
    BELOW_MINIMUM_CHECK_ENDPOINT_URL="${_B}/api/scheduled-jobs/below-minimum-check"
    echo "→ Derived BELOW_MINIMUM_CHECK_ENDPOINT_URL"
  fi
fi

SETTINGS=()
if [[ -n "${BILLING_NIGHTLY_ENDPOINT_URL:-}" ]]; then
  SETTINGS+=("BILLING_NIGHTLY_ENDPOINT_URL=$BILLING_NIGHTLY_ENDPOINT_URL")
fi
if [[ -n "${BILLING_AUDIT_DAILY_ENDPOINT_URL:-}" ]]; then
  SETTINGS+=("BILLING_AUDIT_DAILY_ENDPOINT_URL=$BILLING_AUDIT_DAILY_ENDPOINT_URL")
fi
if [[ -n "${INVOICE_NIGHTLY_ENDPOINT_URL:-}" ]]; then
  SETTINGS+=("INVOICE_NIGHTLY_ENDPOINT_URL=$INVOICE_NIGHTLY_ENDPOINT_URL")
fi
if [[ -n "${BELOW_MINIMUM_CHECK_ENDPOINT_URL:-}" ]]; then
  SETTINGS+=("BELOW_MINIMUM_CHECK_ENDPOINT_URL=$BELOW_MINIMUM_CHECK_ENDPOINT_URL")
fi
# Must match AllAboard365-Backend SCHEDULED_JOB_API_KEY or nightly POSTs return 401.
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
  echo "No URLs in env — set app settings manually:"
  echo "  az functionapp config appsettings set --name $FUNC_APP_NAME --resource-group $RESOURCE_GROUP \\"
  echo "    --settings BILLING_NIGHTLY_ENDPOINT_URL='https://YOUR-HOST/api/scheduled-jobs/billing-nightly' \\"
  echo "               BELOW_MINIMUM_CHECK_ENDPOINT_URL='https://YOUR-HOST/api/scheduled-jobs/below-minimum-check' \\"
  echo "               SCHEDULED_JOB_API_KEY='...'"
fi

echo ""
echo "Deploying (see deploy.sh)..."
"$SCRIPT_DIR/deploy.sh"
