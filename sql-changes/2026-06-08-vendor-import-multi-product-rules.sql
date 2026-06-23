/*
  Multi-product ImportRulesJson (products[] + rowGrain) for ShareWELL SFTP formats.
  Align / Align SHA / MPowering Benefits. Calstar/Summit skipped per request.

  Dry-run:
    cd OpenEnroll && DB_NAME=allaboard-prod ./ai_scripts/db-execute.sh sql-changes/2026-06-08-vendor-import-multi-product-rules.sql
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DryRun BIT = 1;
DECLARE @SharewellVendorId UNIQUEIDENTIFIER = 'D2A84803-5A9B-4E97-98A5-BEE1A11BBDA6';
DECLARE @EssentialProductId UNIQUEIDENTIFIER = 'F165AF93-8268-448D-9DD6-F02FB338EEAE';
DECLARE @MpbProductId UNIQUEIDENTIFIER = '941C7833-D3D7-4411-8407-B43F2A42F2D1';

DECLARE @AlignRules NVARCHAR(MAX) = N'{
  "rowGrain": "perProduct",
  "products": [{
    "id": "align-essential",
    "label": "Essential (Align native)",
    "targetProductId": "F165AF93-8268-448D-9DD6-F02FB338EEAE",
    "match": { "mode": "always" },
    "keyStrategy": {
      "type": "composite",
      "strategies": ["planCode", "composite", "tierUa"],
      "compositeFields": ["ABProductID,Product_ID", "ABBenefitIdOverride,Benefit_ID"],
      "compositeSeparator": "_",
      "tierFields": "PlanTier,Family Size Tier,Plan Tier,Coverage Tier",
      "tierPattern": "^(EE|ES|EC|EF|FM)$",
      "uaFields": "UA,Deductible IUA,Plan Base",
      "planCodeFields": "Plan Name,Product Name",
      "tierUaSuffixRegex": "(\\\\d{3,6})(EE|ES|EC|EF)$",
      "uaRelabel": [{ "from": "3000", "to": "2500" }, { "from": "6000", "to": "5000" }]
    }
  }],
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
  "productMapping": { "defaultProductNameContains": "Essential", "assumedProductId": "F165AF93-8268-448D-9DD6-F02FB338EEAE" }
}';

DECLARE @MpbRules NVARCHAR(MAX) = N'{
  "rowGrain": "perPrimary",
  "products": [{
    "id": "mpb-main",
    "label": "MPowering Benefits",
    "targetProductId": "941C7833-D3D7-4411-8407-B43F2A42F2D1",
    "match": { "mode": "always" },
    "keyStrategy": {
      "type": "planCode",
      "strategies": ["planCode", "tierUa"],
      "tierFields": "Plan_Tier,Plan Tier,Family Size Tier",
      "tierPattern": "^(EE|ES|EC|EF)$",
      "uaFields": "UA",
      "planCodeFields": "Plan Name,Product Name",
      "tierUaSuffixRegex": "(\\\\d{3,6})(EE|ES|EC|EF)$",
      "uaRelabel": []
    }
  }],
  "tobacco": { "columns": ["Tobacco_Surcharge"], "yesValues": ["Yes"], "yesWhenNumericGreaterThan": 0 },
  "planKey": {
    "strategies": ["planCode", "tierUa"],
    "tierFields": "Plan_Tier,Plan Tier,Family Size Tier",
    "uaFields": "UA",
    "planCodeFields": "Plan Name,Product Name",
    "tierUaSuffixRegex": "(\\\\d{3,6})(EE|ES|EC|EF)$",
    "uaRelabel": []
  },
  "productMapping": {
    "defaultProductNameContains": "Essential (Sharewell) - 2025",
    "assumedProductId": "941C7833-D3D7-4411-8407-B43F2A42F2D1"
  },
  "householdMemberId": {
    "suffixStripPatterns": ["^(\\\\d+)(D\\\\d+)$", "^(MPB\\\\d+)([A-Z])$"]
  }
}';

BEGIN TRY
  BEGIN TRANSACTION;

  IF COL_LENGTH('oe.VendorImportFormatPresets', 'ImportRulesJson') IS NULL
  BEGIN
    PRINT 'SKIP: ImportRulesJson column missing — run 2026-06-06-vendor-import-format-import-rules.sql first';
    ROLLBACK TRANSACTION;
    RETURN;
  END;

  IF @DryRun = 1
  BEGIN
    PRINT 'DRY RUN — would set multi-product ImportRulesJson:';
    SELECT Slug, Label, LEN(ImportRulesJson) AS CurrentRulesLen
    FROM oe.VendorImportFormatPresets
    WHERE VendorId = @SharewellVendorId
      AND Slug IN (N'sharewell_align', N'sharewell_align_sha', N'sharewell_mpb');
    ROLLBACK TRANSACTION;
    RETURN;
  END;

  UPDATE oe.VendorImportFormatPresets
  SET ImportRulesJson = @AlignRules, ModifiedUtc = SYSUTCDATETIME()
  WHERE VendorId = @SharewellVendorId AND Slug IN (N'sharewell_align', N'sharewell_align_sha');

  UPDATE oe.VendorImportFormatPresets
  SET ImportRulesJson = @MpbRules, ModifiedUtc = SYSUTCDATETIME()
  WHERE VendorId = @SharewellVendorId AND Slug = N'sharewell_mpb';

  PRINT 'Updated multi-product import rules for align + mpb presets';

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
