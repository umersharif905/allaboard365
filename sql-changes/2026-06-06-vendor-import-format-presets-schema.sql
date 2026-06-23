/*
  Vendor-scoped eligibility import format presets (ShareWELL SFTP / member import).

  Replaces hardcoded SHAREWELL_FORMAT_PRESETS in eligibilityRowTemplate.js.
  Only ShareWELL vendor is seeded; other vendors get an empty list until presets are added.

  Run dry-run (default):
    cd OpenEnroll && DB_NAME=allaboard-prod ./ai_scripts/db-execute.sh sql-changes/2026-06-06-vendor-import-format-presets-schema.sql
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DryRun BIT = 1;  -- SET TO 0 ONLY WITH EXPLICIT APPROVAL

DECLARE @SharewellVendorId UNIQUEIDENTIFIER = 'D2A84803-5A9B-4E97-98A5-BEE1A11BBDA6';

BEGIN TRY
  BEGIN TRANSACTION;

  IF @DryRun = 1
  BEGIN
    PRINT 'DRY RUN — no changes written. Set @DryRun = 0 to apply.';

    SELECT 'WOULD CREATE' AS Action, 'oe.VendorImportFormatPresets' AS ObjectName;

    SELECT VendorId, VendorName
    FROM oe.Vendors
    WHERE VendorId = @SharewellVendorId;

    IF OBJECT_ID('oe.VendorImportFormatPresets', 'U') IS NOT NULL
      SELECT 'Existing presets (ShareWELL)' AS Section, Slug, Label, SortOrder, LEN(RowTemplate) AS TemplateLen
      FROM oe.VendorImportFormatPresets
      WHERE VendorId = @SharewellVendorId
      ORDER BY SortOrder;
    ELSE
      SELECT 'Existing presets (ShareWELL)' AS Section, '(table not created yet)' AS Slug;

    ROLLBACK TRANSACTION;
    RETURN;
  END;

  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'VendorImportFormatPresets'
  )
  BEGIN
    CREATE TABLE oe.VendorImportFormatPresets (
      PresetId    UNIQUEIDENTIFIER NOT NULL
                    CONSTRAINT PK_VendorImportFormatPresets PRIMARY KEY DEFAULT NEWID(),
      VendorId    UNIQUEIDENTIFIER NOT NULL,
      Slug        NVARCHAR(50)     NOT NULL,
      Label       NVARCHAR(200)    NOT NULL,
      RowTemplate NVARCHAR(MAX)    NOT NULL,
      SortOrder   INT              NOT NULL
                    CONSTRAINT DF_VendorImportFormatPresets_SortOrder DEFAULT 0,
      IsActive    BIT              NOT NULL
                    CONSTRAINT DF_VendorImportFormatPresets_IsActive DEFAULT 1,
      CreatedUtc  DATETIME2        NOT NULL
                    CONSTRAINT DF_VendorImportFormatPresets_CreatedUtc DEFAULT SYSUTCDATETIME(),
      ModifiedUtc DATETIME2        NOT NULL
                    CONSTRAINT DF_VendorImportFormatPresets_ModifiedUtc DEFAULT SYSUTCDATETIME(),
      CONSTRAINT UQ_VendorImportFormatPresets_Vendor_Slug UNIQUE (VendorId, Slug)
    );

    CREATE INDEX IX_VendorImportFormatPresets_VendorId
      ON oe.VendorImportFormatPresets (VendorId, SortOrder)
      WHERE IsActive = 1;

    PRINT 'Created oe.VendorImportFormatPresets';
  END
  ELSE
    PRINT 'SKIP: oe.VendorImportFormatPresets already exists';

  IF NOT EXISTS (SELECT 1 FROM oe.Vendors WHERE VendorId = @SharewellVendorId)
  BEGIN
    DECLARE @SharewellVendorIdStr NVARCHAR(36) = CONVERT(NVARCHAR(36), @SharewellVendorId);
    RAISERROR('ShareWELL vendor %s not found - aborting seed.', 16, 1, @SharewellVendorIdStr);
  END;

  MERGE oe.VendorImportFormatPresets AS t
  USING (
    SELECT *
    FROM (VALUES
      (N'sharewell_default', N'ShareWELL Standard (24-col)', 10,
        N'{IntegrationPartner:Integration Partner},{BillType:Bill Type},{Relationship:Relationship},{FirstName:First Name},{LastName:Last Name},{MiddleInitial:Middle Name},{Phone1:Phone1},{Phone2:Phone2},{Email:Email},{Address1:Address1},{Address2:Address2},{City:City},{State:State},{ZipCode:Zip},{DOB:DoB},{Gender:Gender},{PlanName:Plan Name},{PlanTier:Plan Tier},{EffectiveDate:Effective Date},{TerminateDate:Terminate Date},{PlanPrice:Plan Price},{UA:UA},{TobaccoSurcharge:Tobacco Surcharge},{MemberIDBase:Member ID}'),
      (N'sharewell_calstar', N'Calstar (native SFTP)', 20,
        N'{PrimarySSN:Primary SSN},{CalStarInsuredType:Insured Type},{LastName:Last Name},{FirstName:First Name},{MiddleInitial:MI},{DOB:Date Of Birth},{Gender:Sex},{Phone1:Phone Number},{Email:Email Address},{AddressLine1:Address},{AddressLine2:Address2},{City:City},{State:State},{ZipCode:Zip Code},{EffectiveDate:Benefit Start Date},{TerminateDate:Benefit Term Date},{UA:Plan Selected.1},{CalStarCoverageCode:Coverage.1},{TobaccoSurcharge:Nicotine use in last 36 months}'),
      (N'sharewell_align_sha', N'Align Health SHA (ShareWELL 24-col)', 25,
        N'{IntegrationPartner:Integration Partner},{BillType:Bill Type},{Relationship:Relationship},{FirstName:First Name},{LastName:Last Name},{MiddleInitial:Middle Name},{Phone1:Phone1},{Phone2:Phone2},{Email:Email},{Address1:Address1},{Address2:Address2},{City:City},{State:State},{ZipCode:Zip},{DOB:DoB},{Gender:Gender},{PlanName:Plan Name},{PlanTier:Plan Tier},{EffectiveDate:Effective Date},{TerminateDate:Terminate Date},{PlanPrice:Plan Price},{UA:UA},{TobaccoSurcharge:Tobacco Surcharge},{MemberIDBase:Member ID}'),
      (N'sharewell_align', N'Align Health (native + SHA plan codes)', 30,
        N'{MemberIDBase:Member ID},{Relationship:Relationship},{FirstName:First Name},{MiddleInitial:Middle Name},{LastName:Last Name},{DOB:Date of Birth},{Gender:Gender},{Phone1:Primary Phone},{Phone2:Alternate Phone},{Email:Email Address},{AddressLine1:Mail Address 1},{AddressLine2:Mail Address 2},{City:Mail City},{State:Mail State},{ZipCode:Mail Zip},{EffectiveDate:Plan Start},{TerminateDate:Terminate Date},{PlanTier:Coverage Tier},{UA:Deductible IUA},{PlanPrice:Plan Base},{TobaccoSurcharge:Tobacco Surcharge},{ABProductID:Product_ID},{ABBenefitIdOverride:Benefit_ID},{PlanName:Plan Name},{PlanTier:Plan Tier}'),
      (N'sharewell_mpb', N'MPowering Benefits (native SFTP)', 40,
        N'{AlternateID:Member_ID},{Relationship:Relationship},{FirstName:First_Name},{LastName:Last_Name},{DOB:DOB},{Gender:Gender},{Phone1:Personal_Phone},{Email:Email},{AddressLine1:Mailing_Street_1},{AddressLine2:Mailing_Street_2},{City:Mailing_City},{State:Mailing_State},{ZipCode:Mailing_Zip},{EffectiveDate:Start_Date},{TerminateDate:Cancellation_Date},{PlanName:Plan_Tier},{UA:UA},{TobaccoSurcharge:Tobacco_Surcharge}')
    ) AS s(Slug, Label, SortOrder, RowTemplate)
  ) AS s
  ON t.VendorId = @SharewellVendorId AND t.Slug = s.Slug
  WHEN MATCHED THEN
    UPDATE SET
      Label = s.Label,
      RowTemplate = s.RowTemplate,
      SortOrder = s.SortOrder,
      IsActive = 1,
      ModifiedUtc = SYSUTCDATETIME()
  WHEN NOT MATCHED THEN
    INSERT (VendorId, Slug, Label, RowTemplate, SortOrder)
    VALUES (@SharewellVendorId, s.Slug, s.Label, s.RowTemplate, s.SortOrder);

  PRINT 'Seeded ShareWELL import format presets';

  SELECT Slug, Label, SortOrder, LEN(RowTemplate) AS TemplateLen
  FROM oe.VendorImportFormatPresets
  WHERE VendorId = @SharewellVendorId
  ORDER BY SortOrder;

  COMMIT TRANSACTION;
  PRINT 'Migration committed successfully.';

END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  DECLARE @ErrMsg NVARCHAR(4000) = ERROR_MESSAGE();
  RAISERROR(@ErrMsg, 16, 1);
END CATCH;
