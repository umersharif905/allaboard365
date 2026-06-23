-- Ensure oe.Users.PasswordHash can store bcrypt hashes (60 characters).
-- If the column is shorter (e.g. nvarchar(50)), hashes get truncated and login fails after set/reset password.
-- Run once; safe to re-run.

IF EXISTS (SELECT 1 FROM sys.columns c
           JOIN sys.tables t ON c.object_id = t.object_id
           JOIN sys.schemas s ON t.schema_id = s.schema_id
           WHERE s.name = N'oe' AND t.name = N'Users' AND c.name = N'PasswordHash')
BEGIN
  DECLARE @sql nvarchar(500);
  SELECT @sql = N'ALTER TABLE oe.Users ALTER COLUMN PasswordHash nvarchar(255) NULL';
  EXEC sp_executesql @sql;
  PRINT 'oe.Users.PasswordHash set to nvarchar(255).';
END
ELSE
  PRINT 'oe.Users.PasswordHash not found; table may use different schema/name.';
