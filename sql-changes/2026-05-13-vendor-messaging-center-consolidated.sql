-- ============================================================================
-- 2026-05-13-vendor-messaging-center-consolidated.sql
--
-- Consolidated production migration for the Vendor Message Center feature.
-- Replaces the three iterative testing migrations:
--   2026-05-11-vendor-messaging-scope.sql
--   2026-05-12-no-global-templates.sql
--   2026-05-13-messagetemplates-tenant-vendor-xor.sql
--
-- Apply this single file to any environment (testing, staging, production)
-- that has NOT yet had the iterative migrations applied. It is fully
-- idempotent: re-running on an environment that already matches the final
-- state is a no-op.
--
-- Final state after running:
--   oe.MessageTemplates:
--     - TenantId UNIQUEIDENTIFIER NULL
--     - VendorId UNIQUEIDENTIFIER NULL (NEW column)
--     - CK_MessageTemplates_TenantOrVendor: exactly one of TenantId/VendorId
--       must be NOT NULL (XOR rule — tenant template OR vendor template,
--       never both, never neither)
--     - IX_MessageTemplates_TenantId_VendorId index
--   oe.Campaigns:
--     - TenantId UNIQUEIDENTIFIER NULL (was NOT NULL; same XOR rule applies)
--     - VendorId UNIQUEIDENTIFIER NULL (NEW column)
--     - CK_Campaigns_TenantOrVendor: same XOR rule as MessageTemplates
--     - IX_Campaigns_TenantId_VendorId_IsActive index
--   oe.ShareRequestEmails:
--     - TemplateId column dropped (was unused — table was empty in testing)
--   oe.VendorEmailTemplates: dropped (was an unused legacy table)
--
-- IMPORTANT — backfill before adding the XOR constraint:
-- Any existing oe.MessageTemplates row with TenantId IS NULL AND VendorId IS NULL
-- (i.e., a legacy "global" template) violates the new XOR rule. This script
-- assigns such rows to MightyWELL Health (looked up by Name). If MightyWELL
-- Health doesn't exist in the target environment, the backfill step will
-- abort with a clear message — fix the lookup before re-running.
-- ============================================================================

SET XACT_ABORT ON;
BEGIN TRANSACTION;

-- ----------------------------------------------------------------------------
-- 1. Add VendorId column to oe.MessageTemplates
-- ----------------------------------------------------------------------------
IF NOT EXISTS (
  SELECT 1 FROM sys.columns
   WHERE object_id = OBJECT_ID('oe.MessageTemplates') AND name = 'VendorId'
)
BEGIN
  ALTER TABLE oe.MessageTemplates ADD VendorId UNIQUEIDENTIFIER NULL;
  PRINT 'Added VendorId to oe.MessageTemplates';
END

-- ----------------------------------------------------------------------------
-- 2. Add VendorId column to oe.Campaigns
-- ----------------------------------------------------------------------------
IF NOT EXISTS (
  SELECT 1 FROM sys.columns
   WHERE object_id = OBJECT_ID('oe.Campaigns') AND name = 'VendorId'
)
BEGIN
  ALTER TABLE oe.Campaigns ADD VendorId UNIQUEIDENTIFIER NULL;
  PRINT 'Added VendorId to oe.Campaigns';
END

-- ----------------------------------------------------------------------------
-- 3. Drop unused FK + column on oe.ShareRequestEmails.TemplateId
--    (Verified empty during dev. The column referenced the legacy
--     oe.VendorEmailTemplates table that is dropped below.)
-- ----------------------------------------------------------------------------
DECLARE @fkName SYSNAME;
SELECT @fkName = name FROM sys.foreign_keys
  WHERE parent_object_id = OBJECT_ID('oe.ShareRequestEmails')
    AND referenced_object_id = OBJECT_ID('oe.VendorEmailTemplates');
IF @fkName IS NOT NULL
BEGIN
  EXEC('ALTER TABLE oe.ShareRequestEmails DROP CONSTRAINT ' + @fkName);
  PRINT 'Dropped FK from oe.ShareRequestEmails.TemplateId';
END

IF EXISTS (
  SELECT 1 FROM sys.columns
   WHERE object_id = OBJECT_ID('oe.ShareRequestEmails') AND name = 'TemplateId'
)
BEGIN
  ALTER TABLE oe.ShareRequestEmails DROP COLUMN TemplateId;
  PRINT 'Dropped column oe.ShareRequestEmails.TemplateId';
END

-- ----------------------------------------------------------------------------
-- 4. Drop legacy oe.VendorEmailTemplates table
--    (Was used by the old vendor "Email Templates" page. Replaced by the
--     unified Message Center using oe.MessageTemplates with VendorId scope.)
-- ----------------------------------------------------------------------------
IF OBJECT_ID('oe.VendorEmailTemplates', 'U') IS NOT NULL
BEGIN
  DROP TABLE oe.VendorEmailTemplates;
  PRINT 'Dropped table oe.VendorEmailTemplates';
END

-- ----------------------------------------------------------------------------
-- 5. Backfill: assign any legacy "global" templates to MightyWELL Health
--    A row with TenantId IS NULL AND VendorId IS NULL would violate the XOR
--    constraint added in step 7. Convert them to tenant templates owned by
--    MightyWELL.
-- ----------------------------------------------------------------------------
DECLARE @MightyWellTenantId UNIQUEIDENTIFIER;
SELECT @MightyWellTenantId = TenantId FROM oe.Tenants WHERE Name = N'MightyWELL Health';

