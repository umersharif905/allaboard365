-- ============================================================================
-- SIMPLE DATABASE RECREATION SCRIPT
-- ============================================================================
-- This script recreates database tables with IF EXISTS logic.
-- It reads the schema from the current database and recreates tables.
--
-- Usage:
--   1. Connect to your TARGET database in SSMS
--   2. Run this script to create the stored procedure
--   3. Execute: EXEC [oe].[RecreateDatabaseSchema] @MigrateData = 0;
--
-- For data migration from another database:
--   1. Use SQL Server Import/Export Wizard, or
--   2. Use: INSERT INTO [oe].[TableName] SELECT * FROM [SourceDB].[oe].[TableName]
-- ============================================================================

-- Change to your target database
USE [open-enroll-dev]; -- ⚠️ CHANGE THIS TO YOUR TARGET DATABASE NAME
GO

-- Create schema if it doesn't exist
IF NOT EXISTS (SELECT * FROM sys.schemas WHERE name = 'oe')
BEGIN
    EXEC('CREATE SCHEMA [oe]');
    PRINT '✅ Created schema [oe]';
END
GO

-- ============================================================================
-- STORED PROCEDURE: Recreate Database Schema
-- ============================================================================
IF EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[oe].[RecreateDatabaseSchema]') AND type in (N'P', N'PC'))
    DROP PROCEDURE [oe].[RecreateDatabaseSchema];
GO

CREATE PROCEDURE [oe].[RecreateDatabaseSchema]
    @MigrateData BIT = 0,                  -- 0 = schema only, 1 = migrate data (requires source DB)
    @TableFilter NVARCHAR(MAX) = NULL      -- NULL = all tables, or 'Users,Agents,Members'
