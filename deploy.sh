#!/usr/bin/env bash
# Deploy payment manager to Azure Function App (allaboard-payment-manager).
# Run from repo root: ./oe_payment_manager/deploy.sh
# Or from oe_payment_manager: ./deploy.sh
# To use a different app name: PAYMENT_MANAGER_APP_NAME=my-app ./oe_payment_manager/deploy.sh

set -e
APP_NAME="${PAYMENT_MANAGER_APP_NAME:-allaboard-payment-manager}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "Deploying from $SCRIPT_DIR to $APP_NAME..."
func azure functionapp publish "$APP_NAME"
echo "Done."
