#!/usr/bin/env bash
# Deploy ai_inspector timer to an existing Azure Function App (zip + remote build).
# Requires: az CLI, zip. Run from repo: ./deploy.sh
#
# Environment (optional):
#   RESOURCE_GROUP                  default: AllAboard365
#   AI_INSPECTOR_FUNC_APP_NAME     default: allaboard-ai-inspector

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

RESOURCE_GROUP="${RESOURCE_GROUP:-AllAboard365}"
FUNC_APP_NAME="${AI_INSPECTOR_FUNC_APP_NAME:-allaboard-ai-inspector}"

echo "Subscription (current):"
az account show --query '{name:name, id:id}' -o table 2>/dev/null || { echo "Run: az login"; exit 1; }
echo ""
echo "Resource group: $RESOURCE_GROUP"
echo "Function app:   $FUNC_APP_NAME"
echo ""

if ! az functionapp show --name "$FUNC_APP_NAME" --resource-group "$RESOURCE_GROUP" &>/dev/null; then
  echo "❌ Function App '$FUNC_APP_NAME' not found in $RESOURCE_GROUP."
  echo "   Create it first with create-and-deploy.sh, or set RESOURCE_GROUP / AI_INSPECTOR_FUNC_APP_NAME."
  exit 1
fi

echo "Installing production dependencies..."
npm install --omit=dev --no-audit --no-fund 2>&1

echo "Deploying via zip (Azure CLI; includes node_modules for consumption plan)..."
ZIP="/tmp/allaboard-ai-inspector-deploy-$$.zip"
rm -f "$ZIP"
(
  cd "$SCRIPT_DIR"
  zip -rq "$ZIP" . -x ".git/*" -x ".gitignore" -x "local.settings.json" -x "create-and-deploy.sh" -x "deploy.sh" -x "*.zip"
)
az functionapp deployment source config-zip \
  --resource-group "$RESOURCE_GROUP" \
  --name "$FUNC_APP_NAME" \
  --src "$ZIP"
rm -f "$ZIP"

echo ""
echo "Done. Function App URL: https://${FUNC_APP_NAME}.azurewebsites.net"
echo "Timer: LogInspector (top of every hour) — AI-powered log analysis for all App Services."
