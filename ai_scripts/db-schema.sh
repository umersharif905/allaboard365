#!/bin/bash

# Database Schema Discovery Script
# This script connects to the Azure SQL database and extracts the complete schema
# Usage: ./db-schema.sh [table_name]
# Usage: ./db-schema.sh [table_name] --alt (use alternative database)
# If table_name is provided, only that table's schema will be shown

TABLE_NAME="$1"
USE_ALT_DB=false

# Check if --alt flag is provided
if [ "$2" = "--alt" ]; then
    USE_ALT_DB=true
    echo "🔄 Using alternative database configuration"
fi

# Load environment variables from ai_scripts/.env
if [ -f ".env" ]; then
    export $(grep -v '^#' .env | xargs)
elif [ -f "ai_scripts/.env" ]; then
    export $(grep -v '^#' ai_scripts/.env | xargs)
else
    echo "❌ Error: .env file not found. Please create ai_scripts/.env with database credentials."
    echo "💡 Copy ai_scripts/env.template to ai_scripts/.env and update with your credentials."
    exit 1
fi

# Set database connection details based on flag
if [ "$USE_ALT_DB" = true ]; then
    DB_SERVER="${DB_SERVER_ALT:-allboard-prod.database.windows.net}"
    DB_NAME="${DB_NAME_ALT:-allaboard-prod}"
    DB_USER="${DB_USER_ALT:-readonly_user}"
    DB_PASSWORD="${DB_PASSWORD_ALT:-Read_Only_AI735!?@}"
    echo "📊 Connecting to alternative database: $DB_SERVER"
else
    DB_SERVER="${DB_SERVER:-allboard-prod.database.windows.net}"
    DB_NAME="${DB_NAME:-allaboard-testing}"
    DB_USER="${DB_USER:-readonly_ai}"
    DB_PASSWORD="${DB_PASSWORD:-Read_AI_Only_2024!@#\$}"
    echo "📊 Connecting to primary database: $DB_SERVER"
fi

if [ -n "$TABLE_NAME" ]; then
    echo "🔍 Connecting to Azure SQL Database..."
    echo "📊 Extracting schema for table: $TABLE_NAME"
else
    echo "🔍 Connecting to Azure SQL Database..."
    echo "📊 Extracting complete database schema..."
fi

# Create a temporary Node.js script in the backend directory
cat > backend/temp-db-schema.js << 'EOF'
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

async function getSchema() {
  try {
    console.log('🔗 Connecting to database...');
    await sql.connect(config);
    console.log('✅ Connected successfully!');
    
    let tablesToProcess = [];
    
    if (process.argv[2]) {
      // Single table mode
      console.log('\n📋 Getting schema for specific table:', process.argv[2]);
      tablesToProcess = [{ TABLE_NAME: process.argv[2] }];
    } else {
      // All tables mode
      console.log('\n📋 Getting all tables in oe schema...');
      const tablesResult = await sql.query(`
        SELECT TABLE_NAME 
        FROM INFORMATION_SCHEMA.TABLES 
        WHERE TABLE_SCHEMA = 'oe' 
        ORDER BY TABLE_NAME
      `);
      
      tablesToProcess = tablesResult.recordset;
      console.log('\n📊 Found', tablesToProcess.length, 'tables:');
      tablesToProcess.forEach(table => {
        console.log('  -', table.TABLE_NAME);
      });
    }
    
    // Get detailed schema for each table
    console.log('\n🔍 Getting detailed schema for each table...');
    for (const table of tablesToProcess) {
      const tableName = table.TABLE_NAME;
      console.log('\n📋 Table:', tableName);
      console.log('=' .repeat(50));
      
      const columnsResult = await sql.query(`
        SELECT 
          COLUMN_NAME,
          DATA_TYPE,
          IS_NULLABLE,
          COLUMN_DEFAULT,
          CHARACTER_MAXIMUM_LENGTH,
          NUMERIC_PRECISION,
          NUMERIC_SCALE
        FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = '${tableName}'
        ORDER BY ORDINAL_POSITION
      `);
      
      columnsResult.recordset.forEach(col => {
        let typeInfo = col.DATA_TYPE;
        if (col.CHARACTER_MAXIMUM_LENGTH) {
          typeInfo += `(${col.CHARACTER_MAXIMUM_LENGTH})`;
        } else if (col.NUMERIC_PRECISION) {
          typeInfo += `(${col.NUMERIC_PRECISION}`;
          if (col.NUMERIC_SCALE) {
            typeInfo += `,${col.NUMERIC_SCALE}`;
          }
          typeInfo += ')';
        }
        
        const nullable = col.IS_NULLABLE === 'YES' ? 'NULL' : 'NOT NULL';
        const defaultVal = col.COLUMN_DEFAULT ? ` DEFAULT ${col.COLUMN_DEFAULT}` : '';
        
        console.log(`  ${col.COLUMN_NAME.padEnd(30)} ${typeInfo.padEnd(20)} ${nullable}${defaultVal}`);
      });
      
      // Get foreign keys
      const fkResult = await sql.query(`
        SELECT 
          fk.CONSTRAINT_NAME,
          fk.COLUMN_NAME,
          pk.TABLE_NAME AS REFERENCED_TABLE,
          pk.COLUMN_NAME AS REFERENCED_COLUMN
        FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
        JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE fk ON rc.CONSTRAINT_NAME = fk.CONSTRAINT_NAME
        JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE pk ON rc.UNIQUE_CONSTRAINT_NAME = pk.CONSTRAINT_NAME
        WHERE fk.TABLE_SCHEMA = 'oe' AND fk.TABLE_NAME = '${tableName}'
      `);
      
      if (fkResult.recordset.length > 0) {
        console.log('\n🔗 Foreign Keys:');
        fkResult.recordset.forEach(fk => {
          console.log(`  ${fk.COLUMN_NAME} -> ${fk.REFERENCED_TABLE}.${fk.REFERENCED_COLUMN}`);
        });
      }
    }
    
    // Get stored procedures
    console.log('\n\n🔧 Getting stored procedures...');
    const spResult = await sql.query(`
      SELECT ROUTINE_NAME, ROUTINE_DEFINITION
      FROM INFORMATION_SCHEMA.ROUTINES 
      WHERE ROUTINE_SCHEMA = 'oe' AND ROUTINE_TYPE = 'PROCEDURE'
      ORDER BY ROUTINE_NAME
    `);
    
    if (spResult.recordset.length > 0) {
      console.log('\n📋 Found', spResult.recordset.length, 'stored procedures:');
      spResult.recordset.forEach(sp => {
        console.log('  -', sp.ROUTINE_NAME);
      });
    } else {
      console.log('\n📋 No stored procedures found in oe schema');
    }
    
    console.log('\n✅ Schema extraction complete!');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await sql.close();
    console.log('🔌 Database connection closed');
  }
}

getSchema();
EOF

# Run the Node.js script from backend directory with the table name as argument
cd backend && DB_SERVER="$DB_SERVER" DB_NAME="$DB_NAME" DB_USER="$DB_USER" DB_PASSWORD="$DB_PASSWORD" node temp-db-schema.js "$TABLE_NAME"

# Clean up
rm -f backend/temp-db-schema.js