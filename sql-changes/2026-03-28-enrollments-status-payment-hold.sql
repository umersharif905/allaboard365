-- PaymentHold: pre-activation enrollment rows (PM-first / deferred charge path).
-- No CHECK constraint on oe.Enrollments.Status in typical deployments; app enforces values.

IF EXISTS (
  SELECT 1 FROM sys.columns c
  INNER JOIN sys.tables t ON c.object_id = t.object_id
  INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
  WHERE s.name = 'oe' AND t.name = 'Enrollments' AND c.name = 'Status'
)
BEGIN
  -- Optional backfill if legacy Hold was ever written
  IF EXISTS (SELECT 1 FROM oe.Enrollments WHERE Status = N'Hold')
  BEGIN
    UPDATE oe.Enrollments
    SET Status = N'PaymentHold', ModifiedDate = SYSUTCDATETIME()
    WHERE Status = N'Hold';
  END
END
GO
