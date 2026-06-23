-- 2026-04-24-vendor-minimum-employees-per-group.sql
IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE Name = 'MinimumEmployeesPerGroup'
    AND Object_ID = Object_ID('oe.Vendors')
)
BEGIN
  ALTER TABLE oe.Vendors
    ADD MinimumEmployeesPerGroup INT NULL;
END
GO
