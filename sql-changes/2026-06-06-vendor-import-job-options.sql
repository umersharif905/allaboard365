/*
  Per-job SFTP import safety options.

  AllowTenantMove — when 0 (default), never call moveHouseholdToTenant during import.
  SkipHouseholdWithUnmappedPlans — when 1 (default), skip entire household if any product row has no pricing map.

  Run with @DryRun = 0 after review.
*/

SET NOCOUNT ON;

DECLARE @DryRun BIT = 1;

IF @DryRun = 1
BEGIN
  SELECT 'WOULD ADD' AS Action, c.name AS ColumnName, t.name AS TypeName
  FROM (VALUES
    ('AllowTenantMove', 'bit'),
    ('SkipHouseholdWithUnmappedPlans', 'bit')
  ) AS cols(ColumnName, TypeName)
  CROSS APPLY (SELECT cols.ColumnName AS name) c
  CROSS APPLY (SELECT cols.TypeName AS name) t
  WHERE OBJECT_ID('oe.VendorImportJobs', 'U') IS NOT NULL
    AND COL_LENGTH('oe.VendorImportJobs', c.name) IS NULL;
END
ELSE
BEGIN
  IF OBJECT_ID('oe.VendorImportJobs', 'U') IS NULL
    RAISERROR('oe.VendorImportJobs does not exist', 16, 1);

  IF COL_LENGTH('oe.VendorImportJobs', 'AllowTenantMove') IS NULL
  BEGIN
    ALTER TABLE oe.VendorImportJobs
      ADD AllowTenantMove BIT NOT NULL
        CONSTRAINT DF_VendorImportJobs_AllowTenantMove DEFAULT 0;
    PRINT 'Added AllowTenantMove (default 0)';
  END

  IF COL_LENGTH('oe.VendorImportJobs', 'SkipHouseholdWithUnmappedPlans') IS NULL
  BEGIN
    ALTER TABLE oe.VendorImportJobs
      ADD SkipHouseholdWithUnmappedPlans BIT NOT NULL
        CONSTRAINT DF_VendorImportJobs_SkipUnmapped DEFAULT 1;
    PRINT 'Added SkipHouseholdWithUnmappedPlans (default 1)';
  END
END
