-- Migration: Add CommissionTierLevel_Snapshot + CommissionTierLevel_Snapshot_Label to oe.Commissions
-- Purpose: Snapshot the agent/agency tier level (numeric + display name) at commission creation
--          so historical breakdowns show the correct level even after tier renames.
--
-- DryRun = 1 (default): preview only, no writes
-- DryRun = 0: execute ALTER TABLE + backfill

DECLARE @DryRun BIT = 1;

-- ============================================================
-- Step 1a: Add CommissionTierLevel_Snapshot (numeric)
-- ============================================================
IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('oe.Commissions')
    AND name = 'CommissionTierLevel_Snapshot'
)
BEGIN
  IF @DryRun = 0
  BEGIN
    ALTER TABLE oe.Commissions
      ADD CommissionTierLevel_Snapshot DECIMAL(9,4) NULL;
    PRINT 'Added CommissionTierLevel_Snapshot column to oe.Commissions';
  END
  ELSE
  BEGIN
    PRINT '[DryRun] Would add CommissionTierLevel_Snapshot column to oe.Commissions';
  END
END
ELSE
BEGIN
  PRINT 'Column CommissionTierLevel_Snapshot already exists — skipping';
END;

-- ============================================================
-- Step 1b: Add CommissionTierLevel_Snapshot_Label (display name)
-- ============================================================
IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('oe.Commissions')
    AND name = 'CommissionTierLevel_Snapshot_Label'
)
BEGIN
  IF @DryRun = 0
  BEGIN
    ALTER TABLE oe.Commissions
      ADD CommissionTierLevel_Snapshot_Label NVARCHAR(200) NULL;
    PRINT 'Added CommissionTierLevel_Snapshot_Label column to oe.Commissions';
  END
  ELSE
  BEGIN
    PRINT '[DryRun] Would add CommissionTierLevel_Snapshot_Label column to oe.Commissions';
  END
END
ELSE
BEGIN
  PRINT 'Column CommissionTierLevel_Snapshot_Label already exists — skipping';
END;

-- ============================================================
-- Step 2: Preview rows that will be backfilled
-- Column may not exist yet on first dry-run; guard accordingly.
-- ============================================================
IF EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('oe.Commissions')
    AND name = 'CommissionTierLevel_Snapshot'
)
BEGIN
  -- Column exists: show only rows still needing backfill
  DECLARE @previewSql NVARCHAR(MAX) = N'
    SELECT TOP 200
      c.CommissionId,
      c.AgentId,
      c.AgencyId,
      c.Status,
      c.TransactionType,
      c.CreatedDate,
      c.CommissionTierLevel_Snapshot        AS CurrentSnapshot,
      c.CommissionTierLevel_Snapshot_Label  AS CurrentLabel,
      COALESCE(cl_a.SortOrder, a.CommissionTierLevel, ag.CommissionTierLevel) AS TierLevel_ToSet,
      COALESCE(
        cl_a.DisplayName, cl_ag.DisplayName,
        CASE COALESCE(CAST(a.CommissionTierLevel AS INT), CAST(ag.CommissionTierLevel AS INT))
          WHEN -1 THEN N''Associate''
          WHEN  0 THEN N''Agent''
          WHEN  1 THEN N''Agency''
          WHEN  2 THEN N''GA''
          WHEN  3 THEN N''MGA''
          WHEN  4 THEN N''IMO''
          WHEN  5 THEN N''FMO''
          WHEN  6 THEN N''Enterprise/Carrier''
          ELSE NULL
        END
      ) AS Label_ToSet
    FROM oe.Commissions c
    LEFT JOIN oe.Agents    a    ON a.AgentId   = c.AgentId
    LEFT JOIN oe.Agencies  ag   ON ag.AgencyId = c.AgencyId
    LEFT JOIN oe.CommissionLevels cl_a  ON a.CommissionLevelId  = cl_a.CommissionLevelId  AND cl_a.IsActive  = 1
    LEFT JOIN oe.CommissionLevels cl_ag ON ag.CommissionLevelId = cl_ag.CommissionLevelId AND cl_ag.IsActive = 1
    WHERE c.CommissionTierLevel_Snapshot IS NULL
       OR c.CommissionTierLevel_Snapshot_Label IS NULL
    ORDER BY c.CreatedDate DESC
  ';
  EXEC sp_executesql @previewSql;
