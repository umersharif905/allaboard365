/*
  Patch ShareWELL import presets: Align SHA format + Plan Name on sharewell_align.

  Run dry-run:
    cd OpenEnroll && DB_NAME=allaboard-prod ./ai_scripts/db-execute.sh sql-changes/2026-06-04-vendor-import-align-format-plan-name-patch.sql
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DryRun BIT = 1;
DECLARE @SharewellVendorId UNIQUEIDENTIFIER = 'D2A84803-5A9B-4E97-98A5-BEE1A11BBDA6';

DECLARE @AlignTemplate NVARCHAR(MAX) =
  N'{MemberIDBase:Member ID},{Relationship:Relationship},{FirstName:First Name},{MiddleInitial:Middle Name},{LastName:Last Name},{DOB:Date of Birth},{Gender:Gender},{Phone1:Primary Phone},{Phone2:Alternate Phone},{Email:Email Address},{AddressLine1:Mail Address 1},{AddressLine2:Mail Address 2},{City:Mail City},{State:Mail State},{ZipCode:Mail Zip},{EffectiveDate:Plan Start},{TerminateDate:Terminate Date},{PlanTier:Coverage Tier},{UA:Deductible IUA},{PlanPrice:Plan Base},{TobaccoSurcharge:Tobacco Surcharge},{ABProductID:Product_ID},{ABBenefitIdOverride:Benefit_ID},{PlanName:Plan Name},{PlanTier:Plan Tier}';

DECLARE @AlignShaTemplate NVARCHAR(MAX) =
  N'{IntegrationPartner:Integration Partner},{BillType:Bill Type},{Relationship:Relationship},{FirstName:First Name},{LastName:Last Name},{MiddleInitial:Middle Name},{Phone1:Phone1},{Phone2:Phone2},{Email:Email},{Address1:Address1},{Address2:Address2},{City:City},{State:State},{ZipCode:Zip},{DOB:DoB},{Gender:Gender},{PlanName:Plan Name},{PlanTier:Plan Tier},{EffectiveDate:Effective Date},{TerminateDate:Terminate Date},{PlanPrice:Plan Price},{UA:UA},{TobaccoSurcharge:Tobacco Surcharge},{MemberIDBase:Member ID}';

BEGIN TRY
  BEGIN TRANSACTION;

  IF OBJECT_ID('oe.VendorImportFormatPresets', 'U') IS NULL
  BEGIN
    RAISERROR('oe.VendorImportFormatPresets missing — run 2026-06-06-vendor-import-format-presets-schema.sql first.', 16, 1);
  END;

  IF @DryRun = 1
  BEGIN
    PRINT 'DRY RUN — set @DryRun = 0 to apply.';
    SELECT Slug, Label, LEN(RowTemplate) AS TemplateLen
    FROM oe.VendorImportFormatPresets
    WHERE VendorId = @SharewellVendorId AND Slug IN (N'sharewell_align', N'sharewell_align_sha');
    SELECT N'WOULD UPDATE sharewell_align' AS Action, LEN(@AlignTemplate) AS NewLen;
    SELECT N'WOULD MERGE sharewell_align_sha' AS Action, LEN(@AlignShaTemplate) AS NewLen;
    ROLLBACK TRANSACTION;
    RETURN;
  END;

  UPDATE oe.VendorImportFormatPresets
  SET
    Label = N'Align Health (native + SHA plan codes)',
    RowTemplate = @AlignTemplate,
    ModifiedUtc = SYSUTCDATETIME()
  WHERE VendorId = @SharewellVendorId AND Slug = N'sharewell_align';

  MERGE oe.VendorImportFormatPresets AS t
  USING (
    SELECT @SharewellVendorId AS VendorId, N'sharewell_align_sha' AS Slug,
      N'Align Health SHA (ShareWELL 24-col)' AS Label, @AlignShaTemplate AS RowTemplate, 25 AS SortOrder
  ) AS s
  ON t.VendorId = s.VendorId AND t.Slug = s.Slug
  WHEN MATCHED THEN
    UPDATE SET Label = s.Label, RowTemplate = s.RowTemplate, SortOrder = s.SortOrder, IsActive = 1, ModifiedUtc = SYSUTCDATETIME()
  WHEN NOT MATCHED THEN
    INSERT (VendorId, Slug, Label, RowTemplate, SortOrder)
    VALUES (s.VendorId, s.Slug, s.Label, s.RowTemplate, s.SortOrder);

  COMMIT TRANSACTION;
  PRINT 'Align format presets patched.';
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  RAISERROR(ERROR_MESSAGE(), 16, 1);
END CATCH;
