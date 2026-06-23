-- Unstick E123 migration batch (Joseph McGuinness / SW0530092).
-- Run in Azure SQL / SSMS against allaboard-prod.
-- The APP cannot clear this if another session holds the row lock — this script runs
-- in a separate connection and can UPDATE immediately (or shows who to KILL first).

DECLARE @BatchId UNIQUEIDENTIFIER = '7BE7B521-CC9B-49B7-BB20-2915E3827BD8';
DECLARE @HouseholdMemberId NVARCHAR(32) = N'SW0530092';

-- STEP A: Who is blocking MigrationImportBatch / household rows?
SELECT
  tl.request_session_id AS session_id,
  s.login_name,
  s.host_name,
  s.program_name,
  tl.resource_type,
  tl.request_mode,
  tl.request_status,
  r.blocking_session_id,
  r.wait_type,
  r.wait_time / 1000.0 AS wait_sec
FROM sys.dm_tran_locks tl
LEFT JOIN sys.dm_exec_sessions s ON s.session_id = tl.request_session_id
LEFT JOIN sys.dm_exec_requests r ON r.session_id = tl.request_session_id
WHERE tl.resource_associated_entity_id IN (
  OBJECT_ID('oe.MigrationImportBatch'),
  OBJECT_ID('oe.MigrationImportBatchHousehold')
)
AND tl.request_session_id <> @@SPID
ORDER BY tl.request_session_id;

-- If STEP A shows a sleeping session from an old backend/node, kill it (replace 123):
-- KILL 123;

-- STEP B: Reset batch (run after KILL if STEP A showed blockers, or run directly if empty)
UPDATE oe.MigrationImportBatch
SET Status = N'ready',
    ApplyProcessed = 0,
    ApplyTotal = 0,
    ApplyCreateCount = 0,
    ApplySkipCount = 0,
    ApplyErrorCount = 0,
    ModifiedUtc = SYSUTCDATETIME()
WHERE BatchId = @BatchId;

-- STEP C: McGuinness already pending migration — uncheck from apply selection
UPDATE oe.MigrationImportBatchHousehold
SET IncludedInImport = 0,
    PreviewAction = N'imported',
    PreviewMessage = N'Already imported — pending migration'
WHERE BatchId = @BatchId
  AND HouseholdMemberID = @HouseholdMemberId;

-- STEP D: Verify
SELECT BatchId, Status, ApplyProcessed, ApplyTotal, ApplyErrorCount, ModifiedUtc
FROM oe.MigrationImportBatch
WHERE BatchId = @BatchId;

SELECT BatchHouseholdId, HouseholdMemberID, IncludedInImport, PreviewAction, PreviewMessage, Applied
FROM oe.MigrationImportBatchHousehold
WHERE BatchId = @BatchId;

-- Then: restart local backend, refresh wizard. No further apply needed for McGuinness.
