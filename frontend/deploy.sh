#!/usr/bin/env bash
# Build frontend and deploy to Azure App Service. Exits on failure; only deploys if build succeeds.
# Usage: ./frontend/deploy.sh   or   FRONTEND_APP_NAME=myapp RESOURCE_GROUP=MyRG ./frontend/deploy.sh

set -e
RESOURCE_GROUP="${RESOURCE_GROUP:-AllAboard365}"
APP_NAME="${FRONTEND_APP_NAME:-AllAboard365}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ZIP_PATH="$REPO_ROOT/frontend-deploy.zip"

cd "$SCRIPT_DIR"
echo "Building frontend..."
npm run build
echo "Build succeeded. Creating deploy zip..."
cd dist
zip -r "$ZIP_PATH" .
cd "$SCRIPT_DIR"
echo "Deploying to $APP_NAME (resource group: $RESOURCE_GROUP)..."
az webapp deploy --resource-group "$RESOURCE_GROUP" --name "$APP_NAME" --src-path "$ZIP_PATH" --type zip
rm -f "$ZIP_PATH"
echo "Frontend deployed successfully."
