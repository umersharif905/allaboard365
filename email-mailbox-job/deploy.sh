#!/usr/bin/env bash
# Deploy email-mailbox-job timers to an existing Azure Function App (zip + remote build).
# Requires: az CLI, zip. Run from repo: ./email-mailbox-job/deploy.sh
#
# Environment (optional):
#   RESOURCE_GROUP                      default: AllAboard365
#   EMAIL_MAILBOX_JOB_FUNC_APP_NAME     default: allaboard365-email-mailbox-job

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

RESOURCE_GROUP="${RESOURCE_GROUP:-AllAboard365}"
FUNC_APP_NAME="${EMAIL_MAILBOX_JOB_FUNC_APP_NAME:-allaboard365-email-mailbox-job}"

echo "Subscription (current):"
az account show --query '{name:name, id:id}' -o table 2>/dev/null || { echo "Run: az login"; exit 1; }
echo ""
echo "Resource group: $RESOURCE_GROUP"
echo "Function app:   $FUNC_APP_NAME"
echo ""

if ! az functionapp show --name "$FUNC_APP_NAME" --resource-group "$RESOURCE_GROUP" &>/dev/null; then
  echo "❌ Function App '$FUNC_APP_NAME' not found in $RESOURCE_GROUP."
  echo "   Create it first with create-and-deploy.sh, or set RESOURCE_GROUP / EMAIL_MAILBOX_JOB_FUNC_APP_NAME."
  exit 1
fi

echo "Deploying via zip (Azure CLI; Oryx builds on the Function App)..."
ZIP="/tmp/allaboard-email-mailbox-job-deploy-$$.zip"
rm -f "$ZIP"
(
  cd "$SCRIPT_DIR"
  zip -rq "$ZIP" . -x "node_modules/*" -x ".git/*"
)
az functionapp deployment source config-zip \
  --resource-group "$RESOURCE_GROUP" \
  --name "$FUNC_APP_NAME" \
  --src "$ZIP"
rm -f "$ZIP"

echo ""
echo "Done. Function App URL: https://${FUNC_APP_NAME}.azurewebsites.net"
echo "Timers: SubscriptionRenewal (every 6h), MailboxReconcile (every 5 min)."
