-- Products: premium reporting bucket for billing (non-profit vs for-profit).
-- Safe to re-run on oe.

IF COL_LENGTH('oe.Products', 'PremiumReportingCategory') IS NULL
BEGIN
    ALTER TABLE oe.Products
    ADD PremiumReportingCategory NVARCHAR(20) NOT NULL
        CONSTRAINT DF_Products_PremiumReportingCategory DEFAULT ('ForProfit');
    -- Values: 'NonProfit' | 'ForProfit'
END
GO

-- Existing rows inherit default; explicit backfill if column was added without constraint on old rows:
UPDATE oe.Products
SET PremiumReportingCategory = 'ForProfit'
WHERE PremiumReportingCategory IS NULL OR PremiumReportingCategory = '';
GO
