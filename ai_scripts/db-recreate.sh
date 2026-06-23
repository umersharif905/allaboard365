#!/bin/bash

# OpenEnroll Database Recreation Script
# This script recreates database objects (tables, views, stored procedures) with IF EXISTS logic
# and optionally migrates data from a source database
# 
# Usage: 
#   ./db-recreate.sh [--source-alt] [--target-alt] [--schema-only] [--data-only] [--tables table1,table2]
#   --source-alt: Use alternative database as source (default: primary)
#   --target-alt: Use alternative database as target (default: primary)
#   --schema-only: Only recreate schema, don't migrate data
#   --data-only: Only migrate data, don't recreate schema
#   --tables: Comma-separated list of tables to process (default: all tables)

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

# Parse arguments
USE_SOURCE_ALT=false
USE_TARGET_ALT=false
SCHEMA_ONLY=false
DATA_ONLY=false
TABLES_FILTER=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --source-alt)
            USE_SOURCE_ALT=true
            shift
            ;;
        --target-alt)
            USE_TARGET_ALT=true
            shift
            ;;
        --schema-only)
            SCHEMA_ONLY=true
            shift
            ;;
        --data-only)
            DATA_ONLY=true
            shift
            ;;
        --tables)
            TABLES_FILTER="$2"
            shift 2
            ;;
        *)
            echo "❌ Unknown option: $1"
            echo "Usage: ./db-recreate.sh [--source-alt] [--target-alt] [--schema-only] [--data-only] [--tables table1,table2]"
            exit 1
            ;;
    esac
done

# Set source database connection details
if [ "$USE_SOURCE_ALT" = true ]; then
    SOURCE_SERVER="${DB_SERVER_ALT:-allboard-prod.database.windows.net}"
    SOURCE_DB="${DB_NAME_ALT:-allaboard-prod}"
    SOURCE_USER="${DB_USER_ALT:-readonly_user}"
    SOURCE_PASSWORD="${DB_PASSWORD_ALT:-Read_Only_AI735!?@}"
    echo "📊 Source database: $SOURCE_SERVER / $SOURCE_DB (alternative)"
else
    SOURCE_SERVER="${DB_SERVER:-allboard-prod.database.windows.net}"
    SOURCE_DB="${DB_NAME:-allaboard-testing}"
    SOURCE_USER="${DB_USER:-oe-sqladmin}"
    SOURCE_PASSWORD="${DB_PASSWORD:-PT\$r8u7G21@\$}"
    echo "📊 Source database: $SOURCE_SERVER / $SOURCE_DB (primary)"
fi

# Set target database connection details
if [ "$USE_TARGET_ALT" = true ]; then
    TARGET_SERVER="${DB_SERVER_ALT:-allboard-prod.database.windows.net}"
    TARGET_DB="${DB_NAME_ALT:-allaboard-prod}"
    TARGET_USER="${DB_USER_ALT:-readonly_user}"
    TARGET_PASSWORD="${DB_PASSWORD_ALT:-Read_Only_AI735!?@}"
    echo "📊 Target database: $TARGET_SERVER / $TARGET_DB (alternative)"
else
    TARGET_SERVER="${DB_SERVER:-allboard-prod.database.windows.net}"
    TARGET_DB="${DB_NAME:-allaboard-testing}"
    TARGET_USER="${DB_USER:-oe-sqladmin}"
    TARGET_PASSWORD="${DB_PASSWORD:-PT\$r8u7G21@\$}"
    echo "📊 Target database: $TARGET_SERVER / $TARGET_DB (primary)"
fi

# Warn if source and target are the same
if [ "$SOURCE_SERVER" = "$TARGET_SERVER" ] && [ "$SOURCE_DB" = "$TARGET_DB" ]; then
    echo "⚠️  WARNING: Source and target databases are the same!"
    read -p "Continue anyway? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Create the Node.js script
cat > backend/temp-db-recreate.js << 'EOFSCRIPT'
const sql = require('mssql');

// Source database config
const sourceConfig = {
  server: process.env.SOURCE_SERVER,
  database: process.env.SOURCE_DB,
  user: process.env.SOURCE_USER,
  password: process.env.SOURCE_PASSWORD,
  options: {
    encrypt: true,
    trustServerCertificate: false
  }
};

