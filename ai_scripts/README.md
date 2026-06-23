# AI Scripts

This folder contains database and development scripts specifically for AI-assisted development.

## Scripts

### Database Scripts
- **`db-query.sh`** - Execute SQL queries against the database
- **`db-schema.sh`** - Extract database schema information
- **`db-recreate.sh`** - Recreate database schema with IF EXISTS logic and migrate data (bash script)
- **`db-recreate.sql`** - SQL script for SSMS - Full version with cross-database support
- **`db-recreate-simple.sql`** - SQL script for SSMS - Simple version (recommended)

## Usage

### Database Query Script
```bash
# Query primary database
./ai_scripts/db-query.sh "SELECT * FROM oe.Users WHERE Status = 'Active'"

# Query alternative database
./ai_scripts/db-query.sh "SELECT * FROM oe.Users WHERE Status = 'Active'" --alt
```

### Database Schema Script
```bash
# Get complete schema
./ai_scripts/db-schema.sh

# Get specific table schema
./ai_scripts/db-schema.sh Users

# Get schema from alternative database
./ai_scripts/db-schema.sh Users --alt
```

### Database Recreation Script
```bash
# Recreate schema and migrate data from primary to primary
./ai_scripts/db-recreate.sh

# Recreate schema only (no data migration)
./ai_scripts/db-recreate.sh --schema-only

# Migrate data only (assumes schema already exists)
./ai_scripts/db-recreate.sh --data-only

# Recreate specific tables
./ai_scripts/db-recreate.sh --tables Users,Agents,Members

# Copy from alternative database to primary
./ai_scripts/db-recreate.sh --source-alt

# Copy from primary to alternative database
./ai_scripts/db-recreate.sh --target-alt

# Full control: copy from alt to alt, schema only, specific tables
./ai_scripts/db-recreate.sh --source-alt --target-alt --schema-only --tables Users,Agents
```

## Configuration

The scripts use the `.env` file in this directory for database credentials. The `.env` file supports:

- **Primary Database**: `pvt-sql-server.database.windows.net` (readonly_user)
- **Alternative Database**: `oe-sql-srvr.database.windows.net` (readonly_ai)

## Database Access

- **Read-only access** to all databases
- **Real-time schema discovery** for development
- **Multi-database support** with `--alt` flag
- **Secure credential management** via environment variables

## Examples

```bash
# Get all active users
./ai_scripts/db-query.sh "SELECT TOP 10 * FROM oe.Users WHERE Status = 'Active'"

# Get table structure
./ai_scripts/db-schema.sh Products

# Check database from alternative server
./ai_scripts/db-query.sh "SELECT COUNT(*) as TotalUsers FROM oe.Users" --alt

# Recreate database schema with data migration
./ai_scripts/db-recreate.sh

# Recreate only specific tables
./ai_scripts/db-recreate.sh --tables Users,Members,Products
```

## Database Recreation Script Details

The `db-recreate.sh` script provides comprehensive database recreation capabilities:

### Features
- **IF EXISTS Logic**: Automatically checks if tables exist and updates them instead of failing
- **Schema Recreation**: Extracts complete schema (tables, columns, indexes, foreign keys) from source
- **Data Migration**: Optionally migrates data with INSERT/UPDATE logic based on primary keys
- **Incremental Updates**: Adds missing columns to existing tables
- **Selective Processing**: Can process specific tables or all tables
- **Multi-Database Support**: Can copy between different databases

### Options
- `--source-alt`: Use alternative database as source (default: primary)
- `--target-alt`: Use alternative database as target (default: primary)
- `--schema-only`: Only recreate schema, don't migrate data
- `--data-only`: Only migrate data, don't recreate schema
- `--tables table1,table2`: Comma-separated list of tables to process (default: all tables)

### How It Works
1. Connects to source database and extracts schema information
2. Generates CREATE TABLE statements with IF NOT EXISTS logic
3. Executes schema creation on target database
4. Adds missing columns to existing tables
5. Optionally migrates data using INSERT for new rows and UPDATE for existing rows
6. Saves generated schema SQL to `backend/temp-recreated-schema.sql` for reference

## SQL Scripts for SSMS (Recommended)

### Simple Version (`db-recreate-simple.sql`)

**Best for:** Recreating schema in the same database

**Steps:**
1. Open `ai_scripts/db-recreate-simple.sql` in SQL Server Management Studio
2. Change the database name on line 20: `USE [your-database-name];`
3. Execute the script to create the stored procedure
4. Run the procedure:

```sql
-- Recreate all tables (schema only)
EXEC [oe].[RecreateDatabaseSchema];

-- Recreate specific tables only
EXEC [oe].[RecreateDatabaseSchema] @TableFilter = 'Users,Agents,Members';
```

**For Data Migration:**
Use SQL Server Import/Export Wizard or manual INSERT statements:
```sql
INSERT INTO [oe].[Users] 
SELECT * FROM [SourceDatabase].[oe].[Users];
```

### Full Version (`db-recreate.sql`)

**Best for:** Cross-database schema and data migration

**Steps:**
1. Open `ai_scripts/db-recreate.sql` in SSMS
2. Change the database name on line 20
3. Execute the script to create the stored procedure
4. Run with options:

```sql
-- Schema only (same database)
EXEC [oe].[RecreateDatabaseSchema] @MigrateData = 0;

-- Schema and data (from another database)
EXEC [oe].[RecreateDatabaseSchema] 
    @SourceDatabase = 'allaboard-testing',  -- Source database name (AllAboard)
    @MigrateData = 1,                 -- Include data migration
    @TableFilter = NULL;              -- NULL = all tables, or 'Users,Agents'
```

**Note:** Cross-database queries require proper permissions and linked server configuration if databases are on different servers.
