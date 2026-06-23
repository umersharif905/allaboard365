#!/bin/bash

# Sharewell Database Execute Script - run multi-statement SQL files
# Usage: ./db-execute-sharewell.sh "path/to/script.sql"
#
# Credentials: Same as db-query-sharewell.sh (config.local, .env, or Azure)
# Prereq: az login, az account set -s ShareWELL-PROD (if using Azure)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/../backend" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ -z "$1" ]; then
    echo "Usage: ./ai_scripts/db-execute-sharewell.sh \"path/to/script.sql\""
    echo ""
    echo "Examples:"
    echo "  ./ai_scripts/db-execute-sharewell.sh sharewell-csv-processor/sql/pricing/create-partner-invoice-pricing.sql"
    echo "  ./ai_scripts/db-execute-sharewell.sh sharewell-csv-processor/sql/pricing/insert-pricing-mpowering-benefits.sql"
    exit 1
fi

SQL_FILE="$1"
if [[ "$SQL_FILE" != /* ]]; then
    SQL_FILE_ABS="$REPO_ROOT/$SQL_FILE"
else
    SQL_FILE_ABS="$SQL_FILE"
fi

if [ ! -f "$SQL_FILE_ABS" ]; then
    echo "❌ Error: SQL file not found: $SQL_FILE_ABS"
    exit 1
fi

# Load credentials (same as db-query-sharewell.sh)
if [ -z "$SHAREWELL_DB_PASSWORD" ] && [ -z "$SHAREWELL_DB_SERVER" ]; then
    for f in "sharewell-csv-processor/documents/config.local" "sharewell-csv-processor/documents/.env" "sharewell-csv-processor/.env"; do
        CFG="$REPO_ROOT/$f"
        if [ -f "$CFG" ]; then
            while IFS='=' read -r key val; do
                key="${key//[[:space:]]/}"
                val="${val//$'\r'/}"
                val="${val#"${val%%[![:space:]]*}"}"
                val="${val%"${val##*[![:space:]]}"}"
                case "$key" in SQL_SERVER) SHAREWELL_DB_SERVER="$val" ;; SQL_DATABASE) SHAREWELL_DB_DATABASE="$val" ;; SQL_USERNAME) SHAREWELL_DB_USER="$val" ;; SQL_PASSWORD) SHAREWELL_DB_PASSWORD="$val" ;; esac
            done < <(grep -E '^SQL_(SERVER|DATABASE|USERNAME|PASSWORD)=' "$CFG" 2>/dev/null)
            [ -n "$SHAREWELL_DB_SERVER" ] && break
        fi
    done
fi

if [ -n "$SHAREWELL_DB_PASSWORD" ] && [ -n "$SHAREWELL_DB_SERVER" ]; then
    DB_SERVER="${SHAREWELL_DB_SERVER//[[:space:]]/}"
    DB_NAME="${SHAREWELL_DB_DATABASE:-ShareWELLPartners}"
    DB_NAME="${DB_NAME//[[:space:]]/}"
    DB_USER="${SHAREWELL_DB_USER//[[:space:]]/}"
    DB_PASSWORD="${SHAREWELL_DB_PASSWORD}"
    echo "📊 Using credentials from environment"
else
    echo "🔐 Fetching Sharewell DB credentials from Azure..."
    DB_SERVER=$(az functionapp config appsettings list \
        --name sharewell-csv-processor2 \
        --resource-group ShareWELLPartners \
        --query "[?name=='SQL_SERVER'].value | [0]" -o tsv 2>/dev/null)
    DB_NAME=$(az functionapp config appsettings list \
        --name sharewell-csv-processor2 \
        --resource-group ShareWELLPartners \
        --query "[?name=='SQL_DATABASE'].value | [0]" -o tsv 2>/dev/null)
    DB_USER=$(az functionapp config appsettings list \
        --name sharewell-csv-processor2 \
        --resource-group ShareWELLPartners \
        --query "[?name=='SQL_USERNAME'].value | [0]" -o tsv 2>/dev/null)
    DB_PASSWORD=$(az functionapp config appsettings list \
        --name sharewell-csv-processor2 \
        --resource-group ShareWELLPartners \
        --query "[?name=='SQL_PASSWORD'].value | [0]" -o tsv 2>/dev/null)

    if [ -z "$DB_PASSWORD" ] || [ -z "$DB_SERVER" ]; then
        echo "❌ Could not fetch credentials. Run: az login && az account set -s ShareWELL-PROD"
        exit 1
    fi
fi

echo "📌 Target: $DB_SERVER / $DB_NAME"
echo "📝 Executing: $SQL_FILE_ABS"
echo ""

cd "$BACKEND_DIR" && \
  DB_SERVER="$DB_SERVER" DB_NAME="$DB_NAME" DB_USER="$DB_USER" DB_PASSWORD="$DB_PASSWORD" SQL_FILE_PATH="$SQL_FILE_ABS" \
  node -e "
const sql = require('mssql');
const fs = require('fs');

const config = {
  server: process.env.DB_SERVER,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  options: {
    encrypt: true,
    trustServerCertificate: false,
    requestTimeout: 300000
  }
};

async function run() {
  try {
    await sql.connect(config);
    const content = fs.readFileSync(process.env.SQL_FILE_PATH, 'utf8');
    const result = await sql.query(content);
    console.log('✅ Script executed successfully');
    if (result.recordset && result.recordset.length > 0) {
      console.log('');
      console.log('📋 Result:');
      console.log(JSON.stringify(result.recordset, null, 2));
    }
    await sql.close();
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}
run();
"
