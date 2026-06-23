#!/bin/bash
# Deploy OpenEnroll frontend to Azure App Service (zip deploy).
# Builds frontend, then zips dist and deploys. Requires: az CLI logged in (az login).
#
# Usage: from repo root:  ./ai_scripts/deploy-frontend.sh
#    or: from ai_scripts: ./deploy-frontend.sh

set -e

RESOURCE_GROUP="${RESOURCE_GROUP:-AllAboard365}"
# Same app as backend for single–app setup; override with FRONTEND_APP_NAME if you add a separate frontend app
APP_NAME="${FRONTEND_APP_NAME:-AllAboard365}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/../frontend/package.json" ]; then
  REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
elif [ -f "frontend/package.json" ]; then
  REPO_ROOT="$(pwd)"
else
  REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
fi
FRONTEND_DIR="$REPO_ROOT/frontend"
ZIP_PATH="$REPO_ROOT/frontend-deploy.zip"

echo "Resource group: $RESOURCE_GROUP"
echo "App Service:    $APP_NAME"
echo "Frontend dir:   $FRONTEND_DIR"

if ! command -v az &>/dev/null; then
  echo "Error: az CLI not found. Install Azure CLI and run 'az login'."
  exit 1
fi

echo "Building frontend..."
cd "$FRONTEND_DIR"
npm run build
cd dist
zip -r "$ZIP_PATH" .
cd "$REPO_ROOT"

echo "Deploying zip to $APP_NAME..."
az webapp deploy --resource-group "$RESOURCE_GROUP" --name "$APP_NAME" --src-path "$ZIP_PATH" --type zip

echo "Done. Frontend should be live at https://${APP_NAME}.azurewebsites.net (or your custom domain)."
echo "Ensure App Service Startup Command is: node server.js"
echo "Set Application settings: VITE_API_URL, VITE_OAUTH_URL, BRAND (see docs/FRONTEND_DEPLOYMENT.md)."
