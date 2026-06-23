/*
  UNDO production align — Run whole script after replacing @RollbackBatch.

  Get the GUID from:
    - The production script’s last result grid (column rollback_batch_id), OR
    - SELECT TOP 1 batch_id FROM dbo.members_member_id_email_align_backup ORDER BY backup_id DESC;
*/
SET XACT_ABORT ON;

DECLARE @RollbackBatch UNIQUEIDENTIFIER = 'PASTE-YOUR-rollback_batch_id-HERE';

BEGIN TRANSACTION;

UPDATE m
SET m.member_id = b.member_id_before
FROM dbo.members m
INNER JOIN dbo.members_member_id_email_align_backup b
    ON b.member_row_id = m.id
   AND b.batch_id = @RollbackBatch;

DECLARE @Restored INT = @@ROWCOUNT;

COMMIT TRANSACTION;

SELECT
    @Restored AS rows_restored,
    CASE WHEN @Restored = 0
        THEN N'No rows matched this batch_id — wrong GUID, or members already reverted / IDs changed.'
        ELSE N'Rollback applied from backup.'
    END AS outcome_message;