// Target database config
const targetConfig = {
  server: process.env.TARGET_SERVER,
  database: process.env.TARGET_DB,
  user: process.env.TARGET_USER,
  password: process.env.TARGET_PASSWORD,
  options: {
    encrypt: true,
    trustServerCertificate: false
  }
};

const SCHEMA_ONLY = process.env.SCHEMA_ONLY === 'true';
const DATA_ONLY = process.env.DATA_ONLY === 'true';
const TABLES_FILTER = process.env.TABLES_FILTER ? process.env.TABLES_FILTER.split(',') : null;

async function getTableSchema(sourcePool, tableName) {
  // Get columns
  const columnsResult = await sourcePool.request()
    .input('tableName', sql.NVarChar, tableName)
    .query(`
      SELECT 
        COLUMN_NAME,
        DATA_TYPE,
        IS_NULLABLE,
        COLUMN_DEFAULT,
        CHARACTER_MAXIMUM_LENGTH,
        NUMERIC_PRECISION,
        NUMERIC_SCALE,
        ORDINAL_POSITION
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = @tableName
      ORDER BY ORDINAL_POSITION
    `);
  
  // Get primary key
  const pkResult = await sourcePool.request()
    .input('tableName', sql.NVarChar, tableName)
    .query(`
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = 'oe' 
        AND TABLE_NAME = @tableName
        AND OBJECTPROPERTY(OBJECT_ID(CONSTRAINT_SCHEMA + '.' + CONSTRAINT_NAME), 'IsPrimaryKey') = 1
      ORDER BY ORDINAL_POSITION
    `);
  
  // Get foreign keys
  const fkResult = await sourcePool.request()
    .input('tableName', sql.NVarChar, tableName)
    .query(`
      SELECT 
        fk.CONSTRAINT_NAME,
        fk.COLUMN_NAME,
        pk.TABLE_SCHEMA AS REFERENCED_SCHEMA,
        pk.TABLE_NAME AS REFERENCED_TABLE,
        pk.COLUMN_NAME AS REFERENCED_COLUMN
      FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
      JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE fk 
        ON rc.CONSTRAINT_NAME = fk.CONSTRAINT_NAME
        AND rc.CONSTRAINT_SCHEMA = fk.CONSTRAINT_SCHEMA
      JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE pk 
        ON rc.UNIQUE_CONSTRAINT_NAME = pk.CONSTRAINT_NAME
        AND rc.UNIQUE_CONSTRAINT_SCHEMA = pk.CONSTRAINT_SCHEMA
      WHERE fk.TABLE_SCHEMA = 'oe' AND fk.TABLE_NAME = @tableName
    `);
  
  // Get indexes
  const indexResult = await sourcePool.request()
    .input('tableName', sql.NVarChar, tableName)
    .query(`
      SELECT 
        i.name AS INDEX_NAME,
        i.is_unique,
        i.is_primary_key,
        STRING_AGG(c.name, ', ') WITHIN GROUP (ORDER BY ic.key_ordinal) AS COLUMNS
      FROM sys.indexes i
      JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
      JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
      WHERE i.object_id = OBJECT_ID('oe.' + @tableName)
        AND i.is_primary_key = 0
      GROUP BY i.name, i.is_unique, i.is_primary_key
    `);
  
  return {
    columns: columnsResult.recordset,
    primaryKeys: pkResult.recordset.map(r => r.COLUMN_NAME),
    foreignKeys: fkResult.recordset,
    indexes: indexResult.recordset
  };
}

function generateColumnDefinition(col) {
  let def = `[${col.COLUMN_NAME}] `;
  
  // Data type
  if (col.DATA_TYPE === 'nvarchar' || col.DATA_TYPE === 'varchar' || col.DATA_TYPE === 'nchar' || col.DATA_TYPE === 'char') {
    if (col.CHARACTER_MAXIMUM_LENGTH === -1) {
      def += `${col.DATA_TYPE}(MAX)`;
    } else {
      def += `${col.DATA_TYPE}(${col.CHARACTER_MAXIMUM_LENGTH})`;
    }
  } else if (col.DATA_TYPE === 'decimal' || col.DATA_TYPE === 'numeric') {
    def += `${col.DATA_TYPE}(${col.NUMERIC_PRECISION},${col.NUMERIC_SCALE})`;
  } else if (col.DATA_TYPE === 'float') {
    def += col.NUMERIC_PRECISION ? `${col.DATA_TYPE}(${col.NUMERIC_PRECISION})` : col.DATA_TYPE;
  } else {
    def += col.DATA_TYPE;
  }
  
  // Nullable
  if (col.IS_NULLABLE === 'NO') {
    def += ' NOT NULL';
  }
  
  // Default
  if (col.COLUMN_DEFAULT) {
    def += ` ${col.COLUMN_DEFAULT}`;
  }
  
  return def;
}

