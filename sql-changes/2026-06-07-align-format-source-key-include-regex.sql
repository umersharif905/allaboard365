/*
  Add oe.VendorImportFormatPresets.ImportRulesJson if missing, then set Align rules
  (planKey.sourceKeyIncludeRegex cleared — native inbound uses EE_1500 / 46521_* keys).

  Safe when ImportRulesJson column was never created (adds column first).
  Uses dynamic SQL so the batch compiles even before the column exists.

  Dry-run:
    cd OpenEnroll && DB_NAME=allaboard-prod ./ai_scripts/db-execute.sh sql-changes/2026-06-07-align-format-source-key-include-regex.sql
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DryRun BIT = 1;  -- SET TO 0 ONLY WITH EXPLICIT APPROVAL
DECLARE @SharewellVendorId UNIQUEIDENTIFIER = 'D2A84803-5A9B-4E97-98A5-BEE1A11BBDA6';

DECLARE @AlignShaRules NVARCHAR(MAX) = N'{
  "tobacco": { "columns": ["Tobacco Surcharge"], "yesValues": ["100"], "yesWhenNumericGreaterThan": 0 },
  "planKey": {
    "strategies": ["planCode", "composite", "tierUa"],
    "compositeFields": ["ABProductID,Product_ID", "ABBenefitIdOverride,Benefit_ID"],
    "compositeSeparator": "_",
    "tierFields": "PlanTier,Family Size Tier,Plan Tier,Coverage Tier",
    "tierPattern": "^(EE|ES|EC|EF|FM)$",
    "uaFields": "UA,Deductible IUA,Plan Base",
    "planCodeFields": "Plan Name,Product Name",
    "tierUaSuffixRegex": "(\\\\d{3,6})(EE|ES|EC|EF)$",
    "uaRelabel": [{ "from": "3000", "to": "2500" }, { "from": "6000", "to": "5000" }],
    "sourceKeyIncludeRegex": null
  },
  "productMapping": { "defaultProductNameContains": "Essential" }
}';

IF OBJECT_ID('oe.VendorImportFormatPresets', 'U') IS NULL
BEGIN
  RAISERROR('oe.VendorImportFormatPresets missing — run 2026-06-06-vendor-import-format-presets-schema.sql first (@DryRun = 0).', 16, 1);
  RETURN;
END;

DECLARE @HasRulesCol BIT = CASE
  WHEN COL_LENGTH('oe.VendorImportFormatPresets', 'ImportRulesJson') IS NOT NULL THEN 1
  ELSE 0
END;

IF @DryRun = 1
BEGIN
  PRINT 'DRY RUN — no changes written. Set @DryRun = 0 to apply.';

  IF @HasRulesCol = 0
    PRINT 'WOULD ADD column oe.VendorImportFormatPresets.ImportRulesJson';
  ELSE
    PRINT 'SKIP: ImportRulesJson column already exists';

  SELECT Slug, Label, SortOrder
  FROM oe.VendorImportFormatPresets
  WHERE VendorId = @SharewellVendorId
    AND Slug IN (N'sharewell_align', N'sharewell_align_sha')
  ORDER BY SortOrder;

  IF @HasRulesCol = 1
  BEGIN
    DECLARE @PreviewSql NVARCHAR(MAX) = N'
      SELECT Slug, Label, LEN(ImportRulesJson) AS RulesLen, ImportRulesJson
      FROM oe.VendorImportFormatPresets
      WHERE VendorId = @vid
        AND Slug IN (N''sharewell_align'', N''sharewell_align_sha'')
      ORDER BY SortOrder';
    EXEC sp_executesql @PreviewSql, N'@vid UNIQUEIDENTIFIER', @SharewellVendorId;
  END
  ELSE
    PRINT 'WOULD SET ImportRulesJson on sharewell_align + sharewell_align_sha (full Align rules JSON).';

  RETURN;
END;

BEGIN TRY
  BEGIN TRANSACTION;

  IF @HasRulesCol = 0
  BEGIN
    ALTER TABLE oe.VendorImportFormatPresets ADD ImportRulesJson NVARCHAR(MAX) NULL;
    PRINT 'Added ImportRulesJson column';
  END;

  DECLARE @UpdateSql NVARCHAR(MAX) = N'
    UPDATE oe.VendorImportFormatPresets
    SET ImportRulesJson = @rules, ModifiedUtc = SYSUTCDATETIME()
    WHERE VendorId = @vid
      AND Slug IN (N''sharewell_align'', N''sharewell_align_sha'')';

  EXEC sp_executesql
    @UpdateSql,
    N'@rules NVARCHAR(MAX), @vid UNIQUEIDENTIFIER',
    @AlignShaRules,
    @SharewellVendorId;

  DECLARE @ResultSql NVARCHAR(MAX) = N'
    SELECT Slug, Label, LEN(ImportRulesJson) AS RulesLen, ImportRulesJson
    FROM oe.VendorImportFormatPresets
    WHERE VendorId = @vid
      AND Slug IN (N''sharewell_align'', N''sharewell_align_sha'')
    ORDER BY SortOrder';

  EXEC sp_executesql @ResultSql, N'@vid UNIQUEIDENTIFIER', @SharewellVendorId;

  COMMIT TRANSACTION;
  PRINT 'Align import rules updated (sourceKeyIncludeRegex + tobacco + UA relabel).';
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  DECLARE @ErrMsg NVARCHAR(4000) = ERROR_MESSAGE();
  RAISERROR(@ErrMsg, 16, 1);
END CATCH;
