/*
  Copy Resource Library (oe.TenantMarketingFolders + oe.TenantMarketingResources)
  from MightyWELL Health → Pinnacle Life Group.

  Prerequisites:
  - Tables from sql-changes/2026-04-03-tenant-marketing-folders-and-resources.sql
  - sql-changes/2026-04-15-tenant-marketing-folders-hide-from-agents.sql (HideFromAgents column)

  File-type resources reuse the same oe.FileUploads.FileId (same blob); links copy ExternalUrl as-is.

  Verify tenant GUIDs (run from repo root):

    cd ai_scripts && ./db-query.sh "SELECT TenantId, Name, Status FROM oe.Tenants WHERE Name IN (N'MightyWELL Health', N'Pinnacle Life Group')"
    cd ai_scripts && ./db-query.sh "SELECT TenantId, Name, Status FROM oe.Tenants WHERE Name IN (N'MightyWELL Health', N'Pinnacle Life Group')" --testing

  Verified 2026-04-17 — prod + allaboard-testing return:
    MightyWELL Health   1CD92AF7-B6F2-4E48-A8F3-EC6316158826
    Pinnacle Life Group 55EB7262-4DB6-4614-82A8-23FC2E91203B
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @SourceTenantId UNIQUEIDENTIFIER = '1CD92AF7-B6F2-4E48-A8F3-EC6316158826'; /* MightyWELL Health */
DECLARE @TargetTenantId UNIQUEIDENTIFIER = '55EB7262-4DB6-4614-82A8-23FC2E91203B'; /* Pinnacle Life Group */

DECLARE @VerifyTenantNames BIT = 1; /* 1 = abort if oe.Tenants.Name does not match expected labels */
DECLARE @ExpectedSourceName NVARCHAR(255) = N'MightyWELL Health';
DECLARE @ExpectedTargetName NVARCHAR(255) = N'Pinnacle Life Group';

DECLARE @ReplaceTargetLibrary BIT = 1; /* 1 = delete existing Pinnacle Resource Library rows first; 0 = abort if target has any rows */
DECLARE @DryRun BIT = 0;               /* 1 = only print counts; no changes */

IF COL_LENGTH('oe.TenantMarketingFolders', 'HideFromAgents') IS NULL
BEGIN
  RAISERROR(N'Column oe.TenantMarketingFolders.HideFromAgents is missing. Run sql-changes/2026-04-15-tenant-marketing-folders-hide-from-agents.sql first.', 16, 1);
  RETURN;
END;

IF @VerifyTenantNames = 1
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM oe.Tenants
    WHERE TenantId = @SourceTenantId AND Name = @ExpectedSourceName
  )
  BEGIN
    RAISERROR(N'Source tenant id does not match expected name. Fix @SourceTenantId / @ExpectedSourceName or set @VerifyTenantNames = 0.', 16, 1);
    RETURN;
  END;
  IF NOT EXISTS (
    SELECT 1 FROM oe.Tenants
    WHERE TenantId = @TargetTenantId AND Name = @ExpectedTargetName
  )
  BEGIN
    RAISERROR(N'Target tenant id does not match expected name. Fix @TargetTenantId / @ExpectedTargetName or set @VerifyTenantNames = 0.', 16, 1);
    RETURN;
  END;
END;

DECLARE @SrcFolders INT = (
  SELECT COUNT(*) FROM oe.TenantMarketingFolders
  WHERE OwnerTenantId = @SourceTenantId AND IsActive = 1
);
DECLARE @SrcResources INT = (
  SELECT COUNT(*) FROM oe.TenantMarketingResources r
  INNER JOIN oe.TenantMarketingFolders f ON f.FolderId = r.FolderId AND f.OwnerTenantId = @SourceTenantId AND f.IsActive = 1
  WHERE r.OwnerTenantId = @SourceTenantId AND r.IsActive = 1
);

DECLARE @TgtFolders INT = (
  SELECT COUNT(*) FROM oe.TenantMarketingFolders
  WHERE OwnerTenantId = @TargetTenantId AND IsActive = 1
);
DECLARE @TgtResources INT = (
  SELECT COUNT(*) FROM oe.TenantMarketingResources
  WHERE OwnerTenantId = @TargetTenantId AND IsActive = 1
);

