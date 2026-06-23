/*
  Full ShareWELL eligibility exports (35 col) need Subscribe ID + Product_ID/Benefit_ID on
  sharewell_align_sha preset — not the LB 24-col template.

  Run dry-run:
    cd OpenEnroll && DB_NAME=allaboard-prod ./ai_scripts/db-execute.sh sql-changes/2026-06-05-sharewell-full-eligibility-format-template.sql
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DryRun BIT = 1;
DECLARE @SharewellVendorId UNIQUEIDENTIFIER = 'D2A84803-5A9B-4E97-98A5-BEE1A11BBDA6';

DECLARE @FullTemplate NVARCHAR(MAX) =
  N'{IntegrationPartner:Integration Partner},{BillType:List Bill},{Relationship:Relationship},{PrimarySSN:Subscribe ID},{MemberIDBase:Member ID},' +
  N'{FirstName:First Name},{LastName:Last Name},{MiddleInitial:Middle Name},{Phone1:Primary Phone},{Phone2:Alternate Phone},{Email:Email Address},' +
  N'{AddressLine1:Mail Address 1},{AddressLine2:Mail Address 2},{City:Mail City},{State:Mail State},{ZipCode:Mail Zip},{DOB:Date of Birth},{Gender:Gender},' +
  N'{PlanName:Plan Name},{PlanTier:Coverage Tier},{EffectiveDate:Plan Start},{TerminateDate:Terminate Date},' +
  N'{PlanPrice:Plan Base},{UA:Deductible IUA},{TobaccoSurcharge:Tobacco Surcharge},' +
  N'{ABProductID:Product_ID},{ABBenefitIdOverride:Benefit_ID}';

BEGIN TRY
  BEGIN TRANSACTION;

  IF OBJECT_ID('oe.VendorImportFormatPresets', 'U') IS NULL
  BEGIN
    RAISERROR('oe.VendorImportFormatPresets missing.', 16, 1);
  END;

  IF @DryRun = 1
  BEGIN
    PRINT 'DRY RUN — set @DryRun = 0 to apply.';
    SELECT Slug, Label, LEN(RowTemplate) AS TemplateLen
    FROM oe.VendorImportFormatPresets
    WHERE VendorId = @SharewellVendorId AND Slug = N'sharewell_align_sha';
    SELECT N'WOULD UPDATE sharewell_align_sha' AS Action, LEN(@FullTemplate) AS NewLen;
    ROLLBACK TRANSACTION;
    RETURN;
  END;

  MERGE oe.VendorImportFormatPresets AS t
  USING (
    SELECT @SharewellVendorId AS VendorId, N'sharewell_align_sha' AS Slug,
      N'Align Health SHA (ShareWELL full eligibility)' AS Label, @FullTemplate AS RowTemplate, 25 AS SortOrder
  ) AS s
  ON t.VendorId = s.VendorId AND t.Slug = s.Slug
  WHEN MATCHED THEN
    UPDATE SET Label = s.Label, RowTemplate = s.RowTemplate, SortOrder = s.SortOrder, IsActive = 1, ModifiedUtc = SYSUTCDATETIME()
  WHEN NOT MATCHED THEN
    INSERT (VendorId, Slug, Label, RowTemplate, SortOrder, IsActive)
    VALUES (s.VendorId, s.Slug, s.Label, s.RowTemplate, s.SortOrder, 1);

  COMMIT TRANSACTION;
  PRINT 'sharewell_align_sha preset updated for full eligibility template.';
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  DECLARE @ErrMsg NVARCHAR(4000) = ERROR_MESSAGE();
  RAISERROR(@ErrMsg, 16, 1);
END CATCH;
