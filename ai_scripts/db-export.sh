#!/bin/bash

# OpenEnroll Database Export Script
# Exports all data from the database to SQL INSERT statements and/or JSON
# Usage: ./db-export.sh [--format sql|json|both] [--alt] [--output-dir ./exports]
# Usage: ./db-export.sh --format sql --alt (export from alternative database as SQL)

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

# Default values
FORMAT="both"
USE_ALT_DB=false
OUTPUT_DIR="./exports"

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --format)
            FORMAT="$2"
            shift 2
            ;;
        --alt)
            USE_ALT_DB=true
            shift
            ;;
        --output-dir)
            OUTPUT_DIR="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            echo "Usage: ./db-export.sh [--format sql|json|both] [--alt] [--output-dir ./exports]"
            exit 1
            ;;
    esac
done

# Set database connection details based on flag
if [ "$USE_ALT_DB" = true ]; then
    DB_SERVER="${DB_SERVER_ALT:-allboard-prod.database.windows.net}"
    DB_NAME="${DB_NAME_ALT:-allaboard-prod}"
    DB_USER="${DB_USER_ALT:-readonly_user}"
    DB_PASSWORD="${DB_PASSWORD_ALT:-Read_Only_AI735!?@}"
    echo "🔄 Using alternative database configuration"
    echo "📊 Connecting to alternative database: $DB_SERVER / $DB_NAME"
else
    DB_SERVER="${DB_SERVER:-allboard-prod.database.windows.net}"
    DB_NAME="${DB_NAME:-allaboard-testing}"
    DB_USER="${DB_USER:-oe-sqladmin}"
    DB_PASSWORD="${DB_PASSWORD:-PT\$r8u7G21@\$}"
    echo "📊 Connecting to primary database: $DB_SERVER / $DB_NAME"
fi

# Get absolute path for output directory
OUTPUT_DIR_ABS=$(cd "$(dirname "$OUTPUT_DIR")" && pwd)/$(basename "$OUTPUT_DIR")
# Create output directory if it doesn't exist
mkdir -p "$OUTPUT_DIR_ABS"

# Generate timestamp for filename
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
DB_NAME_CLEAN=$(echo "$DB_NAME" | tr '[:upper:]' '[:lower:]' | tr -d ' ')

echo "🚀 Starting database export..."
echo "📁 Output directory: $OUTPUT_DIR_ABS"
echo "📋 Format: $FORMAT"

# Run the export using node from backend directory
cd backend && node -e "
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
    trustServerCertificate: false
  }
};

// Escape SQL string values
function escapeSqlString(value) {
  if (value === null || value === undefined) {
    return 'NULL';
  }
  if (typeof value === 'boolean') {
    return value ? '1' : '0';
  }
  if (typeof value === 'number') {
    return value.toString();
  }
  if (value instanceof Date) {
    return \"'\" + value.toISOString().slice(0, 19).replace('T', ' ') + \"'\";
  }
  if (typeof value === 'string') {
    return \"'\" + value.replace(/'/g, \"''\").replace(/\\\\/g, '\\\\\\\\') + \"'\";
  }
  return \"'\" + String(value).replace(/'/g, \"''\").replace(/\\\\/g, '\\\\\\\\') + \"'\";
}

// Format value for SQL
function formatSqlValue(value, columnType) {
  if (value === null || value === undefined) {
    return 'NULL';
  }
  
  const type = (columnType || '').toLowerCase();
  
  if (type.includes('uniqueidentifier') || type.includes('guid')) {
    return \"'\" + value + \"'\";
  }
  if (type.includes('bit')) {
    return value ? '1' : '0';
  }
  if (type.includes('int') || type.includes('decimal') || type.includes('float') || type.includes('money')) {
    return value.toString();
  }
  if (type.includes('date') || type.includes('time')) {
    if (value instanceof Date) {
      return \"'\" + value.toISOString().slice(0, 19).replace('T', ' ') + \"'\";
    }
    return \"'\" + String(value) + \"'\";
  }
  
  // Default to string
  return escapeSqlString(value);
}

