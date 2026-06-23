-- MessageQueue: priority (transactional before bulk) + support MessageType 'BulkBatch'.
-- Safe to re-run on oe.

IF COL_LENGTH('oe.MessageQueue', 'QueuePriority') IS NULL
BEGIN
    ALTER TABLE oe.MessageQueue
    ADD QueuePriority INT NOT NULL CONSTRAINT DF_MessageQueue_QueuePriority DEFAULT 0;
    -- Lower number = higher priority (processed first). Bulk blasts use 10.
END
GO

-- Extend MessageType CHECK to allow 'BulkBatch' (error: CK__MessageQu__Messa__... without BulkBatch).
-- One batch: drop old MessageType-only check (not our replacement), then add CK_MessageQueue_MessageType.
DECLARE @constraint sysname;
SELECT @constraint = cc.name
FROM sys.check_constraints cc
WHERE cc.parent_object_id = OBJECT_ID('oe.MessageQueue')
  AND cc.name <> N'CK_MessageQueue_MessageType'
  AND cc.definition LIKE N'%MessageType%'
  AND cc.definition NOT LIKE N'%BulkBatch%';

IF @constraint IS NOT NULL
BEGIN
    DECLARE @dropSql nvarchar(600) = N'ALTER TABLE oe.MessageQueue DROP CONSTRAINT ' + QUOTENAME(@constraint) + N';';
    EXEC sp_executesql @dropSql;
END

IF NOT EXISTS (
    SELECT 1 FROM sys.check_constraints
    WHERE parent_object_id = OBJECT_ID('oe.MessageQueue')
      AND name = N'CK_MessageQueue_MessageType'
)
BEGIN
    ALTER TABLE oe.MessageQueue WITH CHECK ADD CONSTRAINT CK_MessageQueue_MessageType
    CHECK (MessageType IN ('Email', 'SMS', 'Push', 'BulkBatch'));
END
GO
