-- Widen oe.MessageHistory.Status CHECK constraint to include 'Deferred'.
-- The SendGrid webhook state machine (PR "feat/unified-message-history-status")
-- transitions Status: Sent -> Deferred on SendGrid 'deferred' events. Without this,
-- the UPDATE throws: "The UPDATE statement conflicted with the CHECK constraint".
--
-- Safe to run multiple times (drops any existing Status check, then re-adds the full set).
-- Apply to BOTH allaboard-testing and allaboard-prod before deploying backend.

SET NOCOUNT ON;

DECLARE @sql NVARCHAR(MAX);
DECLARE @name SYSNAME;

DECLARE c CURSOR LOCAL FAST_FORWARD FOR
  SELECT cc.name
  FROM sys.check_constraints cc
  WHERE cc.parent_object_id = OBJECT_ID(N'oe.MessageHistory')
    AND cc.definition LIKE N'%Status%';

OPEN c;
FETCH NEXT FROM c INTO @name;

WHILE @@FETCH_STATUS = 0
BEGIN
  SET @sql = N'ALTER TABLE oe.MessageHistory DROP CONSTRAINT ' + QUOTENAME(@name) + N';';
  EXEC sp_executesql @sql;
  FETCH NEXT FROM c INTO @name;
END;

CLOSE c;
DEALLOCATE c;

IF NOT EXISTS (
  SELECT 1
  FROM sys.check_constraints
  WHERE parent_object_id = OBJECT_ID(N'oe.MessageHistory')
    AND name = N'CK_MessageHistory_Status'
)
BEGIN
  ALTER TABLE oe.MessageHistory WITH CHECK ADD CONSTRAINT CK_MessageHistory_Status
  CHECK (
    Status IN (
      N'Sent',
      N'Sending',
      N'Deferred',
      N'Delivered',
      N'Opened',
      N'Clicked',
      N'Bounced',
      N'Failed'
    )
  );
END
