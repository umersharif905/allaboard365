-- Add PayablesRowTemplate to oe.Vendors (custom CSV row template for vendor payables export).
IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'Vendors' AND COLUMN_NAME = 'PayablesRowTemplate'
)
BEGIN
    ALTER TABLE oe.Vendors ADD PayablesRowTemplate NVARCHAR(MAX) NULL;
    PRINT 'Added oe.Vendors.PayablesRowTemplate';
END
ELSE
BEGIN
    PRINT 'oe.Vendors.PayablesRowTemplate already exists';
END