PRINT CONCAT(N'Source (', @ExpectedSourceName, N'): active folders=', @SrcFolders, N', active resources=', @SrcResources);
PRINT CONCAT(N'Target (', @ExpectedTargetName, N'): active folders=', @TgtFolders, N', active resources=', @TgtResources);

IF @DryRun = 1
BEGIN
  PRINT N'Dry run only — no changes.';
  RETURN;
END;

IF @SrcFolders = 0
BEGIN
  PRINT N'Nothing to copy: source has no active folders.';
  RETURN;
END;

IF @TgtFolders > 0 OR @TgtResources > 0
BEGIN
  IF @ReplaceTargetLibrary = 0
  BEGIN
    RAISERROR(N'Target tenant already has Resource Library rows. Set @ReplaceTargetLibrary = 1 to remove them first, or clear manually.', 16, 1);
    RETURN;
  END;
END;

BEGIN TRANSACTION;

BEGIN TRY
  IF @TgtFolders > 0 OR @TgtResources > 0
  BEGIN
    DELETE r
    FROM oe.TenantMarketingResources r
    WHERE r.OwnerTenantId = @TargetTenantId;

    DELETE f
    FROM oe.TenantMarketingFolders f
    WHERE f.OwnerTenantId = @TargetTenantId;

    PRINT N'Removed existing target library rows: resources deleted (all), folders deleted (all) for target tenant.';
  END;

  IF OBJECT_ID('tempdb..#FolderMap') IS NOT NULL DROP TABLE #FolderMap;
  CREATE TABLE #FolderMap (
    OldFolderId UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
    NewFolderId UNIQUEIDENTIFIER NOT NULL,
    Name NVARCHAR(200) NOT NULL,
    Description NVARCHAR(1000) NULL,
    SortOrder INT NOT NULL,
    HideFromAgents BIT NOT NULL
  );

  INSERT INTO #FolderMap (OldFolderId, NewFolderId, Name, Description, SortOrder, HideFromAgents)
  SELECT
    f.FolderId,
    NEWID(),
    f.Name,
    f.Description,
    f.SortOrder,
    f.HideFromAgents
  FROM oe.TenantMarketingFolders f
  WHERE f.OwnerTenantId = @SourceTenantId AND f.IsActive = 1;

  INSERT INTO oe.TenantMarketingFolders (
    FolderId,
    OwnerTenantId,
    Name,
    Description,
    SortOrder,
    IsActive,
    HideFromAgents,
    CreatedBy,
    CreatedDate,
    ModifiedBy,
    ModifiedDate
  )
  SELECT
    m.NewFolderId,
    @TargetTenantId,
    m.Name,
    m.Description,
    m.SortOrder,
    1,
    m.HideFromAgents,
    NULL,
    SYSUTCDATETIME(),
    NULL,
    NULL
  FROM #FolderMap m;

  PRINT CONCAT(N'Inserted folders: ', @@ROWCOUNT);

  INSERT INTO oe.TenantMarketingResources (
    ResourceId,
    FolderId,
    OwnerTenantId,
    Title,
    Description,
    ResourceType,
    FileId,
    ExternalUrl,
    SortOrder,
    IsActive,
    CreatedBy,
    CreatedDate,
    ModifiedBy,
    ModifiedDate
  )
  SELECT
    NEWID(),
    m.NewFolderId,
    @TargetTenantId,
    r.Title,
    r.Description,
    r.ResourceType,
    r.FileId,
    r.ExternalUrl,
    r.SortOrder,
    1,
    NULL,
    SYSUTCDATETIME(),
    NULL,
    NULL
  FROM oe.TenantMarketingResources r
  INNER JOIN #FolderMap m ON m.OldFolderId = r.FolderId
  WHERE r.OwnerTenantId = @SourceTenantId AND r.IsActive = 1;

  PRINT CONCAT(N'Inserted resources: ', @@ROWCOUNT);

  COMMIT TRANSACTION;
  PRINT N'Done.';
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
