-- =============================================================================
-- AllAboard Master Group ID — Schema + Backfill
-- Date: 2026-06-02
--
-- Adds:
--   oe.Groups.AllAboardMasterGroupId           NVARCHAR(100) NULL
--   oe.GroupLocations.AllAboardGroupId         NVARCHAR(100) NULL
--   oe.GroupLocations.IsGroupIdOverride        BIT NOT NULL DEFAULT 0
--
-- Unique indexes (NULLs excluded via filtered index):
--   UX_Groups_TenantId_AllAboardMasterGroupId
--   UX_GroupLocations_GroupId_AllAboardGroupId   (fallback when no TenantId col)
--   UX_GroupLocations_TenantId_AllAboardGroupId  (preferred when TenantId exists)
--
-- @DryRun = 1  → preview only (prints what would change, makes no schema changes)
-- @DryRun = 0  → execute schema changes and backfill
-- =============================================================================

DECLARE @DryRun BIT = 1;

PRINT '==============================================================';
PRINT 'AllAboard Master Group ID — Schema Migration';
PRINT 'DryRun = ' + CAST(@DryRun AS NVARCHAR(1));
PRINT '==============================================================';

-- -----------------------------------------------------------------------
-- Preview: current affected row counts
-- -----------------------------------------------------------------------
SELECT
    'Groups total'                              AS Label,
    COUNT(*)                                    AS Count
FROM oe.Groups
UNION ALL
SELECT
    'Groups with null AllAboardMasterGroupId'   AS Label,
    COUNT(*)
FROM oe.Groups
WHERE NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'Groups' AND COLUMN_NAME = 'AllAboardMasterGroupId'
)
-- when column already exists, count NULLs
UNION ALL
SELECT
    'GroupLocations total'                      AS Label,
    COUNT(*)
FROM oe.GroupLocations;

-- -----------------------------------------------------------------------
-- 1. oe.Groups.AllAboardMasterGroupId
-- -----------------------------------------------------------------------
IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'Groups' AND COLUMN_NAME = 'AllAboardMasterGroupId'
)
BEGIN
    IF @DryRun = 1
        PRINT 'DRY RUN: Would execute: ALTER TABLE oe.Groups ADD AllAboardMasterGroupId NVARCHAR(100) NULL';
    ELSE
    BEGIN
        ALTER TABLE oe.Groups ADD AllAboardMasterGroupId NVARCHAR(100) NULL;
        PRINT 'DONE: Added oe.Groups.AllAboardMasterGroupId';
    END
END
ELSE
    PRINT 'SKIP: oe.Groups.AllAboardMasterGroupId already exists';

-- -----------------------------------------------------------------------
-- 2. oe.GroupLocations.AllAboardGroupId
-- -----------------------------------------------------------------------
IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'GroupLocations' AND COLUMN_NAME = 'AllAboardGroupId'
)
BEGIN
    IF @DryRun = 1
        PRINT 'DRY RUN: Would execute: ALTER TABLE oe.GroupLocations ADD AllAboardGroupId NVARCHAR(100) NULL';
    ELSE
    BEGIN
        ALTER TABLE oe.GroupLocations ADD AllAboardGroupId NVARCHAR(100) NULL;
        PRINT 'DONE: Added oe.GroupLocations.AllAboardGroupId';
    END
END
ELSE
    PRINT 'SKIP: oe.GroupLocations.AllAboardGroupId already exists';

-- -----------------------------------------------------------------------
-- 3. oe.GroupLocations.IsGroupIdOverride
-- -----------------------------------------------------------------------
IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'GroupLocations' AND COLUMN_NAME = 'IsGroupIdOverride'
)
BEGIN
    IF @DryRun = 1
        PRINT 'DRY RUN: Would execute: ALTER TABLE oe.GroupLocations ADD IsGroupIdOverride BIT NOT NULL DEFAULT 0';
    ELSE
    BEGIN
        ALTER TABLE oe.GroupLocations ADD IsGroupIdOverride BIT NOT NULL CONSTRAINT DF_GroupLocations_IsGroupIdOverride DEFAULT 0;
        PRINT 'DONE: Added oe.GroupLocations.IsGroupIdOverride';
    END
END
ELSE
    PRINT 'SKIP: oe.GroupLocations.IsGroupIdOverride already exists';

-- -----------------------------------------------------------------------
-- 4. Unique filtered index: oe.Groups (TenantId, AllAboardMasterGroupId)
--    Requires column to exist first — skip in DryRun
-- -----------------------------------------------------------------------
IF @DryRun = 1
    PRINT 'DRY RUN: Would create UNIQUE INDEX UX_Groups_TenantId_AllAboardMasterGroupId ON oe.Groups(TenantId, AllAboardMasterGroupId) WHERE AllAboardMasterGroupId IS NOT NULL';
