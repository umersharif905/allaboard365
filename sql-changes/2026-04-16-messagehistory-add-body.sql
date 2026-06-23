-- sql-changes/2026-04-16-messagehistory-add-body.sql
-- Additive, NULL-default columns to capture the rendered body + From address at send time.

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('oe.MessageHistory') AND name = 'Body')
BEGIN
  ALTER TABLE oe.MessageHistory ADD Body NVARCHAR(MAX) NULL;
END

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('oe.MessageHistory') AND name = 'FromAddress')
BEGIN
  ALTER TABLE oe.MessageHistory ADD FromAddress NVARCHAR(320) NULL;
END
