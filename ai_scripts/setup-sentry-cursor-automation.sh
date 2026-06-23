#!/usr/bin/env bash
# Configure Sentry → OpenEnroll backend webhook → Cursor Automation pipeline.
#
# Prerequisites:
#   - backend/.env with BUG_REPORT_WEBHOOK_URL + BUG_REPORT_WEBHOOK_BEARER_TOKEN
#   - SENTRY_AUTH_TOKEN with project:write + org:read (for API setup)
#   - Backend deployed with /api/webhooks/sentry route
#
# Usage:
#   ./ai_scripts/setup-sentry-cursor-automation.sh
#   SENTRY_AUTH_TOKEN=sntrys_... ./ai_scripts/setup-sentry-cursor-automation.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/backend/.env"
WEBHOOK_PATH="/api/webhooks/sentry"
BACKEND_PROJECT_ID="4511265725284352"
FRONTEND_PROJECT_ID="4511265712766976"

load_env() {
  (cd "$ROOT/backend" && node -e "
    require('dotenv').config({ path: process.argv[1] });
    const keys = [
      'BUG_REPORT_WEBHOOK_URL',
      'BUG_REPORT_WEBHOOK_BEARER_TOKEN',
      'SENTRY_AUTH_TOKEN',
      'SENTRY_WEBHOOK_SECRET',
    ];
    for (const key of keys) {
      if (process.env[key]) {
        process.stdout.write(\`\${key}=\${process.env[key]}\n\`);
      }
    }
  " "$ENV_FILE")
}

if [ -f "$ENV_FILE" ]; then
  while IFS='=' read -r key value; do
    [ -n "$key" ] && export "$key=$value"
  done < <(load_env)
fi

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "Missing required env var: $name" >&2
    exit 1
  fi
}

echo "==> 1/5 Verify Cursor automation webhook"
require_env BUG_REPORT_WEBHOOK_URL
require_env BUG_REPORT_WEBHOOK_BEARER_TOKEN

(
  cd "$ROOT/backend"
  node -e "
    require('dotenv').config({ path: '../backend/.env' });
    const { publishBugReport } = require('./services/bugReportWebhookService');
    publishBugReport({
      context: 'OpenEnroll Sentry automation setup verification',
      payload: { source: 'setup-sentry-cursor-automation', timestamp: new Date().toISOString() }
    }).then((result) => {
      console.log('Cursor webhook OK:', JSON.stringify(result));
    }).catch((err) => {
      console.error('Cursor webhook failed:', err.response?.status || err.message);
      process.exit(1);
    });
  "
)

PUBLIC_API_URL="${PUBLIC_API_URL:-https://api.allaboard365.com}"
WEBHOOK_URL="${PUBLIC_API_URL}${WEBHOOK_PATH}"
echo "Sentry should POST to: $WEBHOOK_URL"

if [ -z "${SENTRY_AUTH_TOKEN:-}" ]; then
  cat <<EOF

==> 2/5 SENTRY_AUTH_TOKEN not set — manual Sentry setup required

In Sentry (https://sentry.io):
1. Settings → Integrations → GitHub → Install and link this repo
2. Settings → Developer Settings → Internal Integrations → Create New Integration
   - Name: OpenEnroll Cursor Automation
   - Webhook URL: $WEBHOOK_URL
   - Webhook secret: use the existing SENTRY_WEBHOOK_SECRET from backend/.env (already synced to Azure)
   - Permissions: Issue & Event → Read
   - Webhooks: Issue → created, unresolved; Event Alert → triggered
3. Settings → Projects → backend ($BACKEND_PROJECT_ID) → Alerts → Create Alert
   - When: A new issue is created OR issue changes to unresolved
   - If: environment equals production
   - Then: Send notification to your Internal Integration
4. Repeat alert rule for frontend project ($FRONTEND_PROJECT_ID) if desired
5. Settings → Integrations → Cursor Agent → Install with your Cursor API key
6. Project → Seer → enable automation, set Coding Agent = Cursor Cloud Agent, stop after PR Drafted

Add to backend/.env and Azure App Service:
  SENTRY_DSN=<backend DSN from Azure>
  SENTRY_WEBHOOK_SECRET=<secret from step 2>
  SENTRY_CURSOR_AUTOMATION_ENABLED=true
  SENTRY_CURSOR_ENVIRONMENTS=production
  SENTRY_CURSOR_MIN_EVENTS=1

For frontend source maps during deploy, also set on the build machine / Azure:
  SENTRY_AUTH_TOKEN=sntrys_...
  SENTRY_ORG=<org slug>
  SENTRY_PROJECT=<frontend project slug>
  SENTRY_RELEASE=\$VITE_APP_VERSION

EOF
  exit 0
fi

echo "==> 2/5 Discover Sentry org/project slugs"
ORG_JSON="$(curl -fsS -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" https://sentry.io/api/0/organizations/)"
ORG_SLUG="$(node -e "const orgs=JSON.parse(process.argv[1]); const match=orgs.find(o=>String(o.id)==='4511259885305856'||o.slug); console.log((orgs.find(o=>String(o.id)==='4511259885305856')||orgs[0]||{}).slug||'');" "$ORG_JSON")"

if [ -z "$ORG_SLUG" ]; then
  echo "Could not resolve Sentry org slug from API response" >&2
  exit 1
fi

echo "Using org: $ORG_SLUG"

PROJECTS_JSON="$(curl -fsS -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" "https://sentry.io/api/0/organizations/$ORG_SLUG/projects/")"
BACKEND_PROJECT_SLUG="$(node -e "const projects=JSON.parse(process.argv[1]); console.log((projects.find(p=>String(p.id)==='$BACKEND_PROJECT_ID')||{}).slug||'');" "$PROJECTS_JSON")"
FRONTEND_PROJECT_SLUG="$(node -e "const projects=JSON.parse(process.argv[1]); console.log((projects.find(p=>String(p.id)==='$FRONTEND_PROJECT_ID')||{}).slug||'');" "$PROJECTS_JSON")"

echo "Backend project slug: ${BACKEND_PROJECT_SLUG:-unknown}"
echo "Frontend project slug: ${FRONTEND_PROJECT_SLUG:-unknown}"

if [ -z "${SENTRY_WEBHOOK_SECRET:-}" ]; then
  SENTRY_WEBHOOK_SECRET="$(openssl rand -hex 32)"
  echo "Generated SENTRY_WEBHOOK_SECRET=$SENTRY_WEBHOOK_SECRET"
  echo "Add this to backend/.env and Azure before deploying."
fi

echo "==> 3/5 Ensure Internal Integration exists"
INTEGRATIONS_JSON="$(curl -fsS -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" "https://sentry.io/api/0/organizations/$ORG_SLUG/sentry-app-installations/")"
echo "Found $(node -e "console.log(JSON.parse(process.argv[1]).length)" "$INTEGRATIONS_JSON") installed integrations."
echo "If no OpenEnroll Cursor bridge exists yet, create it in Sentry UI with webhook URL:"
echo "  $WEBHOOK_URL"
echo "and secret:"
echo "  $SENTRY_WEBHOOK_SECRET"

echo "==> 4/5 Cursor automation instructions"
cat <<'INSTRUCTIONS'

Update your existing Cursor automation (webhook f40702f9-...) at cursor.com/automations:

Tools to enable:
  - Open pull request
  - Memories
  - Sentry MCP (authenticate with Inspect Issues + Triage Issues)

Paste instructions from:
  .cursor/sentry-fix-automation-instructions.md

INSTRUCTIONS

echo "==> 5/5 Local env checklist"
cat <<EOF
backend/.env:
  SENTRY_DSN=<already in Azure>
  SENTRY_WEBHOOK_SECRET=$SENTRY_WEBHOOK_SECRET
  SENTRY_CURSOR_AUTOMATION_ENABLED=true
  SENTRY_CURSOR_ENVIRONMENTS=production

frontend build env:
  SENTRY_AUTH_TOKEN=<set in CI/Azure for source map upload>
  SENTRY_ORG=$ORG_SLUG
  SENTRY_PROJECT=${FRONTEND_PROJECT_SLUG:-openenroll-frontend}
  SENTRY_RELEASE=<same as VITE_APP_VERSION>

Deploy backend after setting SENTRY_WEBHOOK_SECRET, then finish Sentry alert rules in UI.
EOF