ELSE
BEGIN
    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_Groups_TenantId_AllAboardMasterGroupId' AND object_id = OBJECT_ID('oe.Groups'))
    BEGIN
        EXEC sp_executesql N'
            CREATE UNIQUE INDEX UX_Groups_TenantId_AllAboardMasterGroupId
            ON oe.Groups (TenantId, AllAboardMasterGroupId)
            WHERE AllAboardMasterGroupId IS NOT NULL
        ';
        PRINT 'DONE: Created UX_Groups_TenantId_AllAboardMasterGroupId';
    END
    ELSE
        PRINT 'SKIP: UX_Groups_TenantId_AllAboardMasterGroupId already exists';
END

-- -----------------------------------------------------------------------
-- 5. Unique filtered index: oe.GroupLocations
--    Check if TenantId column exists; use GroupId as tenant proxy if not.
-- -----------------------------------------------------------------------
DECLARE @GlHasTenantId BIT = 0;
IF EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'GroupLocations' AND COLUMN_NAME = 'TenantId'
)
    SET @GlHasTenantId = 1;

IF @DryRun = 1
BEGIN
    IF @GlHasTenantId = 1
        PRINT 'DRY RUN: oe.GroupLocations HAS TenantId — Would create UX_GroupLocations_TenantId_AllAboardGroupId';
    ELSE
        PRINT 'DRY RUN: oe.GroupLocations has NO TenantId — Would create UX_GroupLocations_GroupId_AllAboardGroupId (GroupId as tenant proxy)';
END
ELSE
BEGIN
    IF @GlHasTenantId = 1
    BEGIN
        IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_GroupLocations_TenantId_AllAboardGroupId' AND object_id = OBJECT_ID('oe.GroupLocations'))
        BEGIN
            EXEC sp_executesql N'
                CREATE UNIQUE INDEX UX_GroupLocations_TenantId_AllAboardGroupId
                ON oe.GroupLocations (TenantId, AllAboardGroupId)
                WHERE AllAboardGroupId IS NOT NULL
            ';
            PRINT 'DONE: Created UX_GroupLocations_TenantId_AllAboardGroupId';
        END
        ELSE
            PRINT 'SKIP: UX_GroupLocations_TenantId_AllAboardGroupId already exists';
    END
    ELSE
    BEGIN
        IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_GroupLocations_GroupId_AllAboardGroupId' AND object_id = OBJECT_ID('oe.GroupLocations'))
        BEGIN
            EXEC sp_executesql N'
                CREATE UNIQUE INDEX UX_GroupLocations_GroupId_AllAboardGroupId
                ON oe.GroupLocations (GroupId, AllAboardGroupId)
                WHERE AllAboardGroupId IS NOT NULL
            ';
            PRINT 'DONE: Created UX_GroupLocations_GroupId_AllAboardGroupId';
        END
        ELSE
            PRINT 'SKIP: UX_GroupLocations_GroupId_AllAboardGroupId already exists';
    END
END

-- -----------------------------------------------------------------------
-- 6. Backfill preview — how many locations would be auto-assigned
--    (full recompute runs via Node service after column exists)
-- -----------------------------------------------------------------------
PRINT '';
PRINT 'Backfill preview:';
PRINT '  Groups with AllAboardMasterGroupId already set:';
PRINT '    (column may not exist yet — run this block after @DryRun=0 migration)';

IF EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'Groups' AND COLUMN_NAME = 'AllAboardMasterGroupId'
)
BEGIN
    -- Dynamic SQL: column refs fail batch compile if column not yet added
    EXEC sp_executesql N'
        SELECT
            ''Groups with AllAboardMasterGroupId set'' AS Label,
            COUNT(*) AS Count
        FROM oe.Groups
        WHERE AllAboardMasterGroupId IS NOT NULL AND Status = ''Active'';

        SELECT
            ''Groups without AllAboardMasterGroupId'' AS Label,
            COUNT(*) AS Count
        FROM oe.Groups
        WHERE AllAboardMasterGroupId IS NULL AND Status = ''Active'';
    ';
END
ELSE
    PRINT '  (Column does not yet exist — run with @DryRun=0 first)';

PRINT '';
PRINT '==============================================================';
PRINT 'Migration complete. Set @DryRun=0 to apply schema changes.';
PRINT '==============================================================';