// Get all tables in oe schema
async function getTables(pool) {
  const result = await pool.request().query(\`
    SELECT 
      t.TABLE_SCHEMA,
      t.TABLE_NAME
    FROM INFORMATION_SCHEMA.TABLES t
    WHERE t.TABLE_SCHEMA = 'oe'
      AND t.TABLE_TYPE = 'BASE TABLE'
    ORDER BY t.TABLE_NAME
  \`);
  return result.recordset;
}

// Get column information for a table
async function getColumns(pool, schema, tableName) {
  const result = await pool.request().query(\`
    SELECT 
      COLUMN_NAME,
      DATA_TYPE,
      IS_NULLABLE,
      COLUMN_DEFAULT,
      CHARACTER_MAXIMUM_LENGTH
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = '\${schema}'
      AND TABLE_NAME = '\${tableName}'
    ORDER BY ORDINAL_POSITION
  \`);
  return result.recordset;
}

// Export table data as SQL INSERT statements
async function exportTableAsSQL(pool, schema, tableName, columns, outputStream) {
  try {
    const columnNames = columns.map(c => c.COLUMN_NAME).join(', ');
    const query = \`SELECT \${columnNames} FROM [\${schema}].[\${tableName}]\`;
    
    const result = await pool.request().query(query);
    const rows = result.recordset;
    
    if (rows.length === 0) {
      outputStream.write(\`-- Table: [\${schema}].[\${tableName}] - No data\\n\`);
      return 0;
    }
    
    outputStream.write(\`\\n-- ============================================\\n\`);
    outputStream.write(\`-- Table: [\${schema}].[\${tableName}]\\n\`);
    outputStream.write(\`-- Records: \${rows.length}\\n\`);
    outputStream.write(\`-- ============================================\\n\`);
    
    let insertCount = 0;
    const batchSize = 100;
    
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      
      for (const row of batch) {
        const values = columns.map(col => {
          const value = row[col.COLUMN_NAME];
          return formatSqlValue(value, col.DATA_TYPE);
        }).join(', ');
        
        outputStream.write(\`INSERT INTO [\${schema}].[\${tableName}] (\${columnNames}) VALUES (\${values});\\n\`);
        insertCount++;
      }
      
      // Progress indicator
      if ((i + batchSize) % 1000 === 0 || (i + batchSize) >= rows.length) {
        process.stdout.write(\`  ✓ Exported \${Math.min(i + batchSize, rows.length)} / \${rows.length} rows from [\${schema}].[\${tableName}]\\r\`);
      }
    }
    
    process.stdout.write(\`  ✓ Exported \${rows.length} rows from [\${schema}].[\${tableName}]\\n\`);
    return rows.length;
  } catch (err) {
    outputStream.write(\`-- ERROR exporting [\${schema}].[\${tableName}]: \${err.message}\\n\`);
    console.error(\`  ❌ Error exporting [\${schema}].[\${tableName}]:\`, err.message);
    return 0;
  }
}

// Export table data as JSON (returns data, doesn't write directly)
async function getTableDataAsJSON(pool, schema, tableName) {
  try {
    const query = \`SELECT * FROM [\${schema}].[\${tableName}]\`;
    const result = await pool.request().query(query);
    return result.recordset;
  } catch (err) {
    console.error(\`  ❌ Error exporting [\${schema}].[\${tableName}]:\`, err.message);
    return [];
  }
}

async function exportDatabase() {
  let pool;
  try {
    console.log('🔍 Connecting to database...');
    pool = await sql.connect(config);
    console.log('✅ Connected successfully');
    
    // Get all tables
    console.log('📋 Discovering tables...');
    const tables = await getTables(pool);
    console.log(\`✅ Found \${tables.length} tables in oe schema\`);
    
    const outputDir = '$OUTPUT_DIR_ABS';
    const timestamp = '$TIMESTAMP';
    const dbNameClean = '$DB_NAME_CLEAN';
    const format = '$FORMAT';
    
    let totalRows = 0;
    const exportStats = {};
    
    if (format === 'sql' || format === 'both') {
      const sqlFile = path.join(outputDir, \`\${dbNameClean}_export_\${timestamp}.sql\`);
      const sqlStream = fs.createWriteStream(sqlFile, { encoding: 'utf8' });
      
      sqlStream.write(\`-- OpenEnroll Database Export\\n\`);
      sqlStream.write(\`-- Database: \${config.database}\\n\`);
      sqlStream.write(\`-- Server: \${config.server}\\n\`);
      sqlStream.write(\`-- Export Date: \${new Date().toISOString()}\\n\`);
      sqlStream.write(\`-- Total Tables: \${tables.length}\\n\`);
      sqlStream.write(\`\\n-- ============================================\\n\`);
      sqlStream.write(\`-- IMPORTANT: Review and execute this script on target database\\n\`);
      sqlStream.write(\`-- ============================================\\n\`);
      sqlStream.write(\`\\n-- Disable foreign key checks temporarily (if needed)\\n\`);
      sqlStream.write(\`-- EXEC sp_MSforeachtable 'ALTER TABLE ? NOCHECK CONSTRAINT ALL'\\n\`);
      sqlStream.write(\`\\n\`);
      
      console.log(\`\\n📝 Exporting to SQL file: \${sqlFile}\`);
      
      for (const table of tables) {
        const columns = await getColumns(pool, table.TABLE_SCHEMA, table.TABLE_NAME);
        const rowCount = await exportTableAsSQL(pool, table.TABLE_SCHEMA, table.TABLE_NAME, columns, sqlStream);
        totalRows += rowCount;
        exportStats[table.TABLE_NAME] = rowCount;
      }
      
      sqlStream.write(\`\\n-- ============================================\\n\`);
      sqlStream.write(\`-- Re-enable foreign key checks\\n\`);
      sqlStream.write(\`-- EXEC sp_MSforeachtable 'ALTER TABLE ? CHECK CONSTRAINT ALL'\\n\`);
      sqlStream.write(\`\\n-- Export completed: \${totalRows} total rows exported\\n\`);
      
      sqlStream.end();
      console.log(\`\\n✅ SQL export completed: \${sqlFile}\`);
      console.log(\`📊 Total rows exported: \${totalRows}\`);
    }
    
    if (format === 'json' || format === 'both') {
      const jsonFile = path.join(outputDir, \`\${dbNameClean}_export_\${timestamp}.json\`);
      const jsonStream = fs.createWriteStream(jsonFile, { encoding: 'utf8' });
      
      jsonStream.write('{\\n');
      jsonStream.write('  \"database\": \"' + config.database + '\",\\n');
      jsonStream.write('  \"server\": \"' + config.server + '\",\\n');
      jsonStream.write('  \"exportDate\": \"' + new Date().toISOString() + '\",\\n');
      jsonStream.write('  \"totalTables\": ' + tables.length + ',\\n');
      jsonStream.write('  \"data\": {\\n');
      
      console.log(\`\\n📝 Exporting to JSON file: \${jsonFile}\`);
      
      for (let i = 0; i < tables.length; i++) {
        const table = tables[i];
        const isLast = i === tables.length - 1;
        
        const rows = await getTableDataAsJSON(pool, table.TABLE_SCHEMA, table.TABLE_NAME);
        
        jsonStream.write(\`  \\\"\${table.TABLE_SCHEMA}.\${table.TABLE_NAME}\\\": \${JSON.stringify(rows, null, 2)}\${isLast ? '' : ','}\\n\`);
        totalRows += rows.length;
        
        process.stdout.write(\`  ✓ Exported [\${table.TABLE_SCHEMA}].[\${table.TABLE_NAME}] (\${rows.length} rows)\\r\`);
      }
      
      jsonStream.write('  }\\n');
      jsonStream.write('}\\n');
      
      jsonStream.end();
      console.log(\`\\n✅ JSON export completed: \${jsonFile}\`);
    }
    
    console.log(\`\\n🎉 Export completed successfully!\`);
    console.log(\`📊 Total rows exported: \${totalRows}\`);
    console.log(\`📁 Files saved to: \${outputDir}\`);
    
    await pool.close();
    console.log('✅ Connection closed');
  } catch (err) {
    console.error('❌ Error:', err.message);
    if (pool) await pool.close();
    process.exit(1);
  }
}

exportDatabase();
"

