-- Extend oe.MessageHistory.Status CHECK so SendGrid flow can use Sending / Delivered (and related UI states).
-- Error without this: INSERT conflicted with CHECK CK__MessageHi__Statu__... column 'Status'.
-- Safe to run once per database (allaboard-testing / prod).

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
      N'Failed',
      N'Sending',
      N'Delivered',
      N'Bounced',
      N'Opened',
      N'Clicked'
    )
  );
END
GO
