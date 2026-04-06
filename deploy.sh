#!/usr/bin/env bash
# Deploy payment manager to Azure Function App (allaboard-payment-manager).
# Run from repo root: ./oe_payment_manager/deploy.sh
# Or from oe_payment_manager: ./deploy.sh
# To use a different app name: PAYMENT_MANAGER_APP_NAME=my-app ./oe_payment_manager/deploy.sh

set -e
APP_NAME="${PAYMENT_MANAGER_APP_NAME:-allaboard-payment-manager}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$SCRIPT_DIR"

# Azure publish has no repo parent — vendor shared modules (same pattern as payment-status).
rm -rf "$SCRIPT_DIR/shared/payment-product-snapshots"
mkdir -p "$SCRIPT_DIR/shared"
cp -R "$REPO_ROOT/shared/payment-product-snapshots" "$SCRIPT_DIR/shared/"

echo "Deploying from $SCRIPT_DIR to $APP_NAME..."
# Install deps so Oryx / remote build has a valid package-lock; --build remote runs npm on Azure Linux.
npm ci --omit=dev
func azure functionapp publish "$APP_NAME" --build remote
echo "Done."
