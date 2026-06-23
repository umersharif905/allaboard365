/*
  Per-format import rules JSON (tobacco column, UA relabel, plan key regex, auto-map hints).
  Data-only config — no Align/Mightywell logic in application code.

  Run dry-run:
    cd OpenEnroll && DB_NAME=allaboard-prod ./ai_scripts/db-execute.sh sql-changes/2026-06-06-vendor-import-format-import-rules.sql
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DryRun BIT = 1;
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

DECLARE @AlignNativeRules NVARCHAR(MAX) = @AlignShaRules;

DECLARE @SharewellDefaultRules NVARCHAR(MAX) = N'{
  "tobacco": { "columns": ["Tobacco Surcharge"], "yesWhenNumericGreaterThan": 0 },
  "planKey": { "tierUaSuffixRegex": "(\\\\d{3,6})(EE|ES|EC|EF)$", "uaRelabel": [] }
}';

BEGIN TRY
  BEGIN TRANSACTION;

  IF COL_LENGTH('oe.VendorImportFormatPresets', 'ImportRulesJson') IS NULL
  BEGIN
    IF @DryRun = 1
    BEGIN
      PRINT 'DRY RUN — would add oe.VendorImportFormatPresets.ImportRulesJson';
      ROLLBACK TRANSACTION;
      RETURN;
    END;
    ALTER TABLE oe.VendorImportFormatPresets ADD ImportRulesJson NVARCHAR(MAX) NULL;
    PRINT 'Added ImportRulesJson column';
  END
  ELSE
    PRINT 'SKIP: ImportRulesJson already exists';

  IF @DryRun = 1
  BEGIN
    PRINT 'DRY RUN — would update import rules on presets:';
    SELECT Slug, Label, LEN(ImportRulesJson) AS RulesLen
    FROM oe.VendorImportFormatPresets
    WHERE VendorId = @SharewellVendorId AND Slug IN (
      N'sharewell_default', N'sharewell_align', N'sharewell_align_sha', N'sharewell_calstar', N'sharewell_mpb'
    );
    ROLLBACK TRANSACTION;
    RETURN;
  END;

  UPDATE oe.VendorImportFormatPresets
  SET ImportRulesJson = @SharewellDefaultRules, ModifiedUtc = SYSUTCDATETIME()
  WHERE VendorId = @SharewellVendorId AND Slug = N'sharewell_default';

  UPDATE oe.VendorImportFormatPresets
  SET ImportRulesJson = @AlignShaRules, ModifiedUtc = SYSUTCDATETIME()
  WHERE VendorId = @SharewellVendorId AND Slug IN (N'sharewell_align', N'sharewell_align_sha');

  MERGE oe.VendorImportFormatPresets AS t
  USING (
    SELECT @SharewellVendorId AS VendorId, N'sharewell_align_sha' AS Slug,
      N'Align Health SHA (ShareWELL 24-col)' AS Label,
      @AlignShaRules AS ImportRulesJson
  ) AS s
  ON t.VendorId = s.VendorId AND t.Slug = s.Slug
  WHEN MATCHED THEN
    UPDATE SET ImportRulesJson = s.ImportRulesJson, ModifiedUtc = SYSUTCDATETIME()
  WHEN NOT MATCHED BY TARGET THEN
    INSERT (VendorId, Slug, Label, RowTemplate, SortOrder, ImportRulesJson)
    VALUES (
      s.VendorId,
      s.Slug,
      s.Label,
      (SELECT TOP 1 RowTemplate FROM oe.VendorImportFormatPresets WHERE VendorId = @SharewellVendorId AND Slug = N'sharewell_default'),
      25,
      s.ImportRulesJson
    );

  SELECT Slug, Label, LEN(ImportRulesJson) AS RulesLen
  FROM oe.VendorImportFormatPresets
  WHERE VendorId = @SharewellVendorId
  ORDER BY SortOrder;

  COMMIT TRANSACTION;
  PRINT 'Import rules seeded on format presets.';

END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  DECLARE @ErrMsg NVARCHAR(4000) = ERROR_MESSAGE();
  RAISERROR(@ErrMsg, 16, 1);
END CATCH;