function generateCreateTableSQL(tableName, schema) {
  let sql = `-- Create table: ${tableName}\n`;
  sql += `IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = '${tableName}' AND schema_id = SCHEMA_ID('oe'))\n`;
  sql += `BEGIN\n`;
  sql += `    CREATE TABLE [oe].[${tableName}] (\n`;
  
  const columnDefs = schema.columns.map(col => '        ' + generateColumnDefinition(col));
  sql += columnDefs.join(',\n');
  
  // Primary key
  if (schema.primaryKeys.length > 0) {
    sql += `,\n        CONSTRAINT [PK_${tableName}] PRIMARY KEY ([${schema.primaryKeys.join('], [')}])`;
  }
  
  sql += `\n    );\n`;
  
  // Foreign keys
  for (const fk of schema.foreignKeys) {
    sql += `    ALTER TABLE [oe].[${tableName}] ADD CONSTRAINT [${fk.CONSTRAINT_NAME}] `;
    sql += `FOREIGN KEY ([${fk.COLUMN_NAME}]) `;
    sql += `REFERENCES [${fk.REFERENCED_SCHEMA}].[${fk.REFERENCED_TABLE}]([${fk.REFERENCED_COLUMN}]);\n`;
  }
  
  // Indexes
  for (const idx of schema.indexes) {
    const unique = idx.is_unique ? 'UNIQUE ' : '';
    sql += `    CREATE ${unique}NONCLUSTERED INDEX [${idx.INDEX_NAME}] ON [oe].[${tableName}] ([${idx.COLUMNS}]);\n`;
  }
  
  sql += `    PRINT '✅ Created table: ${tableName}';\n`;
  sql += `END\n`;
  sql += `ELSE\n`;
  sql += `BEGIN\n`;
  sql += `    PRINT '⚠️  Table ${tableName} already exists, checking for missing columns...';\n`;
  
  // Add missing columns
  sql += `    -- Add missing columns\n`;
  for (const col of schema.columns) {
    sql += `    IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = '${tableName}' AND COLUMN_NAME = '${col.COLUMN_NAME}')\n`;
    sql += `    BEGIN\n`;
    sql += `        ALTER TABLE [oe].[${tableName}] ADD ${generateColumnDefinition(col)};\n`;
    sql += `        PRINT '✅ Added column: ${col.COLUMN_NAME}';\n`;
    sql += `    END\n`;
  }
  
  sql += `END\n`;
  sql += `GO\n\n`;
  
  return sql;
}

