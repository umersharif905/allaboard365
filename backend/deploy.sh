#!/usr/bin/env bash
# Validate backend and deploy to Azure App Service. Only deploys if validation passes.
# Usage: ./backend/deploy.sh   or   BACKEND_APP_NAME=myapi RESOURCE_GROUP=MyRG ./backend/deploy.sh
#
# Bundles ../shared into backend/shared so require('../shared/...') works under wwwroot.

set -euo pipefail

RESOURCE_GROUP="${RESOURCE_GROUP:-AllAboard365}"
APP_NAME="${BACKEND_APP_NAME:-allaboard365-backend}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ZIP_PATH="$REPO_ROOT/backend-deploy.zip"
SHARED_PAYMENT_STATUS="$REPO_ROOT/shared/payment-status/index.js"
SHARED_SNAPSHOTS="$REPO_ROOT/shared/payment-product-snapshots/index.js"

cleanup() {
  rm -rf "$SCRIPT_DIR/shared"
  rm -f "$ZIP_PATH"
}

for cmd in node az zip unzip; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "Error: '$cmd' is required but not installed or not on PATH." >&2
    exit 1
  }
done

if [ ! -f "$SHARED_PAYMENT_STATUS" ] || [ ! -f "$SHARED_SNAPSHOTS" ]; then
  echo "Error: repo shared/ is missing required files." >&2
  echo "  Expected: $SHARED_PAYMENT_STATUS" >&2
  echo "  Expected: $SHARED_SNAPSHOTS" >&2
  exit 1
fi

cd "$SCRIPT_DIR"
echo "Validating backend (syntax check)..."
node -c app.js

echo "Validating Azure-safe shared module paths (static)..."
node scripts/validate-deploy.js

echo "Bundling repo shared/ into backend/shared (required at runtime)..."
rm -rf "$SCRIPT_DIR/shared"
cp -R "$REPO_ROOT/shared" "$SCRIPT_DIR/shared"
trap cleanup EXIT

echo "Validating module resolution (Azure simulation smoke test)..."
node scripts/validate-deploy.js --smoke

echo "Creating deploy zip (excluding node_modules, .env, .git)..."
# Always recreate — incremental zip -r on an existing archive can skip newly bundled shared/.
rm -f "$ZIP_PATH"
zip -r "$ZIP_PATH" . -x "node_modules/*" -x ".env" -x ".git/*" -x "*.zip"

echo "Verifying zip contains shared modules..."
# grep -q + pipefail makes unzip SIGPIPE (141) when the match is found — use grep -F without -q.
unzip -l "$ZIP_PATH" | grep -F 'shared/payment-status/index.js' >/dev/null || {
  echo "Error: zip is missing shared/payment-status/index.js — deploy aborted." >&2
  exit 1
}
unzip -l "$ZIP_PATH" | grep -F 'shared/payment-product-snapshots/index.js' >/dev/null || {
  echo "Error: zip is missing shared/payment-product-snapshots/index.js — deploy aborted." >&2
  exit 1
}

echo "Deploying to $APP_NAME (resource group: $RESOURCE_GROUP)..."
az webapp deploy --resource-group "$RESOURCE_GROUP" --name "$APP_NAME" --src-path "$ZIP_PATH" --type zip

echo "Backend deployed successfully."
