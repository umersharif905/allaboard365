/*
  Fix over-escaped householdMemberId regex in sharewell_mpb ImportRulesJson.
  Stored patterns were ^(\\d+) instead of ^(\d+) — dependents would not group.

  Dry-run: DB_NAME=allaboard-prod ./ai_scripts/db-execute.sh sql-changes/2026-06-09-vendor-import-mpb-suffix-regex-fix.sql
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DryRun BIT = 1;
DECLARE @SharewellVendorId UNIQUEIDENTIFIER = 'D2A84803-5A9B-4E97-98A5-BEE1A11BBDA6';

DECLARE @FixedRules NVARCHAR(MAX) = N'{
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
      "tierUaSuffixRegex": "(\\d{3,6})(EE|ES|EC|EF)$",
      "uaRelabel": []
    }
  }],
  "tobacco": { "columns": ["Tobacco_Surcharge"], "yesValues": ["Yes"], "yesWhenNumericGreaterThan": 0 },
  "planKey": {
    "strategies": ["planCode", "tierUa"],
    "tierFields": "Plan_Tier,Plan Tier,Family Size Tier",
    "uaFields": "UA",
    "planCodeFields": "Plan Name,Product Name",
    "tierUaSuffixRegex": "(\\d{3,6})(EE|ES|EC|EF)$",
    "uaRelabel": []
  },
  "productMapping": {
    "defaultProductNameContains": "Essential (Sharewell) - 2025",
    "assumedProductId": "941C7833-D3D7-4411-8407-B43F2A42F2D1"
  },
  "householdMemberId": {
    "suffixStripPatterns": ["^(\\d+)(D\\d+)$", "^(MPB\\d+)([A-Z])$"]
  }
}';

BEGIN TRY
  BEGIN TRANSACTION;

  IF @DryRun = 1
  BEGIN
    PRINT 'DRY RUN — current patterns snippet:';
    SELECT
      Slug,
      SUBSTRING(ImportRulesJson, CHARINDEX('suffixStripPatterns', ImportRulesJson), 80) AS PatternsSnippet
    FROM oe.VendorImportFormatPresets
    WHERE VendorId = @SharewellVendorId AND Slug = N'sharewell_mpb';

    PRINT 'DRY RUN — would set corrected suffixStripPatterns:';
    SELECT JSON_VALUE(@FixedRules, '$.householdMemberId.suffixStripPatterns[0]') AS Pattern1,
           JSON_VALUE(@FixedRules, '$.householdMemberId.suffixStripPatterns[1]') AS Pattern2;
    ROLLBACK TRANSACTION;
    RETURN;
  END;

  UPDATE oe.VendorImportFormatPresets
  SET ImportRulesJson = @FixedRules, ModifiedUtc = SYSUTCDATETIME()
  WHERE VendorId = @SharewellVendorId AND Slug = N'sharewell_mpb';

  PRINT 'sharewell_mpb suffix regex patterns corrected.';
  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
