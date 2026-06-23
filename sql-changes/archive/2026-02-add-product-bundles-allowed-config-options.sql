-- Add AllowedConfigOptions to oe.ProductBundles
-- Restricts which configuration values (e.g. Unshared amount 1500/3000/6000) are available
-- when a product is offered inside this bundle. Does not change the standalone product.
-- JSON shape: { "Unshared amount": ["1500", "3000"], "Other field": ["A", "B"] }

IF OBJECT_ID('oe.ProductBundles', 'U') IS NOT NULL
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM sys.columns
        WHERE object_id = OBJECT_ID('oe.ProductBundles') AND name = 'AllowedConfigOptions'
    )
    BEGIN
        ALTER TABLE oe.ProductBundles
        ADD AllowedConfigOptions NVARCHAR(MAX) NULL;
        PRINT 'Added AllowedConfigOptions to oe.ProductBundles';
    END
    ELSE
        PRINT 'AllowedConfigOptions already exists on oe.ProductBundles';
END
ELSE
    PRINT 'oe.ProductBundles table not found';