AS
BEGIN
    SET NOCOUNT ON;
    
    DECLARE @TableName NVARCHAR(128);
    DECLARE @SQL NVARCHAR(MAX);
    DECLARE @ColumnSQL NVARCHAR(MAX);
    DECLARE @PKColumns NVARCHAR(MAX);
    DECLARE @ColumnName NVARCHAR(128);
    DECLARE @DataType NVARCHAR(128);
    DECLARE @IsNullable NVARCHAR(10);
    DECLARE @ColumnDefault NVARCHAR(MAX);
    DECLARE @CharMaxLength INT;
    DECLARE @NumericPrecision INT;
    DECLARE @NumericScale INT;
    
    -- Create temp table for table list
    IF OBJECT_ID('tempdb..#TableList') IS NOT NULL DROP TABLE #TableList;
    CREATE TABLE #TableList (TABLE_NAME NVARCHAR(128));
    
    -- Get table list
    IF @TableFilter IS NULL
    BEGIN
        INSERT INTO #TableList
        SELECT TABLE_NAME
        FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = 'oe' AND TABLE_TYPE = 'BASE TABLE'
        ORDER BY TABLE_NAME;
    END
    ELSE
    BEGIN
        -- Parse table filter (simple comma-separated)
        DECLARE @FilterTable NVARCHAR(128);
        DECLARE @FilterPos INT = 1;
        DECLARE @FilterLen INT = LEN(@TableFilter);
        
        WHILE @FilterPos <= @FilterLen
        BEGIN
            DECLARE @CommaPos INT = CHARINDEX(',', @TableFilter, @FilterPos);
            IF @CommaPos = 0 SET @CommaPos = @FilterLen + 1;
            
            SET @FilterTable = LTRIM(RTRIM(SUBSTRING(@TableFilter, @FilterPos, @CommaPos - @FilterPos)));
            IF LEN(@FilterTable) > 0
            BEGIN
                INSERT INTO #TableList VALUES (@FilterTable);
            END
            
            SET @FilterPos = @CommaPos + 1;
        END
    END
    
    -- Cursor to iterate through tables
    DECLARE table_cursor CURSOR FOR
    SELECT TABLE_NAME FROM #TableList ORDER BY TABLE_NAME;
    
    OPEN table_cursor;
    FETCH NEXT FROM table_cursor INTO @TableName;
    
    WHILE @@FETCH_STATUS = 0
    BEGIN
        PRINT '';
        PRINT '============================================================================';
        PRINT 'Processing table: ' + @TableName;
        PRINT '============================================================================';
        
        -- Check if table exists
        IF EXISTS (SELECT 1 FROM sys.tables WHERE name = @TableName AND schema_id = SCHEMA_ID('oe'))
        BEGIN
            PRINT '⚠️  Table already exists, checking for missing columns...';
            
            -- Add missing columns
            DECLARE column_cursor CURSOR FOR
            SELECT 
                COLUMN_NAME,
                DATA_TYPE,
                IS_NULLABLE,
                COLUMN_DEFAULT,
                CHARACTER_MAXIMUM_LENGTH,
                NUMERIC_PRECISION,
                NUMERIC_SCALE
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = @TableName
            ORDER BY ORDINAL_POSITION;
            
            OPEN column_cursor;
            FETCH NEXT FROM column_cursor INTO @ColumnName, @DataType, @IsNullable, @ColumnDefault, @CharMaxLength, @NumericPrecision, @NumericScale;
            
            WHILE @@FETCH_STATUS = 0
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 
                    FROM INFORMATION_SCHEMA.COLUMNS 
                    WHERE TABLE_SCHEMA = 'oe' 
                      AND TABLE_NAME = @TableName 
                      AND COLUMN_NAME = @ColumnName
                )
                BEGIN
                    -- Build column definition
                    SET @ColumnSQL = QUOTENAME(@ColumnName) + ' ' + @DataType;
                    
                    -- Add length/precision
                    IF @CharMaxLength IS NOT NULL
                    BEGIN
                        IF @CharMaxLength = -1
                            SET @ColumnSQL = @ColumnSQL + '(MAX)';
                        ELSE
                            SET @ColumnSQL = @ColumnSQL + '(' + CAST(@CharMaxLength AS NVARCHAR(10)) + ')';
                    END
                    ELSE IF @NumericPrecision IS NOT NULL
                    BEGIN
                        SET @ColumnSQL = @ColumnSQL + '(' + CAST(@NumericPrecision AS NVARCHAR(10));
                        IF @NumericScale IS NOT NULL
                            SET @ColumnSQL = @ColumnSQL + ',' + CAST(@NumericScale AS NVARCHAR(10));
                        SET @ColumnSQL = @ColumnSQL + ')';
                    END
                    
                    -- Add nullable
                    IF @IsNullable = 'NO'
                        SET @ColumnSQL = @ColumnSQL + ' NOT NULL';
                    
                    -- Add default
                    IF @ColumnDefault IS NOT NULL
                        SET @ColumnSQL = @ColumnSQL + ' ' + @ColumnDefault;
                    
                    -- Add column
                    SET @SQL = 'ALTER TABLE [oe].' + QUOTENAME(@TableName) + ' ADD ' + @ColumnSQL;
                    
                    BEGIN TRY
                        EXEC sp_executesql @SQL;
                        PRINT '✅ Added column: ' + @ColumnName;
                    END TRY
                    BEGIN CATCH
                        PRINT '❌ Error adding column ' + @ColumnName + ': ' + ERROR_MESSAGE();
                    END CATCH
                END
                
                FETCH NEXT FROM column_cursor INTO @ColumnName, @DataType, @IsNullable, @ColumnDefault, @CharMaxLength, @NumericPrecision, @NumericScale;
            END
            
            CLOSE column_cursor;
            DEALLOCATE column_cursor;
        END
        ELSE
        BEGIN
            PRINT '📝 Creating table: ' + @TableName;
            
            -- Build CREATE TABLE statement
            SET @SQL = 'CREATE TABLE [oe].' + QUOTENAME(@TableName) + ' (';
            SET @ColumnSQL = '';
            
            -- Get columns
            DECLARE column_cursor2 CURSOR FOR
            SELECT 
                COLUMN_NAME,
                DATA_TYPE,
                IS_NULLABLE,
                COLUMN_DEFAULT,
                CHARACTER_MAXIMUM_LENGTH,
                NUMERIC_PRECISION,
                NUMERIC_SCALE
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = @TableName
            ORDER BY ORDINAL_POSITION;
            
            OPEN column_cursor2;
            FETCH NEXT FROM column_cursor2 INTO @ColumnName, @DataType, @IsNullable, @ColumnDefault, @CharMaxLength, @NumericPrecision, @NumericScale;
            
            WHILE @@FETCH_STATUS = 0
            BEGIN
                IF @ColumnSQL != ''
                    SET @ColumnSQL = @ColumnSQL + ', ';
                
                SET @ColumnSQL = @ColumnSQL + QUOTENAME(@ColumnName) + ' ' + @DataType;
                
                -- Add length/precision
                IF @CharMaxLength IS NOT NULL
                BEGIN
                    IF @CharMaxLength = -1
                        SET @ColumnSQL = @ColumnSQL + '(MAX)';
                    ELSE
                        SET @ColumnSQL = @ColumnSQL + '(' + CAST(@CharMaxLength AS NVARCHAR(10)) + ')';
                END
                ELSE IF @NumericPrecision IS NOT NULL
                BEGIN
                    SET @ColumnSQL = @ColumnSQL + '(' + CAST(@NumericPrecision AS NVARCHAR(10));
                    IF @NumericScale IS NOT NULL
                        SET @ColumnSQL = @ColumnSQL + ',' + CAST(@NumericScale AS NVARCHAR(10));
                    SET @ColumnSQL = @ColumnSQL + ')';
                END
                
                -- Add nullable
                IF @IsNullable = 'NO'
                    SET @ColumnSQL = @ColumnSQL + ' NOT NULL';
                
                -- Add default
                IF @ColumnDefault IS NOT NULL
                    SET @ColumnSQL = @ColumnSQL + ' ' + @ColumnDefault;
                
                FETCH NEXT FROM column_cursor2 INTO @ColumnName, @DataType, @IsNullable, @ColumnDefault, @CharMaxLength, @NumericPrecision, @NumericScale;
            END
            
            CLOSE column_cursor2;
            DEALLOCATE column_cursor2;
            
            SET @SQL = @SQL + @ColumnSQL;
            
            -- Add primary key if exists
            SET @PKColumns = '';
            SELECT @PKColumns = @PKColumns + QUOTENAME(COLUMN_NAME) + ', '
            FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
            WHERE TABLE_SCHEMA = 'oe' 
              AND TABLE_NAME = @TableName
              AND OBJECTPROPERTY(OBJECT_ID(CONSTRAINT_SCHEMA + '.' + CONSTRAINT_NAME), 'IsPrimaryKey') = 1
            ORDER BY ORDINAL_POSITION;
            
            IF LEN(@PKColumns) > 0
            BEGIN
                SET @PKColumns = LEFT(@PKColumns, LEN(@PKColumns) - 1); -- Remove trailing comma
                SET @SQL = @SQL + ', CONSTRAINT [PK_' + @TableName + '] PRIMARY KEY (' + @PKColumns + ')';
            END
            
            SET @SQL = @SQL + ');';
            
            -- Execute CREATE TABLE
            BEGIN TRY
                EXEC sp_executesql @SQL;
                PRINT '✅ Created table: ' + @TableName;
                
                -- Add foreign keys
                DECLARE @FKName NVARCHAR(128);
                DECLARE @FKColumn NVARCHAR(128);
                DECLARE @RefTable NVARCHAR(128);
                DECLARE @RefColumn NVARCHAR(128);
                
                DECLARE fk_cursor CURSOR FOR
                SELECT 
                    fk.CONSTRAINT_NAME,
                    fk.COLUMN_NAME,
                    pk.TABLE_NAME AS REFERENCED_TABLE,
                    pk.COLUMN_NAME AS REFERENCED_COLUMN
                FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
                JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE fk 
                    ON rc.CONSTRAINT_NAME = fk.CONSTRAINT_NAME
                    AND rc.CONSTRAINT_SCHEMA = fk.CONSTRAINT_SCHEMA
                JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE pk 
                    ON rc.UNIQUE_CONSTRAINT_NAME = pk.CONSTRAINT_NAME
                    AND rc.UNIQUE_CONSTRAINT_SCHEMA = pk.CONSTRAINT_SCHEMA
                WHERE fk.TABLE_SCHEMA = 'oe' AND fk.TABLE_NAME = @TableName;
                
                OPEN fk_cursor;
                FETCH NEXT FROM fk_cursor INTO @FKName, @FKColumn, @RefTable, @RefColumn;
                
                WHILE @@FETCH_STATUS = 0
                BEGIN
                    IF NOT EXISTS (
                        SELECT 1 
                        FROM sys.foreign_keys 
                        WHERE name = @FKName
                    )
                    BEGIN
                        SET @SQL = 'ALTER TABLE [oe].' + QUOTENAME(@TableName) + 
                                   ' ADD CONSTRAINT ' + QUOTENAME(@FKName) + 
                                   ' FOREIGN KEY (' + QUOTENAME(@FKColumn) + ')' +
                                   ' REFERENCES [oe].' + QUOTENAME(@RefTable) + 
                                   ' (' + QUOTENAME(@RefColumn) + ');';
                        
                        BEGIN TRY
                            EXEC sp_executesql @SQL;
                            PRINT '✅ Added foreign key: ' + @FKName;
                        END TRY
                        BEGIN CATCH
                            PRINT '⚠️  Could not add foreign key ' + @FKName + ': ' + ERROR_MESSAGE();
                        END CATCH
                    END
                    
                    FETCH NEXT FROM fk_cursor INTO @FKName, @FKColumn, @RefTable, @RefColumn;
                END
                
                CLOSE fk_cursor;
                DEALLOCATE fk_cursor;
            END TRY
            BEGIN CATCH
                PRINT '❌ Error creating table: ' + ERROR_MESSAGE();
            END CATCH
        END
        
        FETCH NEXT FROM table_cursor INTO @TableName;
    END
    
    CLOSE table_cursor;
    DEALLOCATE table_cursor;
    
    IF OBJECT_ID('tempdb..#TableList') IS NOT NULL DROP TABLE #TableList;
    
    PRINT '';
    PRINT '============================================================================';
    PRINT '✅ Database recreation complete!';
    PRINT '============================================================================';
    PRINT '';
    PRINT 'Note: This script recreates schema only.';
    PRINT 'For data migration, use SQL Server Import/Export Wizard or:';
    PRINT '  INSERT INTO [oe].[TableName] SELECT * FROM [SourceDB].[oe].[TableName]';
    PRINT '';
END
GO

-- ============================================================================
-- EXAMPLE USAGE
-- ============================================================================

PRINT '';
PRINT '============================================================================';
PRINT 'DATABASE RECREATION SCRIPT READY';
PRINT '============================================================================';
PRINT '';
PRINT 'To recreate all tables (schema only):';
PRINT '  EXEC [oe].[RecreateDatabaseSchema];';
PRINT '';
PRINT 'To recreate specific tables only:';
PRINT '  EXEC [oe].[RecreateDatabaseSchema] @TableFilter = ''Users,Agents,Members'';';
PRINT '';
PRINT '============================================================================';
PRINT '';

-- Uncomment the line below to run automatically:
-- EXEC [oe].[RecreateDatabaseSchema];
