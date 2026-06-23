-- Default eligibility format preset slug per vendor (ShareWELL import/export)
-- DryRun = 1: preview only. Set @DryRun = 0 to apply.

DECLARE @DryRun BIT = 1;

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('oe.Vendors') AND name = 'DefaultEligibilityFormatSlug'
)
BEGIN
  IF @DryRun = 0
  BEGIN
    ALTER TABLE oe.Vendors ADD DefaultEligibilityFormatSlug NVARCHAR(50) NULL;
    PRINT 'Added oe.Vendors.DefaultEligibilityFormatSlug';
  END
  ELSE
    SELECT 'DRY RUN: would add oe.Vendors.DefaultEligibilityFormatSlug' AS Preview;
END
ELSE
  PRINT 'oe.Vendors.DefaultEligibilityFormatSlug already exists';
