-- Migration: Add SourceProductId to oe.Products for duplicate lineage tracking
-- Date: 2026-06-05
-- Author: Jeremy Francis

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DryRun BIT = 1;  -- SET TO 0 ONLY WITH EXPLICIT APPROVAL
DECLARE @ColExists BIT = CASE WHEN COL_LENGTH('oe.Products', 'SourceProductId') IS NOT NULL THEN 1 ELSE 0 END;

BEGIN TRY
    BEGIN TRANSACTION;

    IF @DryRun = 1
    BEGIN
        SELECT 'DRY RUN - Preview of changes:' AS [Status];

        IF @ColExists = 0
        BEGIN
            SELECT 'Column oe.Products.SourceProductId does not exist yet — will be added' AS [Action];
        END
        ELSE
        BEGIN
            SELECT 'Column oe.Products.SourceProductId already exists' AS [Action];

            -- Dynamic SQL: column reference is invalid at compile time if added in same batch
            EXEC sp_executesql N'
                SELECT TOP 20
                    p.ProductId,
                    p.Name,
                    p.SourceProductId,
                    src.Name AS SourceProductName
                FROM oe.Products p
                LEFT JOIN oe.Products src ON src.ProductId = p.SourceProductId
                WHERE p.SourceProductId IS NOT NULL
                ORDER BY p.CreatedDate DESC;
            ';
        END;

        ROLLBACK TRANSACTION;
        RETURN;
    END

    IF @ColExists = 0
    BEGIN
        ALTER TABLE oe.Products
        ADD SourceProductId UNIQUEIDENTIFIER NULL;

        ALTER TABLE oe.Products
        ADD CONSTRAINT FK_Products_SourceProductId
            FOREIGN KEY (SourceProductId) REFERENCES oe.Products (ProductId);
    END

    COMMIT TRANSACTION;
    SELECT 'Changes applied successfully' AS [Status];
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    SELECT ERROR_MESSAGE() AS [Error], ERROR_LINE() AS [Line];
END CATCH;