END
ELSE
BEGIN
  -- Column does not exist yet: show sample of rows that will be backfilled
  SELECT TOP 200
    c.CommissionId,
    c.AgentId,
    c.AgencyId,
    c.Status,
    c.TransactionType,
    c.CreatedDate,
    COALESCE(cl_a.SortOrder, a.CommissionTierLevel, ag.CommissionTierLevel) AS TierLevel_ToSet,
    COALESCE(
      cl_a.DisplayName, cl_ag.DisplayName,
      CASE COALESCE(CAST(a.CommissionTierLevel AS INT), CAST(ag.CommissionTierLevel AS INT))
        WHEN -1 THEN N'Associate'
        WHEN  0 THEN N'Agent'
        WHEN  1 THEN N'Agency'
        WHEN  2 THEN N'GA'
        WHEN  3 THEN N'MGA'
        WHEN  4 THEN N'IMO'
        WHEN  5 THEN N'FMO'
        WHEN  6 THEN N'Enterprise/Carrier'
        ELSE NULL
      END
    ) AS Label_ToSet
  FROM oe.Commissions c
  LEFT JOIN oe.Agents    a    ON a.AgentId   = c.AgentId
  LEFT JOIN oe.Agencies  ag   ON ag.AgencyId = c.AgencyId
  LEFT JOIN oe.CommissionLevels cl_a  ON a.CommissionLevelId  = cl_a.CommissionLevelId  AND cl_a.IsActive  = 1
  LEFT JOIN oe.CommissionLevels cl_ag ON ag.CommissionLevelId = cl_ag.CommissionLevelId AND cl_ag.IsActive = 1
  ORDER BY c.CreatedDate DESC;
END;

-- ============================================================
-- Step 3: Backfill existing rows (real run only)
-- ============================================================
IF @DryRun = 0
BEGIN
  DECLARE @backfillSql NVARCHAR(MAX) = N'
    UPDATE c SET
      c.CommissionTierLevel_Snapshot = COALESCE(
        cl_a.SortOrder, a.CommissionTierLevel, ag.CommissionTierLevel
      ),
      c.CommissionTierLevel_Snapshot_Label = COALESCE(
        cl_a.DisplayName, cl_ag.DisplayName,
        CASE COALESCE(CAST(a.CommissionTierLevel AS INT), CAST(ag.CommissionTierLevel AS INT))
          WHEN -1 THEN N''Associate''
          WHEN  0 THEN N''Agent''
          WHEN  1 THEN N''Agency''
          WHEN  2 THEN N''GA''
          WHEN  3 THEN N''MGA''
          WHEN  4 THEN N''IMO''
          WHEN  5 THEN N''FMO''
          WHEN  6 THEN N''Enterprise/Carrier''
          ELSE NULL
        END
      )
    FROM oe.Commissions c
    LEFT JOIN oe.Agents    a    ON a.AgentId   = c.AgentId
    LEFT JOIN oe.Agencies  ag   ON ag.AgencyId = c.AgencyId
    LEFT JOIN oe.CommissionLevels cl_a  ON a.CommissionLevelId  = cl_a.CommissionLevelId  AND cl_a.IsActive  = 1
    LEFT JOIN oe.CommissionLevels cl_ag ON ag.CommissionLevelId = cl_ag.CommissionLevelId AND cl_ag.IsActive = 1
    WHERE c.CommissionTierLevel_Snapshot IS NULL
       OR c.CommissionTierLevel_Snapshot_Label IS NULL
  ';
  EXEC sp_executesql @backfillSql;
  PRINT 'Backfilled CommissionTierLevel_Snapshot + CommissionTierLevel_Snapshot_Label on existing commission rows';
END
ELSE
BEGIN
  PRINT '[DryRun] Would backfill both snapshot columns from current CommissionLevels.DisplayName + legacy CommissionTierLevel';
  PRINT 'Set @DryRun = 0 to execute';
END;
