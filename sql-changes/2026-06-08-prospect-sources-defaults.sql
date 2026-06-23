/* 2026-06-08-prospect-sources-defaults.sql
   Adds oe.ProspectSources.IsDefault (per-agent default source flag) and
   oe.ProspectSources.Color (display color label). DRY-RUN by default:
   set @DryRun = 0 to apply. */
SET NOCOUNT ON;
DECLARE @DryRun BIT = 1;   -- <<< set to 0 to actually apply

IF @DryRun = 1
BEGIN
  PRINT 'DRY RUN. Would add oe.ProspectSources.IsDefault and oe.ProspectSources.Color.';
  SELECT
    (SELECT COUNT(*) FROM sys.columns WHERE object_id = OBJECT_ID('oe.ProspectSources') AND name = 'IsDefault') AS IsDefaultExists,
    (SELECT COUNT(*) FROM sys.columns WHERE object_id = OBJECT_ID('oe.ProspectSources') AND name = 'Color') AS ColorExists;
  RETURN;
END

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('oe.ProspectSources') AND name = 'IsDefault')
BEGIN
  ALTER TABLE oe.ProspectSources ADD IsDefault BIT NOT NULL CONSTRAINT DF_ProspectSources_IsDefault DEFAULT 0;
END

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('oe.ProspectSources') AND name = 'Color')
BEGIN
  ALTER TABLE oe.ProspectSources ADD Color NVARCHAR(20) NULL;
END
PRINT 'Applied.';
