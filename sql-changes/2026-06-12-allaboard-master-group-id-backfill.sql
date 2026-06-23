-- =============================================================================
-- AllAboard Master Group ID — Data backfill (6-digit numeric IDs)
-- Date: 2026-06-12
--
-- Assigns sequential 6-digit AllAboardMasterGroupId per tenant (000001, 000002, …)
-- for groups missing a valid 6-digit ID (includes legacy slug values like ACME-CORP).
--
-- @DryRun = 1  → list every group + proposed ID (no writes)
-- @DryRun = 0  → apply (explicit approval only)
-- @PreviewLocations = 1 → also show location ID preview (off by default)
-- =============================================================================

IF OBJECT_ID('tempdb..#MasterBackfill') IS NOT NULL DROP TABLE #MasterBackfill;
IF OBJECT_ID('tempdb..#AllAboardMasterIdBackfill') IS NOT NULL DROP TABLE #AllAboardMasterIdBackfill;

DECLARE @DryRun BIT = 1;
DECLARE @PreviewLocations BIT = 0;

BEGIN TRY
    IF NOT EXISTS (
        SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'Groups' AND COLUMN_NAME = 'AllAboardMasterGroupId'
    )
    BEGIN
        RAISERROR('Column oe.Groups.AllAboardMasterGroupId missing — run schema migration first.', 16, 1);
    END

    CREATE TABLE #AllAboardMasterIdBackfill (
        GroupId UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
        TenantId UNIQUEIDENTIFIER NOT NULL,
        GroupName NVARCHAR(255) NULL,
        Status NVARCHAR(50) NULL,
        ProposedMasterId NVARCHAR(6) NOT NULL
    );

    ;WITH NeedAssign AS (
        SELECT
            g.GroupId,
            g.TenantId,
            g.Name,
            g.Status,
            g.CreatedDate,
            g.AllAboardMasterGroupId,
            CASE
                WHEN g.AllAboardMasterGroupId IS NOT NULL
                 AND LEN(LTRIM(RTRIM(g.AllAboardMasterGroupId))) = 6
                 AND g.AllAboardMasterGroupId NOT LIKE '%[^0-9]%'
                THEN 1 ELSE 0
            END AS HasValidNumericId
        FROM oe.Groups g
    ),
    ToAssign AS (
        SELECT
            na.*,
            ROW_NUMBER() OVER (PARTITION BY na.TenantId ORDER BY na.CreatedDate ASC, na.GroupId ASC) AS AssignSeq
        FROM NeedAssign na
        WHERE na.HasValidNumericId = 0
    ),
    TenantMax AS (
        SELECT
            t.TenantId,
            ISNULL((
                SELECT MAX(TRY_CAST(g.AllAboardMasterGroupId AS INT))
                FROM oe.Groups g
                WHERE g.TenantId = t.TenantId
                  AND g.AllAboardMasterGroupId IS NOT NULL
                  AND LEN(LTRIM(RTRIM(g.AllAboardMasterGroupId))) = 6
                  AND g.AllAboardMasterGroupId NOT LIKE '%[^0-9]%'
            ), 0) AS MaxNum
        FROM (SELECT DISTINCT TenantId FROM oe.Groups) t
    )
    INSERT INTO #AllAboardMasterIdBackfill (GroupId, TenantId, GroupName, Status, ProposedMasterId)
    SELECT
        t.GroupId,
        t.TenantId,
        t.Name,
        t.Status,
        RIGHT(N'000000' + CAST(tm.MaxNum + t.AssignSeq AS NVARCHAR(6)), 6)
    FROM ToAssign t
    INNER JOIN TenantMax tm ON tm.TenantId = t.TenantId;

    SELECT COUNT(*) AS GroupsToBackfill FROM #AllAboardMasterIdBackfill;

    SELECT
        COUNT(*) AS TotalGroups,
        SUM(CASE WHEN AllAboardMasterGroupId IS NULL OR LTRIM(RTRIM(AllAboardMasterGroupId)) = '' THEN 1 ELSE 0 END) AS MissingMasterId,
        SUM(CASE WHEN AllAboardMasterGroupId IS NOT NULL AND LTRIM(RTRIM(AllAboardMasterGroupId)) <> '' THEN 1 ELSE 0 END) AS HasMasterId
    FROM oe.Groups;

    SELECT
        g.GroupId,
        g.Name AS GroupName,
        g.Status,
        g.AllAboardMasterGroupId AS CurrentMasterId,
        COALESCE(
            CASE
                WHEN g.AllAboardMasterGroupId IS NOT NULL
                 AND LEN(LTRIM(RTRIM(g.AllAboardMasterGroupId))) = 6
                 AND g.AllAboardMasterGroupId NOT LIKE '%[^0-9]%'
                THEN g.AllAboardMasterGroupId
                ELSE NULL
            END,
            b.ProposedMasterId
        ) AS AfterBackfillMasterId,
        CASE
            WHEN g.AllAboardMasterGroupId IS NOT NULL
             AND LEN(LTRIM(RTRIM(g.AllAboardMasterGroupId))) = 6
             AND g.AllAboardMasterGroupId NOT LIKE '%[^0-9]%'
            THEN N'Keep existing'
            WHEN b.GroupId IS NOT NULL
             AND g.AllAboardMasterGroupId IS NOT NULL
             AND LTRIM(RTRIM(g.AllAboardMasterGroupId)) <> N''
            THEN N'Will replace slug'
            WHEN b.GroupId IS NOT NULL THEN N'Will assign'
            ELSE N'No change'
        END AS Action
    FROM oe.Groups g
    LEFT JOIN #AllAboardMasterIdBackfill b ON b.GroupId = g.GroupId
    ORDER BY g.Status, g.Name;

    SELECT b.GroupName, b.Status, b.ProposedMasterId
    FROM #AllAboardMasterIdBackfill b
    ORDER BY b.TenantId, b.ProposedMasterId;

    SELECT b.TenantId, b.ProposedMasterId, COUNT(*) AS Cnt
    FROM #AllAboardMasterIdBackfill b
    GROUP BY b.TenantId, b.ProposedMasterId
    HAVING COUNT(*) > 1;

    IF @DryRun = 1
    BEGIN
        IF @PreviewLocations = 1
        BEGIN
            SELECT g.Name AS GroupName, gl.Name AS LocationName,
                COALESCE(
                    CASE
                        WHEN g.AllAboardMasterGroupId IS NOT NULL
                         AND LEN(LTRIM(RTRIM(g.AllAboardMasterGroupId))) = 6
                         AND g.AllAboardMasterGroupId NOT LIKE '%[^0-9]%'
                        THEN g.AllAboardMasterGroupId ELSE NULL END,
                    b.ProposedMasterId
                ) AS MasterId,
                gl.AllAboardGroupId AS CurrentLocationId,
                CASE
                    WHEN gl.IsGroupIdOverride = 1 THEN gl.AllAboardGroupId
                    WHEN loc_counts.LocCount = 1 THEN COALESCE(
                        CASE WHEN g.AllAboardMasterGroupId IS NOT NULL AND LEN(LTRIM(RTRIM(g.AllAboardMasterGroupId))) = 6 AND g.AllAboardMasterGroupId NOT LIKE '%[^0-9]%' THEN g.AllAboardMasterGroupId ELSE NULL END,
                        b.ProposedMasterId)
                    ELSE LEFT(COALESCE(
                        CASE WHEN g.AllAboardMasterGroupId IS NOT NULL AND LEN(LTRIM(RTRIM(g.AllAboardMasterGroupId))) = 6 AND g.AllAboardMasterGroupId NOT LIKE '%[^0-9]%' THEN g.AllAboardMasterGroupId ELSE NULL END,
                        b.ProposedMasterId) + N'-' + RIGHT(N'0' + CAST(loc_rank.Rn AS NVARCHAR(2)), 2), 100)
                END AS ProposedLocationId
            FROM oe.GroupLocations gl
            INNER JOIN oe.Groups g ON g.GroupId = gl.GroupId
            LEFT JOIN #AllAboardMasterIdBackfill b ON b.GroupId = g.GroupId
            INNER JOIN (SELECT GroupId, COUNT(*) AS LocCount FROM oe.GroupLocations WHERE Status = N'Active' GROUP BY GroupId) loc_counts ON loc_counts.GroupId = gl.GroupId
            INNER JOIN (
                SELECT LocationId, ROW_NUMBER() OVER (PARTITION BY GroupId ORDER BY IsPrimary DESC, CreatedDate ASC) AS Rn
                FROM oe.GroupLocations WHERE Status = N'Active'
            ) loc_rank ON loc_rank.LocationId = gl.LocationId
            WHERE gl.Status = N'Active'
            ORDER BY g.Name, gl.IsPrimary DESC;
        END

        DROP TABLE #AllAboardMasterIdBackfill;
        RETURN;
    END

    BEGIN TRANSACTION;

    UPDATE g
    SET g.AllAboardMasterGroupId = b.ProposedMasterId, g.ModifiedDate = GETUTCDATE()
    FROM oe.Groups g
    INNER JOIN #AllAboardMasterIdBackfill b ON b.GroupId = g.GroupId;

    UPDATE gl
    SET gl.AllAboardGroupId = CASE
            WHEN gl.IsGroupIdOverride = 1 THEN gl.AllAboardGroupId
            WHEN loc_counts.LocCount = 1 THEN g.AllAboardMasterGroupId
            ELSE LEFT(g.AllAboardMasterGroupId + N'-' + RIGHT(N'0' + CAST(loc_rank.Rn AS NVARCHAR(2)), 2), 100)
        END,
        gl.ModifiedDate = GETUTCDATE()
    FROM oe.GroupLocations gl
    INNER JOIN oe.Groups g ON g.GroupId = gl.GroupId
    INNER JOIN (SELECT GroupId, COUNT(*) AS LocCount FROM oe.GroupLocations WHERE Status = N'Active' GROUP BY GroupId) loc_counts ON loc_counts.GroupId = gl.GroupId
    INNER JOIN (
        SELECT LocationId, ROW_NUMBER() OVER (PARTITION BY GroupId ORDER BY IsPrimary DESC, CreatedDate ASC) AS Rn
        FROM oe.GroupLocations WHERE Status = N'Active'
    ) loc_rank ON loc_rank.LocationId = gl.LocationId
    WHERE gl.Status = N'Active'
      AND gl.IsGroupIdOverride = 0
      AND g.AllAboardMasterGroupId IS NOT NULL
      AND LEN(LTRIM(RTRIM(g.AllAboardMasterGroupId))) = 6
      AND g.AllAboardMasterGroupId NOT LIKE '%[^0-9]%';

    COMMIT TRANSACTION;
    DROP TABLE #AllAboardMasterIdBackfill;

    SELECT COUNT(*) AS TotalGroups,
        SUM(CASE WHEN AllAboardMasterGroupId IS NULL OR LTRIM(RTRIM(AllAboardMasterGroupId)) = '' THEN 1 ELSE 0 END) AS MissingMasterId,
        SUM(CASE WHEN AllAboardMasterGroupId IS NOT NULL AND LTRIM(RTRIM(AllAboardMasterGroupId)) <> '' THEN 1 ELSE 0 END) AS HasMasterId
    FROM oe.Groups;

END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    IF OBJECT_ID('tempdb..#AllAboardMasterIdBackfill') IS NOT NULL DROP TABLE #AllAboardMasterIdBackfill;
    SELECT ERROR_MESSAGE() AS [Error], ERROR_LINE() AS [Line], ERROR_NUMBER() AS [Number];
END CATCH;
