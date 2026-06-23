#!/bin/bash

# OpenEnroll Database Execute Script
# Usage: ./db-execute.sh "path/to/script.sql"
# Usage: ./db-execute.sh "path/to/script.sql" --alt (use alternative database)
# Usage: ./db-execute.sh "path/to/script.sql" --testing (allaboard-testing DB, same server as prod)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load environment variables from ai_scripts/.env
if [ -f "$SCRIPT_DIR/.env" ]; then
    export $(grep -v '^#' "$SCRIPT_DIR/.env" | xargs)
elif [ -f ".env" ]; then
    export $(grep -v '^#' .env | xargs)
elif [ -f "ai_scripts/.env" ]; then
    export $(grep -v '^#' ai_scripts/.env | xargs)
else
    echo "❌ Error: .env file not found. Please create ai_scripts/.env with database credentials."
    echo "💡 Copy ai_scripts/env.template to ai_scripts/.env and update with your credentials."
    exit 1
fi

# Check if SQL file is provided
if [ -z "$1" ]; then
    echo "Usage: ./ai_scripts/db-execute.sh \"path/to/script.sql\""
    echo "Usage: ./ai_scripts/db-execute.sh \"path/to/script.sql\" --alt (use alternative database)"
    echo "Usage: ./ai_scripts/db-execute.sh \"path/to/script.sql\" --testing (allaboard-testing)"
    exit 1
fi

SQL_FILE="$1"
USE_ALT_DB=false
TESTING_DB=false

for arg in "$@"; do
    if [ "$arg" = "--alt" ]; then
        USE_ALT_DB=true
        echo "🔄 Using alternative database configuration"
    fi
    if [ "$arg" = "--testing" ]; then
        TESTING_DB=true
        echo "🔄 Targeting allaboard-testing (see DB_NAME below)"
    fi
done

# Check if file exists
if [ ! -f "$SQL_FILE" ]; then
    echo "❌ Error: SQL file not found: $SQL_FILE"
    exit 1
fi

# Set database connection details based on flag
if [ "$USE_ALT_DB" = true ]; then
    DB_SERVER="${DB_SERVER_ALT:-allboard-prod.database.windows.net}"
    DB_NAME="${DB_NAME_ALT:-allaboard-prod}"
    DB_USER="${DB_USER_ALT:-readonly_user}"
    DB_PASSWORD="${DB_PASSWORD_ALT:-Read_Only_AI735!?@}"
    echo "📊 Connecting to alternative database: $DB_SERVER / $DB_NAME"
else
    DB_SERVER="${DB_SERVER:-allboard-prod.database.windows.net}"
    DB_NAME="${DB_NAME:-allaboard-testing}"
    DB_USER="${DB_USER:-oe-sqladmin}"
    DB_PASSWORD="${DB_PASSWORD:-PT\$r8u7G21@\$}"
    echo "📊 Connecting to primary database: $DB_SERVER / $DB_NAME"
fi
if [ "$TESTING_DB" = true ] && [ "$USE_ALT_DB" = false ]; then
    DB_NAME="allaboard-testing"
    if [ -n "${DB_USER_TESTING_RW:-}" ] && [ -n "${DB_PASSWORD_TESTING_RW:-}" ]; then
        DB_USER="$DB_USER_TESTING_RW"
        DB_PASSWORD="$DB_PASSWORD_TESTING_RW"
        echo "🔄 Using DB_USER_TESTING_RW for allaboard-testing (read/write)"
    fi
fi

echo "📌 Target database: $DB_SERVER / $DB_NAME"

# Get absolute path to SQL file
if [[ "$SQL_FILE" == /* ]]; then
    SQL_FILE_ABS="$SQL_FILE"
else
    SQL_FILE_ABS="$(pwd)/$SQL_FILE"
fi

BACKEND_DIR="$(cd "$SCRIPT_DIR/../backend" && pwd)"

# Run the SQL script using node from backend directory
cd "$BACKEND_DIR" && node -e "
const sql = require('mssql');
const fs = require('fs');
const path = require('path');

const config = {
  server: '$DB_SERVER',
  database: '$DB_NAME',
  user: '$DB_USER',
  password: '$DB_PASSWORD',
  options: {
    encrypt: true,
    trustServerCertificate: false,
    requestTimeout: 300000  // 5 minute timeout for long scripts
  }
};

async function executeScript() {
  try {
    console.log('🔍 Connecting to database...');
    await sql.connect(config);
    console.log('✅ Connected successfully');
    
    const sqlFile = '$SQL_FILE_ABS';
    console.log('📝 Reading SQL file:', sqlFile);
    const sqlContent = fs.readFileSync(sqlFile, 'utf8');
    
    console.log('📊 Executing SQL script...');
    console.log('');
    
    // Execute the script - request().query() handles multi-statement scripts
    const result = await sql.query(sqlContent);
    
    console.log('');
    console.log('✅ Script executed successfully!');
    if (result.rowsAffected) {
      console.log('📊 Rows affected:', result.rowsAffected);
    }
    // Print any result set (e.g. verification SELECT)
    if (result.recordset && result.recordset.length > 0) {
      console.log('');
      console.log('📋 Result:');
      console.log(JSON.stringify(result.recordset, null, 2));
      console.log('📊 Rows returned:', result.recordset.length);
    }
    
    await sql.close();
    console.log('✅ Connection closed');
  } catch (err) {
    console.error('');
    console.error('❌ Error:', err.message);
    if (err.originalError) {
      console.error('Original error:', err.originalError.message);
    }
    if (err.stack) {
      console.error('Stack:', err.stack.split('\\n').slice(0, 5).join('\\n'));
    }
    console.error('');
    process.exit(1);
  }
}

executeScript();
"

