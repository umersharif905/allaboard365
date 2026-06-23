-- Add NewGroupFormConfig to oe.Vendors for vendor-specific new group form field configuration (JSON).
-- When NULL or empty, vendor is treated as "no form configured" for Generate New Group Form.
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'Vendors' AND COLUMN_NAME = 'NewGroupFormConfig')
BEGIN
    ALTER TABLE oe.Vendors ADD NewGroupFormConfig NVARCHAR(MAX) NULL;
    PRINT 'NewGroupFormConfig column added to oe.Vendors';
END
GO