IF EXISTS (SELECT 1 FROM oe.MessageTemplates WHERE TenantId IS NULL AND VendorId IS NULL)
BEGIN
  IF @MightyWellTenantId IS NULL
  BEGIN
    RAISERROR(
      'Backfill aborted: legacy NULL-tenant templates exist but tenant "MightyWELL Health" not found. Fix the tenant lookup name and re-run.',
      16, 1
    );
  END

  DECLARE @backfilled INT;
  UPDATE oe.MessageTemplates
     SET TenantId = @MightyWellTenantId,
         ModifiedDate = SYSUTCDATETIME()
   WHERE TenantId IS NULL AND VendorId IS NULL;
  SET @backfilled = @@ROWCOUNT;
  PRINT CONCAT('Backfilled ', @backfilled, ' legacy NULL-tenant template row(s) to MightyWELL Health.');
END

-- ----------------------------------------------------------------------------
-- 6. Indexes on (TenantId, VendorId)
-- ----------------------------------------------------------------------------
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
   WHERE object_id = OBJECT_ID('oe.MessageTemplates') AND name = 'IX_MessageTemplates_TenantId_VendorId'
)
BEGIN
  CREATE INDEX IX_MessageTemplates_TenantId_VendorId
    ON oe.MessageTemplates (TenantId, VendorId);
  PRINT 'Created IX_MessageTemplates_TenantId_VendorId';
END

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
   WHERE object_id = OBJECT_ID('oe.Campaigns') AND name = 'IX_Campaigns_TenantId_VendorId_IsActive'
)
BEGIN
  CREATE INDEX IX_Campaigns_TenantId_VendorId_IsActive
    ON oe.Campaigns (TenantId, VendorId, IsActive);
  PRINT 'Created IX_Campaigns_TenantId_VendorId_IsActive';
END

-- ----------------------------------------------------------------------------
-- 7. XOR check constraint on oe.MessageTemplates
--    Exactly one of (TenantId, VendorId) must be non-null. A row is either
--    a tenant template or a vendor template; never both, never neither.
-- ----------------------------------------------------------------------------
IF NOT EXISTS (
  SELECT 1 FROM sys.check_constraints
   WHERE parent_object_id = OBJECT_ID('oe.MessageTemplates')
     AND name = 'CK_MessageTemplates_TenantOrVendor'
)
BEGIN
  ALTER TABLE oe.MessageTemplates
    ADD CONSTRAINT CK_MessageTemplates_TenantOrVendor
    CHECK (
      (TenantId IS NOT NULL AND VendorId IS NULL)
      OR
      (TenantId IS NULL AND VendorId IS NOT NULL)
    );
  PRINT 'Added CK_MessageTemplates_TenantOrVendor (XOR constraint).';
END

-- ----------------------------------------------------------------------------
-- 8. Make oe.Campaigns.TenantId nullable + null-out existing vendor campaigns
--    + add the same XOR rule. Vendor campaigns hold TenantId IS NULL; the
--    trigger engine joins through oe.Users to find which tenants the vendor
--    serves at fire time.
--
--    The index IX_Campaigns_TenantId_VendorId_IsActive references TenantId,
--    so we must drop+recreate it around the ALTER COLUMN.
-- ----------------------------------------------------------------------------
IF EXISTS (
  SELECT 1 FROM sys.columns
   WHERE object_id = OBJECT_ID('oe.Campaigns') AND name = 'TenantId' AND is_nullable = 0
)
BEGIN
  IF EXISTS (
    SELECT 1 FROM sys.indexes
     WHERE object_id = OBJECT_ID('oe.Campaigns') AND name = 'IX_Campaigns_TenantId_VendorId_IsActive'
  )
  BEGIN
    DROP INDEX IX_Campaigns_TenantId_VendorId_IsActive ON oe.Campaigns;
    PRINT 'Temporarily dropped IX_Campaigns_TenantId_VendorId_IsActive for ALTER COLUMN.';
  END

  ALTER TABLE oe.Campaigns ALTER COLUMN TenantId UNIQUEIDENTIFIER NULL;
  PRINT 'oe.Campaigns.TenantId is now nullable.';
END

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
   WHERE object_id = OBJECT_ID('oe.Campaigns') AND name = 'IX_Campaigns_TenantId_VendorId_IsActive'
)
BEGIN
  CREATE INDEX IX_Campaigns_TenantId_VendorId_IsActive
    ON oe.Campaigns (TenantId, VendorId, IsActive);
  PRINT 'Recreated IX_Campaigns_TenantId_VendorId_IsActive.';
END

-- Null out existing vendor campaigns' TenantId (they carry both before this
-- migration; XOR requires TenantId IS NULL for vendor-owned rows).
IF EXISTS (SELECT 1 FROM oe.Campaigns WHERE VendorId IS NOT NULL AND TenantId IS NOT NULL)
BEGIN
  DECLARE @nulledCampaigns INT;
  UPDATE oe.Campaigns
     SET TenantId = NULL,
         ModifiedDate = SYSUTCDATETIME()
   WHERE VendorId IS NOT NULL AND TenantId IS NOT NULL;
  SET @nulledCampaigns = @@ROWCOUNT;
  PRINT CONCAT('Nulled TenantId on ', @nulledCampaigns, ' existing vendor campaign row(s).');
END

IF NOT EXISTS (
  SELECT 1 FROM sys.check_constraints
   WHERE parent_object_id = OBJECT_ID('oe.Campaigns')
     AND name = 'CK_Campaigns_TenantOrVendor'
)
BEGIN
  ALTER TABLE oe.Campaigns
    ADD CONSTRAINT CK_Campaigns_TenantOrVendor
    CHECK (
      (TenantId IS NOT NULL AND VendorId IS NULL)
      OR
      (TenantId IS NULL AND VendorId IS NOT NULL)
    );
  PRINT 'Added CK_Campaigns_TenantOrVendor (XOR constraint).';
END

COMMIT TRANSACTION;
PRINT 'Vendor Message Center consolidated migration complete.';