async function migrateData(sourcePool, targetPool, tableName) {
  try {
    console.log(`\n📦 Migrating data for table: ${tableName}`);
    
    // Get row count from source
    const countResult = await sourcePool.request().query(`SELECT COUNT(*) as cnt FROM [oe].[${tableName}]`);
    const sourceCount = countResult.recordset[0].cnt;
    
    if (sourceCount === 0) {
      console.log(`   ⚠️  Source table is empty, skipping data migration`);
      return;
    }
    
    console.log(`   📊 Source has ${sourceCount} rows`);
    
    // Get row count from target
    const targetCountResult = await targetPool.request().query(`SELECT COUNT(*) as cnt FROM [oe].[${tableName}]`);
    const targetCount = targetCountResult.recordset[0].cnt;
    console.log(`   📊 Target has ${targetCount} rows`);
    
    // Get primary keys
    const pkResult = await sourcePool.request()
      .input('tableName', sql.NVarChar, tableName)
      .query(`
        SELECT COLUMN_NAME
        FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = 'oe' 
          AND TABLE_NAME = @tableName
          AND OBJECTPROPERTY(OBJECT_ID(CONSTRAINT_SCHEMA + '.' + CONSTRAINT_NAME), 'IsPrimaryKey') = 1
        ORDER BY ORDINAL_POSITION
      `);
    
    const primaryKeys = pkResult.recordset.map(r => r.COLUMN_NAME);
    
    if (primaryKeys.length === 0) {
      console.log(`   ⚠️  Table has no primary key, using INSERT only (no updates)`);
    }
    
    // Get all columns
    const colsResult = await sourcePool.request()
      .input('tableName', sql.NVarChar, tableName)
      .query(`
        SELECT COLUMN_NAME
        FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = @tableName
        ORDER BY ORDINAL_POSITION
      `);
    
    const columns = colsResult.recordset.map(r => r.COLUMN_NAME);
    const columnList = columns.map(c => `[${c}]`).join(', ');
    
    // Fetch all data (for small tables) or in batches (for large tables)
    const batchSize = sourceCount > 10000 ? 1000 : sourceCount;
    let totalInserted = 0;
    let totalUpdated = 0;
    let processed = 0;
    
    // Use a simple approach: fetch all and process
    const dataResult = await sourcePool.request().query(`SELECT ${columnList} FROM [oe].[${tableName}]`);
    
    console.log(`   📊 Processing ${dataResult.recordset.length} rows...`);
    
    // Process each row
    for (const row of dataResult.recordset) {
      try {
        if (primaryKeys.length > 0) {
          // Build WHERE clause for primary key
          const whereParts = primaryKeys.map(pk => {
            const value = row[pk];
            if (value === null || value === undefined) {
              return `[${pk}] IS NULL`;
            } else if (typeof value === 'string') {
              return `[${pk}] = N'${value.replace(/'/g, "''")}'`;
            } else {
              return `[${pk}] = ${value}`;
            }
          });
          const whereClause = whereParts.join(' AND ');
          
          // Check if row exists
          const existsResult = await targetPool.request().query(`SELECT COUNT(*) as cnt FROM [oe].[${tableName}] WHERE ${whereClause}`);
          const exists = existsResult.recordset[0].cnt > 0;
          
          if (exists) {
            // Update existing row
            const setParts = columns
              .filter(c => !primaryKeys.includes(c))
              .map(c => {
                const value = row[c];
                if (value === null || value === undefined) {
                  return `[${c}] = NULL`;
                } else if (typeof value === 'string') {
                  return `[${c}] = N'${value.replace(/'/g, "''")}'`;
                } else {
                  return `[${c}] = ${value}`;
                }
              });
            
            if (setParts.length > 0) {
              await targetPool.request().query(`UPDATE [oe].[${tableName}] SET ${setParts.join(', ')} WHERE ${whereClause}`);
              totalUpdated++;
            }
          } else {
            // Insert new row
            const valueParts = columns.map(c => {
              const value = row[c];
              if (value === null || value === undefined) {
                return 'NULL';
              } else if (typeof value === 'string') {
                return `N'${value.replace(/'/g, "''")}'`;
              } else {
                return value;
              }
            });
            await targetPool.request().query(`INSERT INTO [oe].[${tableName}] (${columnList}) VALUES (${valueParts.join(', ')})`);
            totalInserted++;
          }
        } else {
          // No primary key - just insert (may cause duplicates)
          const valueParts = columns.map(c => {
            const value = row[c];
            if (value === null || value === undefined) {
              return 'NULL';
            } else if (typeof value === 'string') {
              return `N'${value.replace(/'/g, "''")}'`;
            } else {
              return value;
            }
          });
          await targetPool.request().query(`INSERT INTO [oe].[${tableName}] (${columnList}) VALUES (${valueParts.join(', ')})`);
          totalInserted++;
        }
        
        processed++;
        if (processed % 100 === 0) {
          console.log(`   📊 Processed ${processed} / ${dataResult.recordset.length} rows (Inserted: ${totalInserted}, Updated: ${totalUpdated})`);
        }
      } catch (rowError) {
        console.error(`   ⚠️  Error processing row ${processed + 1}:`, rowError.message);
        // Continue with next row
      }
    }
    
    console.log(`   ✅ Data migration complete: ${totalInserted} inserted, ${totalUpdated} updated`);
    
  } catch (error) {
    console.error(`   ❌ Error migrating data for ${tableName}:`, error.message);
    throw error;
  }
}

