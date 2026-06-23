-- Add VendorGroupIdProductType to oe.Products for vendor group ID generation (Master/CoPay/HSA).
-- When set, used instead of name-based heuristics for group ID offset (0/1/2).
IF NOT EXISTS (
    SELECT 1
    FROM sys.columns
    WHERE object_id = OBJECT_ID('oe.Products')
    AND name = 'VendorGroupIdProductType'
)
BEGIN
    ALTER TABLE oe.Products
    ADD VendorGroupIdProductType NVARCHAR(50) NULL;
    PRINT 'VendorGroupIdProductType column added to oe.Products';
END
ELSE
BEGIN
    PRINT 'VendorGroupIdProductType column already exists on oe.Products';
END
GO
