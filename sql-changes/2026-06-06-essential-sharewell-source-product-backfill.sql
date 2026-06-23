-- Migration: Backfill SourceProductId for Essential ShareWELL derivative products
-- Date: 2026-06-06
-- Author: Jeremy Francis
--
-- Sets SourceProductId → Essential (ShareWELL) for:
--   • Essential (Sharewell) - 2025
--   • Essential ShareWELL Memership
--   • Essential Wellness *  (any name starting with "Essential Wellness")
--
-- Prerequisite: run 2026-06-05-products-source-product-id.sql first (@DryRun = 0).
--
-- Dry-run:
--   cd OpenEnroll && DB_NAME=allaboard-prod ./ai_scripts/db-execute.sh sql-changes/2026-06-06-essential-sharewell-source-product-backfill.sql

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DryRun BIT = 1;  -- SET TO 0 ONLY WITH EXPLICIT APPROVAL
DECLARE @ColExists BIT = CASE WHEN COL_LENGTH('oe.Products', 'SourceProductId') IS NOT NULL THEN 1 ELSE 0 END;

DECLARE @SharewellVendorId UNIQUEIDENTIFIER = 'D2A84803-5A9B-4E97-98A5-BEE1A11BBDA6';
DECLARE @SourceProductId UNIQUEIDENTIFIER = 'F165AF93-8268-448D-9DD6-F02FB338EEAE'; -- Essential (ShareWELL)

BEGIN TRY
    BEGIN TRANSACTION;

    IF @ColExists = 0
    BEGIN
        SELECT 'SourceProductId column missing — run 2026-06-05-products-source-product-id.sql first (@DryRun = 0).' AS [Status];
        ROLLBACK TRANSACTION;
        RETURN;
    END;

    IF NOT EXISTS (
        SELECT 1
        FROM oe.Products
        WHERE ProductId = @SourceProductId
          AND VendorId = @SharewellVendorId
          AND LTRIM(RTRIM(Name)) = N'Essential (ShareWELL)'
          AND Status NOT IN (N'Deleted')
    )
    BEGIN
        RAISERROR('Source product Essential (ShareWELL) not found — verify @SourceProductId / vendor.', 16, 1);
        RETURN;
    END;

    IF @DryRun = 1
    BEGIN
        SELECT 'DRY RUN - Essential ShareWELL SourceProductId backfill preview' AS [Status];

        SELECT
            src.ProductId AS SourceProductId,
            src.Name AS SourceProductName
        FROM oe.Products src
        WHERE src.ProductId = @SourceProductId;

        -- Dynamic SQL: SourceProductId not valid at compile time until column exists
        EXEC sp_executesql N'
            SELECT
                p.ProductId,
                p.Name,
                p.Status,
                p.SourceProductId AS CurrentSourceProductId,
                src.Name AS CurrentSourceProductName,
                CASE
                    WHEN p.ProductId = @SourceProductId THEN N''skip — is source product''
                    WHEN p.SourceProductId = @SourceProductId THEN N''skip — already linked''
                    WHEN p.SourceProductId IS NOT NULL THEN N''skip — already has different SourceProductId''
                    ELSE N''will update''
                END AS BackfillAction
            FROM oe.Products p
            LEFT JOIN oe.Products src ON src.ProductId = p.SourceProductId
            WHERE p.VendorId = @SharewellVendorId
              AND p.Status NOT IN (N''Deleted'')
              AND (
                  LTRIM(RTRIM(p.Name)) IN (
                      N''Essential (Sharewell) - 2025'',
                      N''Essential ShareWELL Memership''
                  )
                  OR LTRIM(RTRIM(p.Name)) LIKE N''Essential Wellness%''
              )
            ORDER BY p.Name;

            SELECT
                COUNT(*) AS TotalMatchedProducts,
                SUM(CASE
                    WHEN p.ProductId <> @SourceProductId
                     AND p.SourceProductId IS NULL
                    THEN 1 ELSE 0 END) AS WillUpdateCount,
                SUM(CASE
                    WHEN p.ProductId = @SourceProductId
                     OR p.SourceProductId IS NOT NULL
                    THEN 1 ELSE 0 END) AS SkippedCount
            FROM oe.Products p
            WHERE p.VendorId = @SharewellVendorId
              AND p.Status NOT IN (N''Deleted'')
              AND (
                  LTRIM(RTRIM(p.Name)) IN (
                      N''Essential (Sharewell) - 2025'',
                      N''Essential ShareWELL Memership''
                  )
                  OR LTRIM(RTRIM(p.Name)) LIKE N''Essential Wellness%''
              );
        ',
        N'@SharewellVendorId UNIQUEIDENTIFIER, @SourceProductId UNIQUEIDENTIFIER',
        @SharewellVendorId = @SharewellVendorId,
        @SourceProductId = @SourceProductId;

        ROLLBACK TRANSACTION;
        RETURN;
    END;

    EXEC sp_executesql N'
        UPDATE p
        SET
            p.SourceProductId = @SourceProductId,
            p.ModifiedDate = GETUTCDATE()
        FROM oe.Products p
        WHERE p.VendorId = @SharewellVendorId
          AND p.Status NOT IN (N''Deleted'')
          AND p.ProductId <> @SourceProductId
          AND p.SourceProductId IS NULL
          AND (
              LTRIM(RTRIM(p.Name)) IN (
                  N''Essential (Sharewell) - 2025'',
                  N''Essential ShareWELL Memership''
              )
              OR LTRIM(RTRIM(p.Name)) LIKE N''Essential Wellness%''
          );

        SELECT @@ROWCOUNT AS RowsUpdated;

        SELECT
            p.ProductId,
            p.Name,
            p.SourceProductId,
            src.Name AS SourceProductName
        FROM oe.Products p
        INNER JOIN oe.Products src ON src.ProductId = p.SourceProductId
        WHERE p.VendorId = @SharewellVendorId
          AND p.Status NOT IN (N''Deleted'')
          AND (
              LTRIM(RTRIM(p.Name)) IN (
                  N''Essential (Sharewell) - 2025'',
                  N''Essential ShareWELL Memership''
              )
              OR LTRIM(RTRIM(p.Name)) LIKE N''Essential Wellness%''
          )
        ORDER BY p.Name;
    ',
    N'@SharewellVendorId UNIQUEIDENTIFIER, @SourceProductId UNIQUEIDENTIFIER',
    @SharewellVendorId = @SharewellVendorId,
    @SourceProductId = @SourceProductId;

    COMMIT TRANSACTION;
    SELECT 'Essential ShareWELL SourceProductId backfill applied successfully' AS [Status];
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    SELECT ERROR_MESSAGE() AS [Error], ERROR_LINE() AS [Line];
END CATCH;
