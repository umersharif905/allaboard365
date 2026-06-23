-- ============================================================================
-- DATABASE RECREATION SCRIPT
-- ============================================================================
-- This script recreates database tables with IF EXISTS logic and optionally
-- migrates data from a source database.
--
-- Usage:
--   1. Set @SourceDatabase if copying from another database (NULL = same database)
--   2. Set @MigrateData = 1 to migrate data, 0 for schema only
--   3. Set @TableFilter to process specific tables (NULL = all tables)
--   4. Execute the script
--
-- Example:
--   EXEC [oe].[RecreateDatabaseSchema] 
--       @SourceDatabase = NULL,  -- NULL = same database
--       @MigrateData = 0,        -- 0 = schema only, 1 = include data
--       @TableFilter = NULL;     -- NULL = all tables, or 'Users,Agents,Members'
-- ============================================================================

USE [open-enroll-dev]; -- Change to your target database name
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
    @SourceDatabase NVARCHAR(128) = NULL,  -- NULL = same database, or specify source database name
    @MigrateData BIT = 0,                  -- 0 = schema only, 1 = include data migration
    @TableFilter NVARCHAR(MAX) = NULL      -- NULL = all tables, or comma-separated list like 'Users,Agents,Members'
AS
BEGIN
    SET NOCOUNT ON;
    
    DECLARE @SourceDBPrefix NVARCHAR(200) = '';
    DECLARE @SourceDBQuery NVARCHAR(MAX) = '';
    IF @SourceDatabase IS NOT NULL AND @SourceDatabase != DB_NAME()
    BEGIN
        SET @SourceDBPrefix = QUOTENAME(@SourceDatabase) + '.';
        SET @SourceDBQuery = 'USE ' + QUOTENAME(@SourceDatabase) + '; ';
    END
    
    DECLARE @TableName NVARCHAR(128);
    DECLARE @SQL NVARCHAR(MAX);
    DECLARE @ColumnSQL NVARCHAR(MAX);
    DECLARE @PKColumns NVARCHAR(MAX);
    DECLARE @FKSQL NVARCHAR(MAX);
    DECLARE @IndexSQL NVARCHAR(MAX);
    
    -- Get table list from source database
    DECLARE @TableListSQL NVARCHAR(MAX);
    SET @TableListSQL = @SourceDBQuery + 
        'SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES ' +
        'WHERE TABLE_SCHEMA = ''oe'' AND TABLE_TYPE = ''BASE TABLE''';
    
    IF @TableFilter IS NOT NULL
    BEGIN
        SET @TableListSQL = @TableListSQL + ' AND TABLE_NAME IN (';
        DECLARE @FilterList NVARCHAR(MAX) = '';
        SELECT @FilterList = @FilterList + '''' + LTRIM(RTRIM(value)) + ''','
        FROM STRING_SPLIT(@TableFilter, ',');
        SET @FilterList = LEFT(@FilterList, LEN(@FilterList) - 1);
        SET @TableListSQL = @TableListSQL + @FilterList + ')';
    END
    
    SET @TableListSQL = @TableListSQL + ' ORDER BY TABLE_NAME';
    
    -- Create temp table to store table list
    CREATE TABLE #TableList (TABLE_NAME NVARCHAR(128));
    
    -- Insert table names from source
    IF @SourceDatabase IS NOT NULL AND @SourceDatabase != DB_NAME()
    BEGIN
        SET @SQL = 'INSERT INTO #TableList EXEC(''' + REPLACE(@TableListSQL, '''', '''''') + ''') AT [' + @SourceDatabase + ']';
        -- For same server, use simpler approach
        SET @SQL = 'INSERT INTO #TableList SELECT TABLE_NAME FROM ' + QUOTENAME(@SourceDatabase) + '.INFORMATION_SCHEMA.TABLES ' +
                   'WHERE TABLE_SCHEMA = ''oe'' AND TABLE_TYPE = ''BASE TABLE''';
        IF @TableFilter IS NOT NULL
        BEGIN
            SET @SQL = @SQL + ' AND TABLE_NAME IN (';
            SET @FilterList = '';
            SELECT @FilterList = @FilterList + '''' + LTRIM(RTRIM(value)) + ''','
            FROM STRING_SPLIT(@TableFilter, ',');
            SET @FilterList = LEFT(@FilterList, LEN(@FilterList) - 1);
            SET @SQL = @SQL + @FilterList + ')';
        END
        SET @SQL = @SQL + ' ORDER BY TABLE_NAME';
    END
    ELSE
    BEGIN
        SET @SQL = @TableListSQL;
    END
    
    INSERT INTO #TableList
    EXEC sp_executesql @SQL;
    
    -- Cursor to iterate through tables
    DECLARE table_cursor CURSOR FOR
    SELECT TABLE_NAME FROM #TableList;
    
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
            DECLARE @ColumnName NVARCHAR(128);
            DECLARE @DataType NVARCHAR(128);
            DECLARE @IsNullable NVARCHAR(10);
            DECLARE @ColumnDefault NVARCHAR(MAX);
            DECLARE @CharMaxLength INT;
            DECLARE @NumericPrecision INT;
            DECLARE @NumericScale INT;
            
            -- Get column info from source database
            SET @SQL = 'SELECT 
                COLUMN_NAME,
                DATA_TYPE,
                IS_NULLABLE,
                COLUMN_DEFAULT,
                CHARACTER_MAXIMUM_LENGTH,
                NUMERIC_PRECISION,
                NUMERIC_SCALE
            FROM ' + @SourceDBPrefix + 'INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = ''oe'' 
              AND TABLE_NAME = ''' + @TableName + '''
            ORDER BY ORDINAL_POSITION';
            
            CREATE TABLE #ColumnInfo (
                COLUMN_NAME NVARCHAR(128),
                DATA_TYPE NVARCHAR(128),
                IS_NULLABLE NVARCHAR(10),
                COLUMN_DEFAULT NVARCHAR(MAX),
                CHARACTER_MAXIMUM_LENGTH INT,
                NUMERIC_PRECISION INT,
                NUMERIC_SCALE INT
            );
            
            INSERT INTO #ColumnInfo
            EXEC sp_executesql @SQL;
            
            DECLARE column_cursor CURSOR FOR
            SELECT * FROM #ColumnInfo;
            
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
            DROP TABLE #ColumnInfo;
        END
        ELSE
        BEGIN
            PRINT '📝 Creating table: ' + @TableName;
            
            -- Build CREATE TABLE statement
            SET @SQL = 'CREATE TABLE [oe].' + QUOTENAME(@TableName) + ' (';
            SET @ColumnSQL = '';
            
            -- Get columns from source database
            SET @SQL = 'SELECT 
                COLUMN_NAME,
                DATA_TYPE,
                IS_NULLABLE,
                COLUMN_DEFAULT,
                CHARACTER_MAXIMUM_LENGTH,
                NUMERIC_PRECISION,
                NUMERIC_SCALE
            FROM ' + @SourceDBPrefix + 'INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = ''oe'' 
              AND TABLE_NAME = ''' + @TableName + '''
            ORDER BY ORDINAL_POSITION';
            
            DROP TABLE IF EXISTS #ColumnInfo2;
            CREATE TABLE #ColumnInfo2 (
                COLUMN_NAME NVARCHAR(128),
                DATA_TYPE NVARCHAR(128),
                IS_NULLABLE NVARCHAR(10),
                COLUMN_DEFAULT NVARCHAR(MAX),
                CHARACTER_MAXIMUM_LENGTH INT,
                NUMERIC_PRECISION INT,
                NUMERIC_SCALE INT
            );
            
            INSERT INTO #ColumnInfo2
            EXEC sp_executesql @SQL;
            
            DECLARE column_cursor2 CURSOR FOR
            SELECT * FROM #ColumnInfo2;
            
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
            
            -- Add primary key if exists (from source)
            SET @SQL = 'SELECT @PKCols = STRING_AGG(QUOTENAME(COLUMN_NAME), '', '') WITHIN GROUP (ORDER BY ORDINAL_POSITION)
            FROM ' + @SourceDBPrefix + 'INFORMATION_SCHEMA.KEY_COLUMN_USAGE
            WHERE TABLE_SCHEMA = ''oe'' 
              AND TABLE_NAME = ''' + @TableName + '''
              AND OBJECTPROPERTY(OBJECT_ID(CONSTRAINT_SCHEMA + ''.'' + CONSTRAINT_NAME), ''IsPrimaryKey'') = 1';
            
            SET @PKColumns = '';
            EXEC sp_executesql @SQL, N'@PKCols NVARCHAR(MAX) OUTPUT', @PKCols = @PKColumns OUTPUT;
            
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
                
                -- Get foreign keys from source
                SET @SQL = 'SELECT 
                    fk.CONSTRAINT_NAME,
                    fk.COLUMN_NAME,
                    pk.TABLE_NAME AS REFERENCED_TABLE,
                    pk.COLUMN_NAME AS REFERENCED_COLUMN
                FROM ' + @SourceDBPrefix + 'INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
                JOIN ' + @SourceDBPrefix + 'INFORMATION_SCHEMA.KEY_COLUMN_USAGE fk 
                    ON rc.CONSTRAINT_NAME = fk.CONSTRAINT_NAME
                    AND rc.CONSTRAINT_SCHEMA = fk.CONSTRAINT_SCHEMA
                JOIN ' + @SourceDBPrefix + 'INFORMATION_SCHEMA.KEY_COLUMN_USAGE pk 
                    ON rc.UNIQUE_CONSTRAINT_NAME = pk.CONSTRAINT_NAME
                    AND rc.UNIQUE_CONSTRAINT_SCHEMA = pk.CONSTRAINT_SCHEMA
                WHERE fk.TABLE_SCHEMA = ''oe'' 
                  AND fk.TABLE_NAME = ''' + @TableName + '''';
                
                DROP TABLE IF EXISTS #FKInfo;
                CREATE TABLE #FKInfo (
                    CONSTRAINT_NAME NVARCHAR(128),
                    COLUMN_NAME NVARCHAR(128),
                    REFERENCED_TABLE NVARCHAR(128),
                    REFERENCED_COLUMN NVARCHAR(128)
                );
                
                INSERT INTO #FKInfo
                EXEC sp_executesql @SQL;
                
                DECLARE fk_cursor CURSOR FOR
                SELECT * FROM #FKInfo;
                
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
                DROP TABLE #FKInfo;
                
                -- Add indexes (non-primary) - Note: Index recreation from source requires more complex logic
                -- For now, we'll skip automatic index recreation from source database
                -- You can manually add indexes after table creation
                PRINT '⚠️  Note: Indexes should be added manually or via separate script';
                
                DROP TABLE #ColumnInfo2;
                
                OPEN idx_cursor;
                FETCH NEXT FROM idx_cursor INTO @IndexName, @IsUnique, @IndexColumns;
                
                WHILE @@FETCH_STATUS = 0
                BEGIN
                    IF NOT EXISTS (
                        SELECT 1 
                        FROM sys.indexes 
                        WHERE name = @IndexName 
                          AND object_id = OBJECT_ID('oe.' + @TableName)
                    )
                    BEGIN
                        SET @IndexSQL = 'CREATE ';
                        IF @IsUnique = 1
                            SET @IndexSQL = @IndexSQL + 'UNIQUE ';
                        SET @IndexSQL = @IndexSQL + 'NONCLUSTERED INDEX ' + QUOTENAME(@IndexName) + 
                                       ' ON [oe].' + QUOTENAME(@TableName) + 
                                       ' (' + @IndexColumns + ');';
                        
                        BEGIN TRY
                            EXEC sp_executesql @IndexSQL;
                            PRINT '✅ Added index: ' + @IndexName;
                        END TRY
                        BEGIN CATCH
                            PRINT '⚠️  Could not add index ' + @IndexName + ': ' + ERROR_MESSAGE();
                        END CATCH
                    END
                    
                    FETCH NEXT FROM idx_cursor INTO @IndexName, @IsUnique, @IndexColumns;
                END
                
                CLOSE idx_cursor;
                DEALLOCATE idx_cursor;
            END
            ELSE
            BEGIN
                PRINT '❌ Error creating table: ' + ERROR_MESSAGE();
            END
        END
        
        -- Migrate data if requested
        IF @MigrateData = 1
        BEGIN
            PRINT '📦 Migrating data for table: ' + @TableName;
            
            -- Get primary keys for MERGE (from source)
            SET @SQL = 'SELECT @PKCols = STRING_AGG(QUOTENAME(COLUMN_NAME), '', '') WITHIN GROUP (ORDER BY ORDINAL_POSITION)
            FROM ' + @SourceDBPrefix + 'INFORMATION_SCHEMA.KEY_COLUMN_USAGE
            WHERE TABLE_SCHEMA = ''oe'' 
              AND TABLE_NAME = ''' + @TableName + '''
              AND OBJECTPROPERTY(OBJECT_ID(CONSTRAINT_SCHEMA + ''.'' + CONSTRAINT_NAME), ''IsPrimaryKey'') = 1';
            
            SET @PKColumns = '';
            EXEC sp_executesql @SQL, N'@PKCols NVARCHAR(MAX) OUTPUT', @PKCols = @PKColumns OUTPUT;
            
            IF LEN(@PKColumns) > 0
            BEGIN
                -- Get all columns from source
                SET @SQL = 'SELECT 
                    STRING_AGG(QUOTENAME(COLUMN_NAME), '', '') WITHIN GROUP (ORDER BY ORDINAL_POSITION) AS AllCols,
                    STRING_AGG(QUOTENAME(COLUMN_NAME), '', '') WITHIN GROUP (ORDER BY ORDINAL_POSITION) AS InsertCols,
                    STRING_AGG(''s.'' + QUOTENAME(COLUMN_NAME), '', '') WITHIN GROUP (ORDER BY ORDINAL_POSITION) AS InsertVals
                FROM ' + @SourceDBPrefix + 'INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_SCHEMA = ''oe'' AND TABLE_NAME = ''' + @TableName + '''';
                
                DECLARE @AllColumns NVARCHAR(MAX);
                DECLARE @InsertColumns NVARCHAR(MAX);
                DECLARE @InsertValues NVARCHAR(MAX);
                
                CREATE TABLE #ColInfo (AllCols NVARCHAR(MAX), InsertCols NVARCHAR(MAX), InsertVals NVARCHAR(MAX));
                INSERT INTO #ColInfo EXEC sp_executesql @SQL;
                SELECT @AllColumns = AllCols, @InsertColumns = InsertCols, @InsertValues = InsertVals FROM #ColInfo;
                DROP TABLE #ColInfo;
                
                -- Build update columns (exclude primary keys)
                SET @SQL = 'SELECT @UpdateCols = STRING_AGG(''t.'' + QUOTENAME(COLUMN_NAME) + '' = s.'' + QUOTENAME(COLUMN_NAME), '', '') WITHIN GROUP (ORDER BY ORDINAL_POSITION)
                FROM ' + @SourceDBPrefix + 'INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_SCHEMA = ''oe'' 
                  AND TABLE_NAME = ''' + @TableName + '''
                  AND COLUMN_NAME NOT IN (
                      SELECT COLUMN_NAME
                      FROM ' + @SourceDBPrefix + 'INFORMATION_SCHEMA.KEY_COLUMN_USAGE
                      WHERE TABLE_SCHEMA = ''oe'' 
                        AND TABLE_NAME = ''' + @TableName + '''
                        AND OBJECTPROPERTY(OBJECT_ID(CONSTRAINT_SCHEMA + ''.'' + CONSTRAINT_NAME), ''IsPrimaryKey'') = 1
                  )';
                
                DECLARE @UpdateColumns NVARCHAR(MAX) = '';
                EXEC sp_executesql @SQL, N'@UpdateCols NVARCHAR(MAX) OUTPUT', @UpdateCols = @UpdateColumns OUTPUT;
                
                -- Build match condition
                SET @SQL = 'SELECT @MatchCond = STRING_AGG(''t.'' + QUOTENAME(COLUMN_NAME) + '' = s.'' + QUOTENAME(COLUMN_NAME), '' AND '') WITHIN GROUP (ORDER BY ORDINAL_POSITION)
                FROM ' + @SourceDBPrefix + 'INFORMATION_SCHEMA.KEY_COLUMN_USAGE
                WHERE TABLE_SCHEMA = ''oe'' 
                  AND TABLE_NAME = ''' + @TableName + '''
                  AND OBJECTPROPERTY(OBJECT_ID(CONSTRAINT_SCHEMA + ''.'' + CONSTRAINT_NAME), ''IsPrimaryKey'') = 1';
                
                DECLARE @MatchCondition NVARCHAR(MAX) = '';
                EXEC sp_executesql @SQL, N'@MatchCond NVARCHAR(MAX) OUTPUT', @MatchCond = @MatchCondition OUTPUT;
                
                -- Build MERGE statement
                SET @SQL = 'MERGE [oe].' + QUOTENAME(@TableName) + ' AS t' +
                           ' USING ' + @SourceDBPrefix + '[oe].' + QUOTENAME(@TableName) + ' AS s' +
                           ' ON ' + @MatchCondition +
                           ' WHEN MATCHED THEN' +
                           '     UPDATE SET ' + @UpdateColumns +
                           ' WHEN NOT MATCHED THEN' +
                           '     INSERT (' + @InsertColumns + ')' +
                           '     VALUES (' + @InsertValues + ');';
                
                BEGIN TRY
                    EXEC sp_executesql @SQL;
                    
                    DECLARE @RowCount INT;
                    SET @SQL = 'SELECT @Count = COUNT(*) FROM ' + @SourceDBPrefix + '[oe].' + QUOTENAME(@TableName);
                    EXEC sp_executesql @SQL, N'@Count INT OUTPUT', @Count = @RowCount OUTPUT;
                    PRINT '✅ Migrated ' + CAST(@RowCount AS NVARCHAR(10)) + ' rows';
                END TRY
                BEGIN CATCH
                    PRINT '❌ Error migrating data: ' + ERROR_MESSAGE();
                END CATCH
            END
            ELSE
            BEGIN
                PRINT '⚠️  Table has no primary key, skipping data migration (use INSERT instead)';
            END
        END
        
        FETCH NEXT FROM table_cursor INTO @TableName;
    END
    
    CLOSE table_cursor;
    DEALLOCATE table_cursor;
    
    DROP TABLE #TableList;
    
    PRINT '';
    PRINT '============================================================================';
    PRINT '✅ Database recreation complete!';
    PRINT '============================================================================';
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
PRINT 'To recreate schema only (no data):';
PRINT '  EXEC [oe].[RecreateDatabaseSchema] @MigrateData = 0;';
PRINT '';
PRINT 'To recreate schema and migrate data:';
PRINT '  EXEC [oe].[RecreateDatabaseSchema] @MigrateData = 1;';
PRINT '';
PRINT 'To recreate specific tables only:';
PRINT '  EXEC [oe].[RecreateDatabaseSchema] @MigrateData = 0, @TableFilter = ''Users,Agents,Members'';';
PRINT '';
PRINT 'To copy from another database:';
PRINT '  EXEC [oe].[RecreateDatabaseSchema] @SourceDatabase = ''open-enroll'', @MigrateData = 1;';
PRINT '';
PRINT '============================================================================';
PRINT '';

-- Uncomment the line below to run automatically:
-- EXEC [oe].[RecreateDatabaseSchema] @MigrateData = 0;
