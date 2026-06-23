#!/usr/bin/env bash
# Add your current public IPv4 to Azure SQL firewall for swp-sql-srvr.
# Prereq: az login (subscription must contain the server; default ShareWELL-PROD).
#
# Usage:
#   ./ai_scripts/sharewell-whitelist-my-ip.sh
# Env overrides:
#   SHAREWELL_AZ_SUBSCRIPTION   (default: ShareWELL-PROD)
#   SHAREWELL_SQL_RG            (default: ShareWELLPartners)
#   SHAREWELL_SQL_SERVER_NAME   (default: swp-sql-srvr)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUB="${SHAREWELL_AZ_SUBSCRIPTION:-ShareWELL-PROD}"
RG="${SHAREWELL_SQL_RG:-ShareWELLPartners}"
SERVER="${SHAREWELL_SQL_SERVER_NAME:-swp-sql-srvr}"

MYIP=$(curl -sS --max-time 10 https://api.ipify.org || true)
if [[ -z "$MYIP" || "$MYIP" =~ [^0-9.] ]]; then
  echo "❌ Could not resolve public IP (api.ipify.org)." >&2
  exit 1
fi

RULE="${SHAREWELL_FIREWALL_RULE_PREFIX:-cursor_cli}_$(date +%Y%m%d_%H%M%S)"

echo "📌 Subscription: $SUB"
echo "📌 Server:       $SERVER (resource group: $RG)"
echo "📌 Your IPv4:    $MYIP"
echo "📌 Rule name:    $RULE"

az account set --subscription "$SUB"

az sql server firewall-rule create \
  --resource-group "$RG" \
  --server "$SERVER" \
  --name "$RULE" \
  --start-ip-address "$MYIP" \
  --end-ip-address "$MYIP"

echo "✅ Firewall rule created. Wait up to ~5 minutes if the first query still fails."
