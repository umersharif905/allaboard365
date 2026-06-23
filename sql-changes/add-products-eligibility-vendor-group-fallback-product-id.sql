-- Optional per-product pointer: resolve eligibility Group Number using another same-vendor product's
-- vendor group ID chain before falling back to this product's Master (see vendorExportService.js).

IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'Products' AND COLUMN_NAME = 'EligibilityVendorGroupFallbackProductId'
)
BEGIN
    ALTER TABLE oe.Products ADD EligibilityVendorGroupFallbackProductId UNIQUEIDENTIFIER NULL;
END
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_Products_EligibilityVendorGroupFallbackProductId'
)
BEGIN
    ALTER TABLE oe.Products
    ADD CONSTRAINT FK_Products_EligibilityVendorGroupFallbackProductId
    FOREIGN KEY (EligibilityVendorGroupFallbackProductId) REFERENCES oe.Products (ProductId);
END
GO