-- =============================================================================
-- 7. Data backfill (run AFTER schema @DryRun=0 has been applied)
-- @ApplyBackfill = 0 → preview proposed master + location IDs only
-- @ApplyBackfill = 1 → write IDs (skips groups/locations that already have values)
-- =============================================================================
DECLARE @ApplyBackfill BIT = 0;

IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'Groups' AND COLUMN_NAME = 'AllAboardMasterGroupId'
)
BEGIN
    PRINT 'Backfill skipped — run schema migration (@DryRun=0) first.';
END
ELSE
BEGIN
    PRINT '';
    PRINT '--- Backfill preview (@ApplyBackfill=' + CAST(@ApplyBackfill AS NVARCHAR(1)) + ') ---';

    -- Dynamic SQL: avoids compile-time error when column was just added in same batch
    EXEC sp_executesql N'
        ;WITH GroupSlug AS (
            SELECT
                g.GroupId,
                g.TenantId,
                g.Name,
                g.AllAboardMasterGroupId AS ExistingMaster,
                UPPER(
                    LEFT(
                        REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
                            REPLACE(REPLACE(REPLACE(REPLACE(
                                REPLACE(LTRIM(RTRIM(g.Name)), '' '', ''-''),
                                ''&'', ''''), CHAR(39), ''''), ''.'', ''''), '','', ''''),
                            ''/'', ''-''), ''('', ''''), '')'', ''''), ''#'', ''''), ''@'', ''''),
                        100
                    )
                ) AS BaseSlug
            FROM oe.Groups g
            WHERE g.Status = ''Active''
        ),
        ProposedMaster AS (
            SELECT
                gs.GroupId,
                gs.TenantId,
                gs.ExistingMaster,
                CASE
                    WHEN gs.ExistingMaster IS NOT NULL THEN gs.ExistingMaster
                    WHEN NULLIF(REPLACE(REPLACE(gs.BaseSlug, ''-'', ''''), '' '', ''''), '''') IS NULL
                        THEN CONCAT(''GROUP-'', RIGHT(REPLACE(CAST(gs.GroupId AS NVARCHAR(36)), ''-'', ''''), 8))
                    ELSE gs.BaseSlug
                END AS ProposedMasterId
            FROM GroupSlug gs
        )
        SELECT TOP 200
            pm.GroupId,
            pm.TenantId,
            g.Name AS GroupName,
            pm.ExistingMaster,
            pm.ProposedMasterId
        FROM ProposedMaster pm
        INNER JOIN oe.Groups g ON g.GroupId = pm.GroupId
        WHERE pm.ExistingMaster IS NULL
        ORDER BY pm.TenantId, g.Name;
    ';

    IF @ApplyBackfill = 1 AND @DryRun = 0
    BEGIN
        EXEC sp_executesql N'
            ;WITH GroupSlug AS (
                SELECT
                    g.GroupId,
                    g.TenantId,
                    g.Name,
                    UPPER(
                        LEFT(
                            REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
                                REPLACE(REPLACE(REPLACE(REPLACE(
                                    REPLACE(LTRIM(RTRIM(g.Name)), '' '', ''-''),
                                    ''&'', ''''), CHAR(39), ''''), ''.'', ''''), '','', ''''),
                                ''/'', ''-''), ''('', ''''), '')'', ''''), ''#'', ''''), ''@'', ''''),
                            100
                        )
                    ) AS BaseSlug
                FROM oe.Groups g
                WHERE g.Status = ''Active'' AND g.AllAboardMasterGroupId IS NULL
            ),
            ProposedMaster AS (
                SELECT
                    gs.GroupId,
                    CASE
                        WHEN NULLIF(REPLACE(REPLACE(gs.BaseSlug, ''-'', ''''), '' '', ''''), '''') IS NULL
                            THEN CONCAT(''GROUP-'', RIGHT(REPLACE(CAST(gs.GroupId AS NVARCHAR(36)), ''-'', ''''), 8))
                        ELSE gs.BaseSlug
                    END AS ProposedMasterId
                FROM GroupSlug gs
            )
            UPDATE g
            SET g.AllAboardMasterGroupId = pm.ProposedMasterId,
                g.ModifiedDate = GETUTCDATE()
            FROM oe.Groups g
            INNER JOIN ProposedMaster pm ON pm.GroupId = g.GroupId
            WHERE g.AllAboardMasterGroupId IS NULL;
        ';

        PRINT 'Backfill: master group IDs assigned. Run groupMasterIdService.recomputeLocationGroupIds per group or use app trigger on next master-id save.';
    END
    ELSE IF @ApplyBackfill = 1 AND @DryRun = 1
        PRINT 'Backfill write blocked while @DryRun=1. Set @DryRun=0 and @ApplyBackfill=1 to apply.';
END
