#!/bin/bash

# Sharewell Database Query Script
# Usage: ./db-query-sharewell.sh "SELECT * FROM partners"
# Usage: ./db-query-sharewell.sh "SELECT ..."
#
# Credentials: SHAREWELL_DB_* in ai_scripts/.env (see env.template).
# Prereq: copy env.template to .env and fill Sharewell values; passwords with $ must be single-quoted.
#
# If blocked by firewall (client IP not allowed): whitelist current IP then retry:
#   chmod +x ai_scripts/sharewell-whitelist-my-ip.sh && ./ai_scripts/sharewell-whitelist-my-ip.sh
# Optional refresh from Azure (subscription ShareWELL-PROD):
#   az account set -s ShareWELL-PROD
#   az functionapp config appsettings list --name sharewell-csv-processor2 --resource-group ShareWELLPartners \
#     --query "[?name=='SQL_SERVER' || name=='SQL_DATABASE' || name=='SQL_USERNAME' || name=='SQL_PASSWORD']" -o table

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/../backend" && pwd)"

if [ -z "$1" ]; then
    echo "Usage: ./db-query-sharewell.sh \"SELECT * FROM partners\""
    echo ""
    echo "Examples:"
    echo "  ./db-query-sharewell.sh \"SELECT id, partner_name, partner_id FROM partners ORDER BY partner_name\""
    echo "  ./db-query-sharewell.sh \"SELECT a.id, a.account_name, p.partner_name FROM accounts a JOIN partners p ON p.id = a.partner_id\""
    exit 1
fi

QUERY="$1"

# Load only SHAREWELL_* from ai_scripts/.env (do not source whole file — other keys may be unquoted/special).
strip_outer_quotes() {
    local v="$1"
    if [ "${#v}" -ge 2 ] && [ "${v#\'}" != "$v" ] && [ "${v%\'}" != "$v" ]; then
        v="${v#\'}"
        v="${v%\'}"
    elif [ "${#v}" -ge 2 ] && [ "${v#\"}" != "$v" ] && [ "${v%\"}" != "$v" ]; then
        v="${v#\"}"
        v="${v%\"}"
    fi
    printf '%s' "$v"
}

if [ -f "$SCRIPT_DIR/.env" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
        line="${line%$'\r'}"
        case "$line" in
            ''|\#*) continue ;;
        esac
        case "$line" in
            SHAREWELL_DB_SERVER=*|SHAREWELL_DB_DATABASE=*|SHAREWELL_DB_USER=*|SHAREWELL_DB_PASSWORD=*) ;;
            *) continue ;;
        esac
        key="${line%%=*}"
        key="${key//[[:space:]]/}"
        val="${line#*=}"
        val="${val#"${val%%[![:space:]]*}"}"
        val="${val%"${val##*[![:space:]]}"}"
        val="$(strip_outer_quotes "$val")"
        case "$key" in
            SHAREWELL_DB_SERVER) SHAREWELL_DB_SERVER="$val" ;;
            SHAREWELL_DB_DATABASE) SHAREWELL_DB_DATABASE="$val" ;;
            SHAREWELL_DB_USER) SHAREWELL_DB_USER="$val" ;;
            SHAREWELL_DB_PASSWORD) SHAREWELL_DB_PASSWORD="$val" ;;
        esac
    done < "$SCRIPT_DIR/.env"
fi

DB_SERVER="${SHAREWELL_DB_SERVER//[[:space:]]/}"
DB_NAME="${SHAREWELL_DB_DATABASE:-ShareWELLPartners}"
DB_NAME="${DB_NAME//[[:space:]]/}"
DB_USER="${SHAREWELL_DB_USER//[[:space:]]/}"
DB_PASSWORD="${SHAREWELL_DB_PASSWORD}"

if [ -z "$DB_PASSWORD" ] || [ -z "$DB_SERVER" ] || [ -z "$DB_USER" ]; then
    echo "❌ Missing SHAREWELL_DB_SERVER, SHAREWELL_DB_USER, or SHAREWELL_DB_PASSWORD."
    echo "   Set them in $SCRIPT_DIR/.env (see env.template)."
    exit 1
fi

echo "📊 Using credentials from ai_scripts/.env (Sharewell)"
echo "📌 Target: $DB_SERVER / $DB_NAME"

cd "$BACKEND_DIR" && DB_SERVER="$DB_SERVER" DB_NAME="$DB_NAME" DB_USER="$DB_USER" DB_PASSWORD="$DB_PASSWORD" node -e "
const sql = require('mssql');
const config = {
  server: process.env.DB_SERVER,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  options: {
    encrypt: true,
    trustServerCertificate: false
  }
};

async function runQuery() {
  try {
    console.log('🔍 Connecting...');
    await sql.connect(config);
    console.log('✅ Connected');
    const result = await sql.query(\`$QUERY\`);
    console.log('📋 Results:');
    if (result.recordset) {
      console.log(JSON.stringify(result.recordset, null, 2));
      console.log('📊 Total records:', result.recordset.length);
    } else {
      console.log('[]');
      console.log('📊 Rows affected:', result.rowsAffected || []);
    }
    await sql.close();
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

runQuery();
"
