#!/usr/bin/env bash
# Deploy message center to Azure Function App.
# Run from repo root: ./messageCenter/deploy.sh
# Or from messageCenter: ./deploy.sh
# To use a different app name: MESSAGE_CENTER_APP_NAME=my-app ./messageCenter/deploy.sh

set -e
APP_NAME="${MESSAGE_CENTER_APP_NAME:-allaboard-messagecenter}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -d node_modules ]; then
  echo "error: node_modules is missing. Run npm ci (or npm install) in messageCenter before deploying." >&2
  exit 1
fi

# Fail like Azure would if any production dependency is missing or broken (catches partial/corrupt installs).
echo "Checking node_modules (production dependencies load)..."
node -e "
  require('mssql');
  require('@sendgrid/mail');
  require('twilio');
  require('expo-server-sdk');
  require('@azure/functions');
" || {
  echo "error: node_modules is incomplete or dependencies cannot be loaded. Run npm ci in messageCenter and retry." >&2
  exit 1
}

echo "Deploying from $SCRIPT_DIR to $APP_NAME..."
func azure functionapp publish "$APP_NAME"
echo "Done."
