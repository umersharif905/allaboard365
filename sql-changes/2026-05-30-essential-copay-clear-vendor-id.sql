/*
  Remove incorrect VendorId from Essential Copay bundle.
  Bundles are tenant products — they must not appear on a vendor's product list.

  Target: Essential Copay (7736E902-1AAE-421C-9266-94A5FB57F930)
          currently linked to BCS Insurance Company (FB578D19-03B5-4EF5-B5E4-F27DEFCEB836)

  Run dry-run (default):
    ./ai_scripts/db-execute.sh sql-changes/2026-05-30-essential-copay-clear-vendor-id.sql

  Apply: set @DryRun = 0 with explicit approval.
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DryRun BIT = 1;

DECLARE @ProductId UNIQUEIDENTIFIER = '7736E902-1AAE-421C-9266-94A5FB57F930';
DECLARE @ExpectedName NVARCHAR(200) = N'Essential Copay';
DECLARE @BcsVendorId UNIQUEIDENTIFIER = 'FB578D19-03B5-4EF5-B5E4-F27DEFCEB836';

BEGIN TRY
  IF NOT EXISTS (
    SELECT 1
    FROM oe.Products
    WHERE ProductId = @ProductId
      AND Name = @ExpectedName
      AND IsBundle = 1
      AND VendorId = @BcsVendorId
      AND Status <> N'Deleted'
  )
  BEGIN
    RAISERROR(N'Abort: Essential Copay bundle not found with expected BCS VendorId — verify ProductId before updating.', 16, 1);
    RETURN;
  END

  SELECT N'PREVIEW: before' AS Section,
    p.ProductId,
    p.Name,
    p.IsBundle,
    p.VendorId,
    v.VendorName
  FROM oe.Products p
  LEFT JOIN oe.Vendors v ON v.VendorId = p.VendorId
  WHERE p.ProductId = @ProductId;

  SELECT N'PREVIEW: other BCS vendor products (unchanged)' AS Section,
    p.ProductId,
    p.Name,
    p.IsBundle
  FROM oe.Products p
  WHERE p.VendorId = @BcsVendorId
    AND p.ProductId <> @ProductId
    AND p.Status <> N'Deleted'
  ORDER BY p.Name;

  IF @DryRun = 1
  BEGIN
    SELECT N'DRY RUN — VendorId would be set to NULL for Essential Copay only.' AS Status;
    RETURN;
  END

  BEGIN TRAN;

  UPDATE oe.Products
  SET VendorId = NULL,
      ModifiedDate = SYSUTCDATETIME()
  WHERE ProductId = @ProductId
    AND Name = @ExpectedName
    AND IsBundle = 1
    AND VendorId = @BcsVendorId;

  COMMIT TRAN;

  SELECT N'Applied' AS Status,
    p.ProductId,
    p.Name,
    p.IsBundle,
    p.VendorId
  FROM oe.Products p
  WHERE p.ProductId = @ProductId;

END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRAN;
  SELECT ERROR_MESSAGE() AS Error, ERROR_LINE() AS Line;
END CATCH;
