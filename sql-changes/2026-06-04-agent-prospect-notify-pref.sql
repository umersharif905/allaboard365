/*
  Migration: add oe.Agents.NotifyNewProspectEmail (BIT NULL)
  Date:      2026-06-04
  Purpose:   Per-agent opt-out for the centralized "new prospect" notification email.
             Semantics: NULL / 1 = notifications ON (default), 0 = OFF.

  ============================================================================
  RUN MANUALLY BY A DBA — NOT EXECUTED BY AUTOMATION.
  ----------------------------------------------------------------------------
  This script defaults to a DRY-RUN (@DryRun = 1): it only inspects and PRINTs
  what WOULD change and performs NO writes.

  To apply the change for real:
    1. Review the dry-run output below.
    2. Set @DryRun = 0.
    3. Re-run in the target database.

  The ALTER is guarded by IF NOT EXISTS so the script is idempotent / safe to
  re-run; it will only add the column when it is genuinely missing.
  ============================================================================
*/

SET NOCOUNT ON;

DECLARE @DryRun BIT = 1;   -- 1 = preview only (no writes). Set to 0 to apply.

DECLARE @ColumnExists BIT =
  CASE WHEN EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('oe.Agents') AND name = 'NotifyNewProspectEmail'
  ) THEN 1 ELSE 0 END;

IF @ColumnExists = 1
BEGIN
  PRINT 'No change: oe.Agents.NotifyNewProspectEmail already exists.';
END
ELSE IF @DryRun = 1
BEGIN
  PRINT '[DRY-RUN] Would execute:';
  PRINT '  ALTER TABLE oe.Agents ADD NotifyNewProspectEmail BIT NULL;';
  PRINT '[DRY-RUN] No changes were made. Set @DryRun = 0 to apply.';
END
ELSE
BEGIN
  ALTER TABLE oe.Agents
    ADD NotifyNewProspectEmail BIT NULL;
  PRINT 'Added oe.Agents.NotifyNewProspectEmail (BIT NULL).';
END
GO
