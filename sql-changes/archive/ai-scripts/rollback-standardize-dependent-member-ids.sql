/*
Rollback script for:
  ai_scripts/dry-run-standardize-dependent-member-ids.sql

Restores members.member_id (and misc when it was synced) from backup rows
for a specific @RunId.

IMPORTANT:
- Keep @DryRun = 1 first to preview.
- Set @DryRun = 0 only when ready to restore.
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @RunId UNIQUEIDENTIFIER = '00000000-0000-0000-0000-000000000000'; -- REQUIRED
DECLARE @DryRun BIT = 1; -- 1 = preview only, 0 = apply rollback

IF @RunId = '00000000-0000-0000-0000-000000000000'
BEGIN
    RAISERROR('Set @RunId to the run_id you want to rollback.', 16, 1);
    RETURN;
END;

IF OBJECT_ID('dbo.backup_members_standardize_dependent_member_ids', 'U') IS NULL
BEGIN
    RAISERROR('Backup table dbo.backup_members_standardize_dependent_member_ids not found.', 16, 1);
    RETURN;
END;

IF OBJECT_ID('tempdb..#RollbackTargets') IS NOT NULL DROP TABLE #RollbackTargets;

SELECT
    b.MemberRowId,
    b.MemberId_Old,
    b.MemberId_New,
    b.Misc
INTO #RollbackTargets
FROM dbo.backup_members_standardize_dependent_member_ids b
WHERE b.RunId = @RunId;

SELECT
    @RunId AS run_id,
    COUNT(*) AS candidate_rows
FROM #RollbackTargets;

SELECT TOP 200
    t.MemberRowId,
    t.MemberId_New AS current_expected_member_id,
    t.MemberId_Old AS rollback_member_id,
    m.member_id AS current_actual_member_id
FROM #RollbackTargets t
JOIN dbo.members m
  ON m.id = t.MemberRowId
ORDER BY t.MemberRowId;

IF @DryRun = 1
BEGIN
    PRINT 'DRY RUN complete. No rollback applied.';
    RETURN;
END;

BEGIN TRANSACTION;

BEGIN TRY
    UPDATE m
    SET
        m.member_id = t.MemberId_Old,
        m.misc = CASE
                    WHEN m.misc = t.MemberId_New THEN t.MemberId_Old
                    ELSE m.misc
                 END
    FROM dbo.members m
    JOIN #RollbackTargets t
      ON t.MemberRowId = m.id;

    COMMIT TRANSACTION;

    SELECT
        @RunId AS run_id,
        COUNT(*) AS rows_rolled_back
    FROM #RollbackTargets;

    PRINT 'Rollback complete.';
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0
        ROLLBACK TRANSACTION;

    DECLARE @Err NVARCHAR(4000) = ERROR_MESSAGE();
    DECLARE @ErrLine INT = ERROR_LINE();
    DECLARE @ErrNo INT = ERROR_NUMBER();
    PRINT 'FAILED at line ' + CAST(@ErrLine AS NVARCHAR(20)) + ' (error ' + CAST(@ErrNo AS NVARCHAR(20)) + '): ' + @Err;
    THROW;
END CATCH;

