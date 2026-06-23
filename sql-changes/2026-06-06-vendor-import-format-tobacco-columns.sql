/*
  Tobacco detection columns on oe.VendorImportFormatPresets.

  @DryRun = 1  preview only
  @DryRun = 0  add columns + seed ShareWELL presets

  ./ai_scripts/db-execute.sh sql-changes/2026-06-06-vendor-import-format-tobacco-columns.sql
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DryRun BIT = 1;
DECLARE @SharewellVendorId UNIQUEIDENTIFIER = 'D2A84803-5A9B-4E97-98A5-BEE1A11BBDA6';

BEGIN TRY
  BEGIN TRANSACTION;

  /* --- 1) Add columns if missing --- */
  IF COL_LENGTH('oe.VendorImportFormatPresets', 'TobaccoCsvColumn') IS NULL
  BEGIN
    IF @DryRun = 1
    BEGIN
      PRINT 'DRY RUN — would add TobaccoCsvColumn, TobaccoYesValues';
      SELECT Slug, Label, SortOrder
      FROM oe.VendorImportFormatPresets
      WHERE VendorId = @SharewellVendorId
      ORDER BY SortOrder;
    END
    ELSE
    BEGIN
      ALTER TABLE oe.VendorImportFormatPresets ADD TobaccoCsvColumn NVARCHAR(200) NULL;
      ALTER TABLE oe.VendorImportFormatPresets ADD TobaccoYesValues NVARCHAR(500) NULL;
      PRINT 'Added TobaccoCsvColumn, TobaccoYesValues';
    END
  END
  ELSE
    PRINT 'SKIP: tobacco columns already exist';

  /* --- 2) Seed (dynamic SQL — compiles even when columns absent during dry-run) --- */
  IF COL_LENGTH('oe.VendorImportFormatPresets', 'TobaccoCsvColumn') IS NOT NULL
  BEGIN
    IF @DryRun = 1
    BEGIN
      PRINT 'DRY RUN — would seed tobacco values:';
      EXEC sp_executesql N'
        SELECT Slug, Label, TobaccoCsvColumn, TobaccoYesValues
        FROM oe.VendorImportFormatPresets
        WHERE VendorId = @vendorId
        ORDER BY SortOrder',
        N'@vendorId UNIQUEIDENTIFIER',
        @vendorId = @SharewellVendorId;
    END
    ELSE
    BEGIN
      EXEC sp_executesql N'
        UPDATE oe.VendorImportFormatPresets
        SET TobaccoCsvColumn = N''Tobacco Surcharge'',
            TobaccoYesValues = N''100'',
            ModifiedUtc = SYSUTCDATETIME()
        WHERE VendorId = @vendorId
          AND Slug IN (
            N''sharewell_default'', N''sharewell_align'', N''sharewell_align_sha'', N''sharewell_mpb''
          )',
        N'@vendorId UNIQUEIDENTIFIER',
        @vendorId = @SharewellVendorId;

      IF COL_LENGTH('oe.VendorImportFormatPresets', 'ImportRulesJson') IS NOT NULL
      BEGIN
        EXEC sp_executesql N'
          UPDATE oe.VendorImportFormatPresets
          SET TobaccoCsvColumn = COALESCE(TobaccoCsvColumn, N''Tobacco Surcharge''),
              TobaccoYesValues = COALESCE(TobaccoYesValues, N''100''),
              ModifiedUtc = SYSUTCDATETIME()
          WHERE VendorId = @vendorId
            AND Slug IN (N''sharewell_align'', N''sharewell_align_sha'')
            AND ImportRulesJson IS NOT NULL
            AND ImportRulesJson LIKE N''%"yesValues":["100"]%''',
          N'@vendorId UNIQUEIDENTIFIER',
          @vendorId = @SharewellVendorId;
      END

      EXEC sp_executesql N'
        SELECT Slug, Label, TobaccoCsvColumn, TobaccoYesValues
        FROM oe.VendorImportFormatPresets
        WHERE VendorId = @vendorId
        ORDER BY SortOrder',
        N'@vendorId UNIQUEIDENTIFIER',
        @vendorId = @SharewellVendorId;

      PRINT 'Tobacco columns seeded.';
    END
  END
  ELSE IF @DryRun = 1
    PRINT 'DRY RUN complete. Set @DryRun = 0 and re-run to add columns and seed.';

  IF @DryRun = 1
    ROLLBACK TRANSACTION;
  ELSE
    COMMIT TRANSACTION;

END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  DECLARE @ErrMsg NVARCHAR(4000) = ERROR_MESSAGE();
  RAISERROR(@ErrMsg, 16, 1);
END CATCH;
