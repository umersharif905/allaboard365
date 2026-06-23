-- Add per-product "individual" vendor group ID (used in eligibility export when member has no group).
-- One value per product; no master/offset — just the group ID for individual enrollments for this product.
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'Products' AND COLUMN_NAME = 'EligibilityIndividualVendorGroupId')
BEGIN
    ALTER TABLE oe.Products ADD EligibilityIndividualVendorGroupId NVARCHAR(50) NULL;
END