async function recreateDatabase() {
  let sourcePool, targetPool;
  
  try {
    console.log('🔍 Connecting to source database...');
    sourcePool = await sql.connect(sourceConfig);
    console.log('✅ Connected to source database');
    
    console.log('🔍 Connecting to target database...');
    targetPool = await sql.connect(targetConfig);
    console.log('✅ Connected to target database');
    
    // Get list of tables
    let tablesQuery = `
      SELECT TABLE_NAME 
      FROM INFORMATION_SCHEMA.TABLES 
      WHERE TABLE_SCHEMA = 'oe' 
        AND TABLE_TYPE = 'BASE TABLE'
      ORDER BY TABLE_NAME
    `;
    
    const tablesResult = await sourcePool.request().query(tablesQuery);
    let tables = tablesResult.recordset.map(r => r.TABLE_NAME);
    
    // Filter tables if specified
    if (TABLES_FILTER && TABLES_FILTER.length > 0) {
      tables = tables.filter(t => TABLES_FILTER.includes(t));
      console.log(`\n📋 Filtered to ${tables.length} tables: ${tables.join(', ')}`);
    } else {
      console.log(`\n📋 Found ${tables.length} tables to process`);
    }
    
    if (tables.length === 0) {
      console.log('⚠️  No tables found to process');
      return;
    }
    
    // Process each table
    const schemaSQL = [];
    
    for (const tableName of tables) {
      console.log(`\n📋 Processing table: ${tableName}`);
      
      if (!DATA_ONLY) {
        // Get schema
        const schema = await getTableSchema(sourcePool, tableName);
        
        // Generate CREATE TABLE SQL
        const createSQL = generateCreateTableSQL(tableName, schema);
        schemaSQL.push(createSQL);
        
        // Execute on target - split by GO statements
        try {
          const statements = createSQL.split(/GO\s*\n/).filter(s => s.trim().length > 0);
          for (const statement of statements) {
            const trimmed = statement.trim();
            if (trimmed.length > 0 && !trimmed.startsWith('--')) {
              await targetPool.request().query(trimmed);
            }
          }
          console.log(`   ✅ Schema created/updated for ${tableName}`);
        } catch (error) {
          console.error(`   ❌ Error creating schema for ${tableName}:`, error.message);
          // Continue with next table
        }
      }
      
      if (!SCHEMA_ONLY) {
        // Migrate data
        try {
          await migrateData(sourcePool, targetPool, tableName);
        } catch (error) {
          console.error(`   ❌ Error migrating data for ${tableName}:`, error.message);
          // Continue with next table
        }
      }
    }
    
    // Save schema SQL to file
    if (schemaSQL.length > 0) {
      const fs = require('fs');
      const schemaFile = 'backend/temp-recreated-schema.sql';
      fs.writeFileSync(schemaFile, schemaSQL.join('\n'));
      console.log(`\n💾 Schema SQL saved to: ${schemaFile}`);
    }
    
    console.log('\n✅ Database recreation complete!');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error);
    process.exit(1);
  } finally {
    if (sourcePool) await sourcePool.close();
    if (targetPool) await targetPool.close();
    console.log('🔌 Database connections closed');
  }
}

recreateDatabase();
EOFSCRIPT

# Run the Node.js script
cd backend && \
SOURCE_SERVER="$SOURCE_SERVER" \
SOURCE_DB="$SOURCE_DB" \
SOURCE_USER="$SOURCE_USER" \
SOURCE_PASSWORD="$SOURCE_PASSWORD" \
TARGET_SERVER="$TARGET_SERVER" \
TARGET_DB="$TARGET_DB" \
TARGET_USER="$TARGET_USER" \
TARGET_PASSWORD="$TARGET_PASSWORD" \
SCHEMA_ONLY="$SCHEMA_ONLY" \
DATA_ONLY="$DATA_ONLY" \
TABLES_FILTER="$TABLES_FILTER" \
node temp-db-recreate.js

# Clean up
rm -f backend/temp-db-recreate.js

echo ""
echo "✅ Script execution complete!"
