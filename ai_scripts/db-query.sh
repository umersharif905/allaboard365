#!/bin/bash

# OpenEnroll Database Query Script
# Usage: ./db-query.sh "SELECT * FROM oe.Users WHERE Status = 'Active'"
# Usage: ./db-query.sh "SELECT ..." --alt   (alternative database)
# Usage: ./db-query.sh "SELECT ..." --testing   (allaboard-testing DB, same server as prod)

# Load environment variables from ai_scripts/.env
# Use `set -a; source <file>; set +a` so quoted values (including passwords
# containing $, *, !, etc.) are preserved verbatim. The previous
# `export $(grep | xargs)` approach silently mangled passwords with `$*`
# (xargs strips quotes, then export re-expands $* to empty).
ENV_FILE=""
if [ -f ".env" ]; then
    ENV_FILE=".env"
elif [ -f "ai_scripts/.env" ]; then
    ENV_FILE="ai_scripts/.env"
else
    echo "❌ Error: .env file not found. Please create ai_scripts/.env with database credentials."
    echo "💡 Copy ai_scripts/env.template to ai_scripts/.env and update with your credentials."
    exit 1
fi
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

# Check if query is provided
if [ -z "$1" ]; then
    echo "Usage: ./db-query.sh \"SELECT * FROM oe.Users WHERE Status = 'Active'\""
    echo "        ./db-query.sh \"SELECT ...\" --alt             (alternative database)"
    echo "        ./db-query.sh \"SELECT ...\" --testing          (allaboard-testing + DB_USER_TESTING_RW)"
    echo "        ./db-query.sh \"SELECT ...\" --prod-readonly   (allaboard-prod + oe_ai_readonly)"
    echo "Default (no flag): same as --testing — testing DB + DB_USER_TESTING_RW when set."
    exit 1
fi

QUERY="$1"
USE_ALT_DB=false

# Check if --alt flag is provided
if [ "$2" = "--alt" ]; then
    USE_ALT_DB=true
    echo "🔄 Using alternative database configuration"
fi

DB_LABEL=""

# Set database connection details based on flag
if [ "$USE_ALT_DB" = true ]; then
    DB_SERVER="${DB_SERVER_ALT:-allboard-prod.database.windows.net}"
    DB_NAME="${DB_NAME_ALT:-allaboard-prod}"
    DB_USER="${DB_USER_ALT:-readonly_user}"
    DB_PASSWORD="${DB_PASSWORD_ALT:-Read_Only_AI735!?@}"
    echo "📊 Connecting to alternative database: $DB_SERVER"
elif [ "${2:-}" = "--prod-readonly" ]; then
    DB_SERVER="${DB_SERVER:-allboard-prod.database.windows.net}"
    DB_NAME="allaboard-prod"
    DB_USER="${DB_USER:-oe_ai_readonly}"
    DB_PASSWORD="${DB_PASSWORD:?Set DB_PASSWORD (oe_ai_readonly) in ai_scripts/.env}"
    DB_LABEL=" (PROD READ-ONLY)"
    echo "📊 Production database — read-only login only"
elif [ "${2:-}" = "--testing" ] || [ -z "${2:-}" ]; then
    DB_SERVER="${DB_SERVER:-allboard-prod.database.windows.net}"
    DB_NAME="allaboard-testing"
    DB_USER="${DB_USER_TESTING_RW:-$DB_USER}"
    DB_PASSWORD="${DB_PASSWORD_TESTING_RW:-$DB_PASSWORD}"
    DB_LABEL=" (TESTING RW)"
    if [ -z "${2:-}" ]; then
        echo "🔄 Default: testing DB + DB_USER_TESTING_RW when set"
    else
        echo "🔄 Using testing database"
    fi
else
    echo "❌ Unknown option: ${2}. Use --testing, --prod-readonly, or --alt." >&2
    exit 1
fi

echo "📌 Target database: $DB_SERVER / $DB_NAME$DB_LABEL"

# Resolve OpenEnroll/backend from this script's directory (works from repo root or ai_scripts/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/../backend" && pwd)"
if [ ! -d "$BACKEND_DIR" ]; then
  echo "❌ backend directory not found at $BACKEND_DIR" >&2
  exit 1
fi

# Run the query using node from backend directory
cd "$BACKEND_DIR" && node -e "
const sql = require('mssql');
const config = {
  server: '$DB_SERVER',
  database: '$DB_NAME',
  user: '$DB_USER',
  password: '$DB_PASSWORD',
  options: {
    encrypt: true,
    trustServerCertificate: false
  }
};

async function runQuery() {
  try {
    console.log('🔍 Connecting to database...');
    await sql.connect(config);
    console.log('✅ Connected successfully');
    
    console.log('📊 Executing query...');
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
    console.log('✅ Connection closed');
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

runQuery();
"



