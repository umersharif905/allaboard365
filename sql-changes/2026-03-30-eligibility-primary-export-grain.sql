-- Eligibility export: how many rows to emit for primary members (P).
-- NULL or 'PerProduct' = one row per primary per product (legacy default).
-- 'SinglePrimaryRow' = at most one row per primary (best enrollment wins via existing pickBetter).

IF NOT EXISTS (
    SELECT 1
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'Vendors' AND COLUMN_NAME = 'EligibilityPrimaryExportGrain'
)
BEGIN
    ALTER TABLE oe.Vendors ADD EligibilityPrimaryExportGrain NVARCHAR(32) NULL;
    PRINT 'Added oe.Vendors.EligibilityPrimaryExportGrain';
END
ELSE
    PRINT 'oe.Vendors.EligibilityPrimaryExportGrain already exists';
