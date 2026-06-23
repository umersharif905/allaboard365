/*
  Native Align inbound resolves catalog keys (EE_1500, 46521_9376), not only 11321_AH*.
  sourceKeyIncludeRegex ^11321_AH hid every key from the product-mapping UI (0 of 0 mapped).

  Dry-run:
    cd OpenEnroll && DB_NAME=allaboard-prod ./ai_scripts/db-execute.sh sql-changes/2026-06-04-align-clear-source-key-include-regex.sql
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DryRun BIT = 1;
DECLARE @SharewellVendorId UNIQUEIDENTIFIER = 'D2A84803-5A9B-4E97-98A5-BEE1A11BBDA6';

IF @DryRun = 1
BEGIN
  PRINT 'DRY RUN — would clear planKey.sourceKeyIncludeRegex on sharewell_align + sharewell_align_sha';
  SELECT Slug, Label, ImportRulesJson
  FROM oe.VendorImportFormatPresets
  WHERE VendorId = @SharewellVendorId
    AND Slug IN (N'sharewell_align', N'sharewell_align_sha');
  RETURN;
END;

UPDATE oe.VendorImportFormatPresets
SET
  ImportRulesJson = JSON_MODIFY(ImportRulesJson, '$.planKey.sourceKeyIncludeRegex', NULL),
  ModifiedUtc = SYSUTCDATETIME()
WHERE VendorId = @SharewellVendorId
  AND Slug IN (N'sharewell_align', N'sharewell_align_sha')
  AND ImportRulesJson IS NOT NULL;

PRINT 'Cleared sourceKeyIncludeRegex on Align format presets.';
