#!/bin/bash
# Export active ShareWELL member emails to output/ShareWELL_active_member_emails_YYYY-MM-DD.txt
# Active = 1+ plan with effective_date <= today and termination_date null or > today.
# See docs/microsoft/SHAREWELL_DB_CREDENTIALS_AZ_CLI.md
# Usage: ./ai_scripts/export-sharewell-active-member-emails.sh

set -e
cd "$(dirname "$0")/.."

if [ -z "$SHAREWELL_DB_PASSWORD" ] && command -v az &>/dev/null; then
  SHAREWELL_DB_PASSWORD=$(az functionapp config appsettings list \
    --name sharewell-csv-processor2 \
    --resource-group ShareWELLPartners \
    --query "[?name=='SQL_PASSWORD'].value | [0]" -o tsv 2>/dev/null) || true
  [ -n "$SHAREWELL_DB_PASSWORD" ] && echo "Using password from az functionapp config appsettings"
fi

export SHAREWELL_DB_SERVER="${SHAREWELL_DB_SERVER:-swp-sql-srvr.database.windows.net}"
export SHAREWELL_DB_NAME="${SHAREWELL_DB_NAME:-ShareWELLPartners}"
export SHAREWELL_DB_USER="${SHAREWELL_DB_USER:-powerappslogin}"

node ai_scripts/export-sharewell-active-member-emails.cjs
